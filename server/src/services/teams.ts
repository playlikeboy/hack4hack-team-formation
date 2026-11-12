// Team membership: the race-critical core of the project.
//
// ONE mechanism, used identically by join-by-code and accept-request:
// a transaction that locks the team row (SELECT ... FOR UPDATE) and then
// counts current members INSIDE the transaction. The lock serialises all
// joins to the same team, so the count cannot be stale and the 409 for a
// full team is decided on true data. Different teams lock different rows,
// so contention is per-team, never global.
//
// Backstop: the unique index on team_members(hackathon_id, user_id) makes
// a second team for the same person impossible even if application logic
// slipped — the database refuses the insert (23505), and we turn that
// into the same honest 409.

import type { Pool, PoolClient } from 'pg'
import { pool } from '../db/pool'
import { conflict, isUniqueViolation, notFound } from '../lib/errors'
import { generateInviteCode } from '../lib/invite'
import {
  auditEntryOut,
  joinRequestOut,
  teamMemberOut,
  teamOut,
  type AuditEntryOut,
  type JoinRequestOut,
  type TeamMemberOut,
  type TeamOut,
} from '../lib/serialize'

export interface TeamDetail {
  team: TeamOut
  members: TeamMemberOut[]
  joinRequests: JoinRequestOut[]
  auditLog: AuditEntryOut[]
}

export async function getTeamRow(
  client: Pool | PoolClient,
  teamId: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await client.query('SELECT * FROM teams WHERE id = $1', [teamId])
  return rows.length > 0 ? rows[0] : null
}

// Hackathons are effectively static: no API endpoint creates, updates, or
// deletes them (the single row is seeded at deploy), so the row is cached
// for 60s. That removes a database round trip from the hottest paths —
// every board request validates the hackathon id, and at 100 concurrent
// users the pool queue was measurable tail latency. The TTL bounds
// staleness if a row is ever changed out-of-band; a miss (null) is cached
// too, so a bogus id costs one query per minute, not one per request.
const hackathonCache = new Map<
  string,
  { row: Record<string, unknown> | null; at: number }
>()
const HACKATHON_CACHE_TTL_MS = 60_000

export async function getHackathonRow(
  client: Pool | PoolClient,
  hackathonId: string,
): Promise<Record<string, unknown> | null> {
  const cached = hackathonCache.get(hackathonId)
  if (cached && Date.now() - cached.at < HACKATHON_CACHE_TTL_MS) return cached.row
  const { rows } = await client.query('SELECT * FROM hackathons WHERE id = $1', [
    hackathonId,
  ])
  const row = rows.length > 0 ? rows[0] : null
  hackathonCache.set(hackathonId, { row, at: Date.now() })
  return row
}

/** The team (if any) a user already belongs to for a hackathon. */
export async function findUserTeam(
  client: Pool | PoolClient,
  hackathonId: string,
  userId: string,
): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT team_id FROM team_members WHERE hackathon_id = $1 AND user_id = $2`,
    [hackathonId, userId],
  )
  return rows.length > 0 ? String(rows[0].team_id) : null
}

export async function countMembers(client: PoolClient, teamId: string): Promise<number> {
  const { rows } = await client.query(
    'SELECT COUNT(*)::int AS count FROM team_members WHERE team_id = $1',
    [teamId],
  )
  return Number(rows[0].count)
}

/**
 * Run a callback with a fresh invite code, retrying on the (vanishingly
 * rare) collision. A failed INSERT aborts the whole Postgres transaction,
 * so each attempt runs behind a savepoint that is rolled back on
 * collision — the outer transaction survives to try the next code.
 */
export async function withUniqueInviteCode<T>(
  client: PoolClient,
  run: (code: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await client.query('SAVEPOINT invite_code_attempt')
    try {
      const result = await run(generateInviteCode())
      await client.query('RELEASE SAVEPOINT invite_code_attempt')
      return result
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT invite_code_attempt')
      if (!isUniqueViolation(err, 'teams_invite_code_key')) throw err
    }
  }
  throw new Error('Could not generate a unique invite code.')
}

/**
 * Add a user to a team inside the caller's transaction. THE race-critical
 * path — the caller must already be inside a transaction (join-by-code and
 * accept-request both are). Locks the team row first, so concurrent joins
 * to the same team queue behind each other instead of racing on the count.
 *
 * Throws 409 when the team is full or the user is already on a team for
 * this hackathon, 404 when the team does not exist.
 */
export async function addMember(
  client: PoolClient,
  opts: { teamId: string; userId: string; hackathonId: string; maxSize: number },
): Promise<void> {
  const { teamId, userId, hackathonId, maxSize } = opts

  // The lock: every join to THIS team waits here in turn. Reads of the
  // team row elsewhere (board, team page) are unaffected — FOR UPDATE
  // blocks only other writers.
  const { rows: locked } = await client.query(
    'SELECT id FROM teams WHERE id = $1 FOR UPDATE',
    [teamId],
  )
  if (locked.length === 0) throw notFound('Team not found.')

  const count = await countMembers(client, teamId)
  if (count >= maxSize) {
    throw conflict('team_full', `This team is full (${count}/${maxSize} members).`)
  }

  const existing = await findUserTeam(client, hackathonId, userId)
  if (existing) {
    throw conflict(
      'already_in_team',
      'You are already in a team for this hackathon. Leave it first to join another.',
    )
  }

  try {
    await client.query(
      `INSERT INTO team_members (team_id, user_id, hackathon_id)
       VALUES ($1, $2, $3)`,
      [teamId, userId, hackathonId],
    )
  } catch (err) {
    // The backstop: two transactions adding the same user to two different
    // teams can both pass the check above (neither sees the other's
    // uncommitted insert). The unique index refuses the second insert.
    if (isUniqueViolation(err, 'team_members_hackathon_id_user_id_key')) {
      throw conflict(
        'already_in_team',
        'You are already in a team for this hackathon. Leave it first to join another.',
      )
    }
    throw err
  }
}

/**
 * Full team detail for GET /api/teams/:id. Visibility rules (the client
 * renders on these, the server enforces them):
 *   - invite code: members only.
 *   - join requests: the leader only.
 *   - audit log (last 50): members only.
 * Everyone else sees the team and its members — the team page is public.
 */
export async function getTeamDetail(
  teamId: string,
  viewerId: string | null,
): Promise<TeamDetail> {
  const teamRow = await getTeamRow(pool, teamId)
  if (!teamRow) throw notFound('Team not found.')

  const { rows: memberRows } = await pool.query(
    `SELECT u.id, u.name, u.skills, u.timezone, u.bio, m.joined_at
     FROM team_members m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = $1
     ORDER BY m.joined_at ASC`,
    [teamId],
  )
  const members = memberRows.map(teamMemberOut)
  const isMember = viewerId !== null && members.some((m) => m.id === viewerId)
  const isLeader = viewerId !== null && String(teamRow.leader_id) === viewerId

  let joinRequests: JoinRequestOut[] = []
  if (isLeader) {
    const { rows } = await pool.query(
      `SELECT r.id, r.team_id, r.user_id, u.name AS user_name,
              u.skills AS user_skills, r.status, r.message,
              r.created_at, r.decided_at
       FROM join_requests r JOIN users u ON u.id = r.user_id
       WHERE r.team_id = $1
       ORDER BY r.created_at ASC`,
      [teamId],
    )
    joinRequests = rows.map(joinRequestOut)
  }

  let auditLog: AuditEntryOut[] = []
  if (isMember) {
    auditLog = await getAuditEntries(teamId, 50)
  }

  return {
    team: teamOut(teamRow, isMember),
    members,
    joinRequests,
    auditLog,
  }
}

/** Audit entries for a team, newest first. The route checks membership. */
export async function getAuditEntries(
  teamId: string,
  limit = 100,
): Promise<AuditEntryOut[]> {
  const { rows } = await pool.query(
    `SELECT a.id, a.team_id, a.actor_id, u.name AS actor_name,
            a.action, a.details, a.created_at
     FROM audit_log a JOIN users u ON u.id = a.actor_id
     WHERE a.team_id = $1
     ORDER BY a.created_at DESC
     LIMIT $2`,
    [teamId, limit],
  )
  return rows.map(auditEntryOut)
}

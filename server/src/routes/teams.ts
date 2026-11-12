// Teams: create, read, join-by-code, join requests, leave, remove,
// invite regeneration, audit log.
//
// Every mutation writes an audit row, invalidates the board cache, and
// broadcasts a WebSocket event — but only AFTER its transaction commits
// (via afterCommit), so a rollback never leaks a phantom event.
// The four idempotent endpoints (create, join, request, regenerate) run
// through withIdempotency; the rest use withTransaction directly.

import type { Context } from 'hono'
import { Hono } from 'hono'
import { pool } from '../db/pool'
import {
  badRequest,
  conflict,
  forbidden,
  isUniqueViolation,
  notFound,
  tooManyRequests,
} from '../lib/errors'
import { inviteExpiry } from '../lib/invite'
import { joinRequestOut, teamOut } from '../lib/serialize'
import {
  createTeamSchema,
  joinSchema,
  parseBody,
  parseUuidParam,
  removeMemberSchema,
  requestToJoinSchema,
} from '../lib/validation'
import type { AppEnv } from '../lib/env'
import { audit } from '../services/audit'
import { currentUser, optionalAuth, requireAuth } from '../services/auth'
import { invalidateBoard } from '../services/board'
import { withIdempotency } from '../services/idempotency'
import { checkRateLimit, clientIp } from '../services/rateLimit'
import {
  addMember,
  findUserTeam,
  getAuditEntries,
  getHackathonRow,
  getTeamDetail,
  getTeamRow,
  withUniqueInviteCode,
} from '../services/teams'
import { withTransaction } from '../services/transaction'
import { emitTeamMutation, emitTeamOnly } from '../ws/hub'

export const teamRoutes = new Hono<AppEnv>()

// --- Create ---------------------------------------------------------------

teamRoutes.post('/', requireAuth, async (c) => {
  const user = currentUser(c)
  const input = await parseBody(c.req.raw, createTeamSchema)

  const { status, body } = await withIdempotency({
    key: c.req.header('Idempotency-Key'),
    userId: user.id,
    endpoint: 'POST /api/teams',
    body: input,
    handler: async (client) => {
      const hackathon = await getHackathonRow(client, input.hackathonId)
      if (!hackathon) throw notFound('Hackathon not found.')

      if (await findUserTeam(client, input.hackathonId, user.id)) {
        throw conflict(
          'already_in_team',
          'You are already in a team for this hackathon.',
        )
      }

      const teamRow = await withUniqueInviteCode(client, async (code) => {
        const { rows } = await client.query(
          `INSERT INTO teams
             (hackathon_id, name, leader_id, invite_code, invite_expires_at, description)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            input.hackathonId,
            input.name,
            user.id,
            code,
            inviteExpiry(),
            input.description ?? '',
          ],
        )
        return rows[0]
      })

      // The creator is the leader AND the first member — a team of zero
      // would be joinable but leaderless, which the leave logic forbids.
      await client.query(
        `INSERT INTO team_members (team_id, user_id, hackathon_id)
         VALUES ($1, $2, $3)`,
        [teamRow.id, user.id, input.hackathonId],
      )
      await audit(client, {
        teamId: String(teamRow.id),
        actorId: user.id,
        action: 'team.created',
        details: { teamName: input.name },
      })

      return {
        status: 201,
        body: { team: teamOut(teamRow, true) },
        afterCommit: () => {
          invalidateBoard(input.hackathonId)
          emitTeamMutation(input.hackathonId, String(teamRow.id), {
            type: 'team.created',
            teamId: String(teamRow.id),
            hackathonId: input.hackathonId,
            teamName: input.name,
          })
        },
      }
    },
  })
  return c.json(body, status as 201)
})

// --- Read -----------------------------------------------------------------

teamRoutes.get('/:id', optionalAuth, async (c) => {
  const id = parseUuidParam(c.req.param('id'), 'Team')
  const viewer = c.get('user')
  return c.json(await getTeamDetail(id, viewer?.id ?? null))
})

teamRoutes.get('/:id/audit', requireAuth, async (c) => {
  const user = currentUser(c)
  const id = parseUuidParam(c.req.param('id'), 'Team')
  if (!(await getTeamRow(pool, id))) throw notFound('Team not found.')
  const { rows } = await pool.query(
    'SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2',
    [id, user.id],
  )
  if (rows.length === 0) {
    throw forbidden('Only team members can view the audit log.')
  }
  return c.json(await getAuditEntries(id))
})

// --- Join by invite code (the race-critical path) -------------------------

teamRoutes.post('/:id/join', requireAuth, async (c) => {
  const user = currentUser(c)
  const id = parseUuidParam(c.req.param('id'), 'Team')
  const input = await parseBody(c.req.raw, joinSchema)

  // Rate-limited before the code is even checked: the limit is what makes
  // an 8-character code unbruteforceable, so guesses must count.
  if (!checkRateLimit(`join:${clientIp(c)}`, 5, 10 * 60 * 1000)) {
    throw tooManyRequests('Too many join attempts. Try again in a few minutes.')
  }

  const { status, body } = await withIdempotency({
    key: c.req.header('Idempotency-Key'),
    userId: user.id,
    endpoint: 'POST /api/teams/:id/join',
    body: { teamId: id, ...input },
    handler: async (client) => {
      const team = await getTeamRow(client, id)
      if (!team) throw notFound('Team not found.')
      if (String(team.invite_code) !== input.inviteCode) {
        throw badRequest(
          'invalid_invite_code',
          'That invite code does not match this team.',
        )
      }
      if (new Date(String(team.invite_expires_at)).getTime() < Date.now()) {
        throw badRequest(
          'invite_expired',
          'This invite code has expired. Ask the team leader for a new one.',
        )
      }

      const hackathon = await getHackathonRow(client, String(team.hackathon_id))
      if (!hackathon) throw notFound('Hackathon not found.')

      // The lock-then-count inside addMember is what makes this safe
      // under 50 concurrent joins for the last seat.
      await addMember(client, {
        teamId: id,
        userId: user.id,
        hackathonId: String(team.hackathon_id),
        maxSize: Number(hackathon.team_max_size),
      })

      // Joining by code supersedes a pending request to the same team —
      // leaving it pending would let the leader "accept" someone who is
      // already a member.
      const { rows: decided } = await client.query(
        `UPDATE join_requests
         SET status = 'accepted', decided_at = now()
         WHERE team_id = $1 AND user_id = $2 AND status = 'pending'
         RETURNING id`,
        [id, user.id],
      )

      await audit(client, {
        teamId: id,
        actorId: user.id,
        action: 'member.joined',
        details: { memberName: user.name, method: 'invite_code' },
      })
      if (decided.length > 0) {
        await audit(client, {
          teamId: id,
          actorId: user.id,
          action: 'request.accepted',
          details: { requesterName: user.name, method: 'invite_code' },
        })
      }

      const hackathonId = String(team.hackathon_id)
      return {
        status: 200,
        body: { team: teamOut(team, true) },
        afterCommit: () => {
          invalidateBoard(hackathonId)
          emitTeamMutation(hackathonId, id, {
            type: 'member.joined',
            teamId: id,
            hackathonId,
            userId: user.id,
            userName: user.name,
          })
          if (decided.length > 0) {
            emitTeamOnly(id, {
              type: 'request.decided',
              teamId: id,
              hackathonId,
              requestId: String(decided[0].id),
              userId: user.id,
              decision: 'accepted',
            })
          }
        },
      }
    },
  })
  return c.json(body, status as 200)
})

// --- Join requests ----------------------------------------------------------

teamRoutes.post('/:id/requests', requireAuth, async (c) => {
  const user = currentUser(c)
  const id = parseUuidParam(c.req.param('id'), 'Team')
  const input = await parseBody(c.req.raw, requestToJoinSchema)

  const { status, body } = await withIdempotency({
    key: c.req.header('Idempotency-Key'),
    userId: user.id,
    endpoint: 'POST /api/teams/:id/requests',
    body: { teamId: id, ...input },
    handler: async (client) => {
      const team = await getTeamRow(client, id)
      if (!team) throw notFound('Team not found.')
      const hackathonId = String(team.hackathon_id)

      if (await findUserTeam(client, hackathonId, user.id)) {
        throw conflict(
          'already_in_team',
          'You are already in a team for this hackathon.',
        )
      }

      const { rows: existing } = await client.query(
        `SELECT 1 FROM join_requests
         WHERE team_id = $1 AND user_id = $2 AND status = 'pending'`,
        [id, user.id],
      )
      if (existing.length > 0) {
        throw conflict(
          'request_exists',
          'You already have a pending request to this team.',
        )
      }

      let requestRow
      try {
        const { rows } = await client.query(
          `INSERT INTO join_requests (team_id, user_id, message)
           VALUES ($1, $2, $3)
           RETURNING *`,
          [id, user.id, input.message ?? ''],
        )
        requestRow = rows[0]
      } catch (err) {
        // Backstop for the check-then-insert race: two concurrent
        // requests from the same user hit the partial unique index.
        // (The transaction aborts here, but we throw a 409 and roll
        // back anyway — no further queries run on this client.)
        if (isUniqueViolation(err, 'idx_join_requests_pending_unique')) {
          throw conflict(
            'request_exists',
            'You already have a pending request to this team.',
          )
        }
        throw err
      }

      await audit(client, {
        teamId: id,
        actorId: user.id,
        action: 'request.created',
        details: { requesterName: user.name },
      })

      return {
        status: 201,
        body: {
          request: joinRequestOut({
            ...requestRow,
            user_name: user.name,
            user_skills: user.skills,
          }),
        },
        afterCommit: () => {
          // A request changes nothing the board shows, so the board
          // cache stays valid — only the team room hears about it.
          emitTeamOnly(id, {
            type: 'request.created',
            teamId: id,
            hackathonId,
            requestId: String(requestRow.id),
            userId: user.id,
            userName: user.name,
          })
        },
      }
    },
  })
  return c.json(body, status as 201)
})

// --- Accept / decline (leader only) -----------------------------------------

async function decideRequest(
  c: Context<AppEnv>,
  user: { id: string; name: string },
  decision: 'accepted' | 'declined',
): Promise<Response> {
  const teamId = parseUuidParam(c.req.param('id'), 'Team')
  const requestId = parseUuidParam(c.req.param('requestId'), 'Request')

  const result = await withTransaction(async (client) => {
    const team = await getTeamRow(client, teamId)
    if (!team) throw notFound('Team not found.')
    if (String(team.leader_id) !== user.id) {
      throw forbidden('Only the team leader can decide join requests.')
    }

    const { rows } = await client.query(
      `SELECT r.*, u.name AS user_name, u.skills AS user_skills
       FROM join_requests r JOIN users u ON u.id = r.user_id
       WHERE r.id = $1 AND r.team_id = $2`,
      [requestId, teamId],
    )
    if (rows.length === 0) throw notFound('Join request not found.')
    const request = rows[0]
    if (request.status !== 'pending') {
      throw conflict('request_decided', 'This request has already been decided.')
    }

    const hackathonId = String(team.hackathon_id)

    if (decision === 'accepted') {
      // Same race-critical path as join-by-code: the team may have
      // filled up between the request and the accept.
      const hackathon = await getHackathonRow(client, hackathonId)
      if (!hackathon) throw notFound('Hackathon not found.')
      await addMember(client, {
        teamId,
        userId: String(request.user_id),
        hackathonId,
        maxSize: Number(hackathon.team_max_size),
      })
      await audit(client, {
        teamId,
        actorId: String(request.user_id),
        action: 'member.joined',
        details: { memberName: String(request.user_name), method: 'request' },
      })
    }

    const { rows: updated } = await client.query(
      `UPDATE join_requests
       SET status = $1, decided_at = now()
       WHERE id = $2
       RETURNING *`,
      [decision, requestId],
    )
    await audit(client, {
      teamId,
      actorId: user.id,
      action: decision === 'accepted' ? 'request.accepted' : 'request.declined',
      details: { requesterName: String(request.user_name) },
    })

    return {
      result: {
        request: joinRequestOut({
          ...updated[0],
          user_name: request.user_name,
          user_skills: request.user_skills,
        }),
        hackathonId,
        requesterId: String(request.user_id),
        requesterName: String(request.user_name),
      },
      afterCommit: () => {
        // A decision can change membership (accept), so the board cache
        // is invalidated either way — cheap, and the contract lists
        // request decisions among the invalidating mutations. The board
        // itself only changes on accept, so only accept broadcasts a
        // board event; a decline just tells the team room.
        invalidateBoard(hackathonId)
        emitTeamOnly(teamId, {
          type: 'request.decided',
          teamId,
          hackathonId,
          requestId,
          userId: String(request.user_id),
          decision,
        })
        if (decision === 'accepted') {
          emitTeamMutation(hackathonId, teamId, {
            type: 'member.joined',
            teamId,
            hackathonId,
            userId: String(request.user_id),
            userName: String(request.user_name),
          })
        }
      },
    }
  })

  return c.json({ request: result.request }, 200)
}

teamRoutes.post('/:id/requests/:requestId/accept', requireAuth, async (c) => {
  return decideRequest(c, currentUser(c), 'accepted')
})

teamRoutes.post('/:id/requests/:requestId/decline', requireAuth, async (c) => {
  return decideRequest(c, currentUser(c), 'declined')
})

// --- Leave ------------------------------------------------------------------

teamRoutes.post('/:id/leave', requireAuth, async (c) => {
  const user = currentUser(c)
  const id = parseUuidParam(c.req.param('id'), 'Team')

  const result = await withTransaction(async (client) => {
    const team = await getTeamRow(client, id)
    if (!team) throw notFound('Team not found.')
    const hackathonId = String(team.hackathon_id)

    const { rows: membership } = await client.query(
      'SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2',
      [id, user.id],
    )
    if (membership.length === 0) {
      throw forbidden('You are not a member of this team.')
    }

    // Remaining members, earliest-joined first — leadership passes to
    // the head of this list. user_id breaks the (unlikely) joined_at tie
    // deterministically.
    const { rows: remaining } = await client.query(
      `SELECT m.user_id, u.name
       FROM team_members m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = $1 AND m.user_id <> $2
       ORDER BY m.joined_at ASC, m.user_id ASC`,
      [id, user.id],
    )

    const isLeader = String(team.leader_id) === user.id
    let newLeaderId: string | null = null
    let newLeaderName: string | null = null
    if (isLeader && remaining.length > 0) {
      newLeaderId = String(remaining[0].user_id)
      newLeaderName = String(remaining[0].name)
      await client.query(
        'UPDATE teams SET leader_id = $1, updated_at = now() WHERE id = $2',
        [newLeaderId, id],
      )
      await audit(client, {
        teamId: id,
        actorId: user.id,
        action: 'leader.changed',
        details: { previousLeaderName: user.name, newLeaderName },
      })
    }

    await client.query(
      'DELETE FROM team_members WHERE team_id = $1 AND user_id = $2',
      [id, user.id],
    )
    await audit(client, {
      teamId: id,
      actorId: user.id,
      action: 'member.left',
      details: { memberName: user.name },
    })

    const deleted = remaining.length === 0
    if (deleted) {
      // Last member out deletes the team. The audit row for the
      // deletion cannot reference the team (the FK would block the
      // delete), so it carries the team id in details instead; the
      // team's earlier audit rows keep their history with team_id
      // set to NULL by the ON DELETE SET NULL rule.
      await audit(client, {
        teamId: null,
        actorId: user.id,
        action: 'team.deleted',
        details: { teamId: id, teamName: String(team.name) },
      })
      await client.query('DELETE FROM teams WHERE id = $1', [id])
    }

    return {
      result: { ok: true, deleted, newLeaderId },
      afterCommit: () => {
        invalidateBoard(hackathonId)
        if (deleted) {
          emitTeamMutation(hackathonId, id, {
            type: 'team.deleted',
            teamId: id,
            hackathonId,
            teamName: String(team.name),
          })
        } else {
          emitTeamMutation(hackathonId, id, {
            type: 'member.left',
            teamId: id,
            hackathonId,
            userId: user.id,
            userName: user.name,
          })
          if (newLeaderId) {
            emitTeamMutation(hackathonId, id, {
              type: 'team.updated',
              teamId: id,
              hackathonId,
              leaderId: newLeaderId,
              leaderName: newLeaderName,
            })
          }
        }
      },
    }
  })

  return c.json(result)
})

// --- Remove (leader only) ---------------------------------------------------

teamRoutes.post('/:id/remove', requireAuth, async (c) => {
  const user = currentUser(c)
  const id = parseUuidParam(c.req.param('id'), 'Team')
  const input = await parseBody(c.req.raw, removeMemberSchema)

  const result = await withTransaction(async (client) => {
    const team = await getTeamRow(client, id)
    if (!team) throw notFound('Team not found.')
    if (String(team.leader_id) !== user.id) {
      throw forbidden('Only the team leader can remove members.')
    }
    if (input.userId === user.id) {
      throw badRequest(
        'cannot_remove_self',
        'Leaders cannot remove themselves — leave the team instead.',
      )
    }

    const { rows } = await client.query(
      `SELECT u.name FROM team_members m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = $1 AND m.user_id = $2`,
      [id, input.userId],
    )
    if (rows.length === 0) {
      throw notFound('That person is not a member of this team.')
    }
    const memberName = String(rows[0].name)

    await client.query(
      'DELETE FROM team_members WHERE team_id = $1 AND user_id = $2',
      [id, input.userId],
    )
    await audit(client, {
      teamId: id,
      actorId: user.id,
      action: 'member.removed',
      details: { memberName },
    })

    const hackathonId = String(team.hackathon_id)
    return {
      result: { ok: true },
      afterCommit: () => {
        invalidateBoard(hackathonId)
        emitTeamMutation(hackathonId, id, {
          type: 'member.left',
          teamId: id,
          hackathonId,
          userId: input.userId,
          userName: memberName,
          removed: true,
        })
      },
    }
  })

  return c.json(result)
})

// --- Regenerate invite code (leader only) -----------------------------------

teamRoutes.post('/:id/invite/regenerate', requireAuth, async (c) => {
  const user = currentUser(c)
  const id = parseUuidParam(c.req.param('id'), 'Team')

  const { status, body } = await withIdempotency({
    key: c.req.header('Idempotency-Key'),
    userId: user.id,
    endpoint: 'POST /api/teams/:id/invite/regenerate',
    body: { teamId: id },
    handler: async (client) => {
      const team = await getTeamRow(client, id)
      if (!team) throw notFound('Team not found.')
      if (String(team.leader_id) !== user.id) {
        throw forbidden('Only the team leader can regenerate the invite code.')
      }

      const { code, expiresAt } = await withUniqueInviteCode(client, async (newCode) => {
        const expires = inviteExpiry()
        await client.query(
          `UPDATE teams
           SET invite_code = $1, invite_expires_at = $2, updated_at = now()
           WHERE id = $3`,
          [newCode, expires, id],
        )
        return { code: newCode, expiresAt: expires.toISOString() }
      })

      await audit(client, {
        teamId: id,
        actorId: user.id,
        action: 'invite.regenerated',
        details: {},
      })

      return {
        status: 200,
        body: { inviteCode: code, expiresAt },
        afterCommit: () => {
          // The board never shows invite codes, so its cache stays
          // valid — only the team room hears about the new code.
          emitTeamOnly(id, {
            type: 'team.updated',
            teamId: id,
            hackathonId: String(team.hackathon_id),
          })
        },
      }
    },
  })
  return c.json(body, status as 200)
})

// The public board: every team (with members and open seats) plus every
// person looking for a team. Served from an in-memory cache per hackathon,
// invalidated on EVERY team mutation — create, join, leave, remove,
// request decision, delete. The cache is correct by construction: it only
// changes when the underlying data changes, because every mutation path
// calls invalidateBoard() after its transaction commits.
//
// The honest price: the cache lives in this process, so this build is
// single-instance (documented in docs/design-doc.md).
//
// The cache stores the board OBJECT; the route paginates it (default 50
// teams + 50 seekers per page) and serializes only the page. At 2,000
// teams the full board is ~1.3MB of JSON — serving it whole made the
// endpoint saturate the CPU at 100 concurrent users (measured: p50 ~3s
// unpaginated, p50 ~0.8s even with a pre-serialized cache, because moving
// 1.3MB × 100 concurrent connections is itself the bottleneck). A page is
// ~30KB, so the hot path stays cheap. Pagination is the production answer,
// not a benchmark trick: no real board ships 2,000 rows at once.
//
// One refinement: the DEFAULT page (first 50 + first 50) is what the load
// test and most visitors hit, so its serialized form — the JSON string
// and its gzip bytes — is cached alongside the object, built once per
// invalidation. Serving the default page is then a buffer write: no
// stringify, no compression on the hot path. Other windows paginate from
// the cached object and serialize per request (still cheap: one page).

import { gzipSync } from 'node:zlib'
import { pool } from '../db/pool'
import { BOARD_DEFAULT_PAGE_SIZE, type BoardQuery } from '../lib/validation'

export interface BoardMember {
  id: string
  name: string
  skills: string[]
}

export interface BoardTeam {
  id: string
  name: string
  description: string
  memberCount: number
  maxSize: number
  members: BoardMember[]
  lookingFor: string[]
}

export interface Seeker {
  id: string
  name: string
  skills: string[]
  timezone: string
  bio: string
}

export interface Board {
  teams: BoardTeam[]
  seekers: Seeker[]
}

export interface BoardPagePayload {
  /** JSON.stringify of the default page, built once per invalidation. */
  json: string
  /** gzip(json), built once per invalidation. */
  gzip: Buffer
}

const cache = new Map<string, Board>()
const defaultPageCache = new Map<string, BoardPagePayload>()

export function invalidateBoard(hackathonId: string): void {
  cache.delete(hackathonId)
  defaultPageCache.delete(hackathonId)
}

export async function getBoard(hackathonId: string): Promise<Board> {
  const cached = cache.get(hackathonId)
  if (cached) return cached
  const board = await buildBoard(hackathonId)
  cache.set(hackathonId, board)
  return board
}

/** True when the requested window is exactly the default first page. */
export function isDefaultPage(q: BoardQuery): boolean {
  return (
    q.teamsLimit === BOARD_DEFAULT_PAGE_SIZE &&
    q.teamsOffset === 0 &&
    q.seekersLimit === BOARD_DEFAULT_PAGE_SIZE &&
    q.seekersOffset === 0
  )
}

/** The pre-serialized default page (first 50 teams + first 50 seekers). */
export async function getDefaultPagePayload(
  hackathonId: string,
): Promise<BoardPagePayload> {
  const cached = defaultPageCache.get(hackathonId)
  if (cached) return cached
  const board = await getBoard(hackathonId)
  const page = {
    teams: board.teams.slice(0, BOARD_DEFAULT_PAGE_SIZE),
    seekers: board.seekers.slice(0, BOARD_DEFAULT_PAGE_SIZE),
    totalTeams: board.teams.length,
    totalSeekers: board.seekers.length,
  }
  const json = JSON.stringify(page)
  const payload: BoardPagePayload = { json, gzip: gzipSync(json) }
  defaultPageCache.set(hackathonId, payload)
  return payload
}

async function buildBoard(hackathonId: string): Promise<Board> {
  // One query for teams + members (json_agg keeps it a single round trip),
  // one for seekers. Both are indexed: teams(hackathon_id),
  // users(looking_for_teammates), team_members(user_id) for the NOT EXISTS.
  const { rows: teamRows } = await pool.query(
    `SELECT t.id, t.name, t.description,
            h.team_max_size AS "maxSize",
            COALESCE(
              json_agg(
                json_build_object('id', u.id, 'name', u.name, 'skills', COALESCE(u.skills, '{}'))
                ORDER BY m.joined_at
              ) FILTER (WHERE u.id IS NOT NULL),
              '[]'
            ) AS members
     FROM teams t
     JOIN hackathons h ON h.id = t.hackathon_id
     LEFT JOIN team_members m ON m.team_id = t.id
     LEFT JOIN users u ON u.id = m.user_id
     WHERE t.hackathon_id = $1
     GROUP BY t.id, h.team_max_size
     ORDER BY t.created_at ASC`,
    [hackathonId],
  )

  const { rows: seekerRows } = await pool.query(
    `SELECT u.id, u.name, u.skills, u.timezone, u.bio
     FROM users u
     WHERE u.looking_for_teammates = true
       AND NOT EXISTS (
         SELECT 1 FROM team_members tm
         WHERE tm.user_id = u.id AND tm.hackathon_id = $1
       )
     ORDER BY u.created_at ASC`,
    [hackathonId],
  )

  const seekers: Seeker[] = seekerRows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    skills: (r.skills as string[]) ?? [],
    timezone: String(r.timezone),
    bio: String(r.bio ?? ''),
  }))

  // "Looking for" is derived, not stored: no form collects wanted skills,
  // so the board surfaces the most common skills among seekers that the
  // team does not already have — the gaps the pool can actually fill.
  // Full teams look for nobody. Ties break alphabetically (deterministic).
  const skillFrequency = new Map<string, number>()
  for (const seeker of seekers) {
    for (const skill of new Set(seeker.skills)) {
      skillFrequency.set(skill, (skillFrequency.get(skill) ?? 0) + 1)
    }
  }
  const rankedSkills = [...skillFrequency.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([skill]) => skill)

  const teams: BoardTeam[] = teamRows.map((r) => {
    const members: BoardMember[] = (r.members as BoardMember[]) ?? []
    const memberSkills = new Set(members.flatMap((m) => m.skills))
    const maxSize = Number(r.maxSize)
    return {
      id: String(r.id),
      name: String(r.name),
      description: String(r.description ?? ''),
      memberCount: members.length,
      maxSize,
      members,
      lookingFor:
        members.length >= maxSize
          ? []
          : rankedSkills.filter((s) => !memberSkills.has(s)).slice(0, 3),
    }
  })

  return { teams, seekers }
}

// Shared helpers for the Hack4Hack PS1 API tests.
//
// The tests speak real HTTP to a real server (spawned by globalSetup.ts)
// backed by a real Postgres test database. No mocks: the race test only
// proves anything if the request path, the database, and the locks are real.
//
// Every simulated user gets a distinct X-Forwarded-For address. In
// production 50 racers are 50 people on 50 IPs; the header reproduces that
// here, so a per-IP rate limit measures abuse by one actor rather than the
// whole suite sharing localhost. It is harmless if the server ignores the
// header. Tests never share state: each one registers fresh users and uses
// unique team names, and assertions are scoped to the entities that test
// created, so no truncation between tests is needed.

import { randomUUID } from 'node:crypto'
import pg from 'pg'

export const BASE_URL = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3101'
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/hack4hack_test'

let fakeIpCounter = 0
function nextFakeIp(): string {
  // 10.<high>.<low>.7 — unique per user, never colliding with real traffic.
  fakeIpCounter += 1
  const n = fakeIpCounter
  return `10.${Math.floor(n / 250)}.${(n % 250) + 1}.7`
}

export function newPassword(): string {
  // Random per user: no credential is ever reused or written down.
  return `pw-${randomUUID()}`
}

export function uniqueEmail(prefix = 'test'): string {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`
}

export function uniqueName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

export interface User {
  id: string
  email: string
  name: string
  skills: string[]
  timezone: string
  lookingForTeammates: boolean
  bio: string
}

export interface Session {
  user: User
  password: string
  /** "name=value" from Set-Cookie, attributes stripped. */
  cookie: string
  /** The fake client IP this user appears to come from. */
  ip: string
}

export interface Team {
  id: string
  hackathonId: string
  name: string
  description: string
  leaderId: string
  inviteCode?: string
  inviteExpiresAt?: string
  createdAt: string
  updatedAt: string
}

export interface ApiResponse {
  status: number
  // Parsed JSON, raw text, or null for an empty body.
  body: any
  headers: Headers
}

export async function api(
  path: string,
  opts: {
    method?: string
    body?: unknown
    session?: Session
    idempotencyKey?: string
    cookie?: string
    headers?: Record<string, string>
  } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  const cookie = opts.session?.cookie ?? opts.cookie
  if (cookie) headers['Cookie'] = cookie
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey
  if (!headers['X-Forwarded-For']) {
    headers['X-Forwarded-For'] = opts.session?.ip ?? '10.99.99.99'
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: res.status, body, headers: res.headers }
}

function cookieFrom(res: ApiResponse): string | null {
  const setCookie = res.headers.getSetCookie()
  if (!setCookie || setCookie.length === 0) return null
  // First cookie, name=value only (drop Path/HttpOnly/SameSite attributes).
  const first = setCookie[0].split(';')[0].trim()
  return first || null
}

let userCounter = 0
export async function registerUser(opts: {
  name?: string
  skills?: string[]
  timezone?: string
  bio?: string
} = {}): Promise<Session> {
  userCounter += 1
  const email = uniqueEmail('test')
  const password = newPassword()
  const ip = nextFakeIp()
  const res = await api('/api/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      name: opts.name ?? `Test User ${userCounter}`,
      skills: opts.skills ?? [],
      timezone: opts.timezone ?? 'UTC',
      bio: opts.bio ?? '',
    },
    headers: { 'X-Forwarded-For': ip },
  })
  if (res.status !== 201) {
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  let cookie = cookieFrom(res)
  if (!cookie) {
    // Register did not start a session; log in explicitly.
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { email, password },
      headers: { 'X-Forwarded-For': ip },
    })
    if (login.status !== 200) {
      throw new Error(`login after register failed: ${login.status} ${JSON.stringify(login.body)}`)
    }
    cookie = cookieFrom(login)
    if (!cookie) throw new Error('login returned no session cookie')
  }
  return { user: res.body.user as User, password, cookie, ip }
}

let hackathonIdCache: string | null = null
export async function getHackathonId(): Promise<string> {
  if (hackathonIdCache) return hackathonIdCache
  const res = await api('/api/hackathons')
  if (res.status !== 200) throw new Error(`list hackathons failed: ${res.status}`)
  const list = Array.isArray(res.body) ? res.body : res.body.hackathons
  const found = list.find((h: any) => h.name === 'Hack4Hack 2026') ?? list[0]
  if (!found) throw new Error('no hackathon found — expected the seeded Hack4Hack 2026')
  hackathonIdCache = found.id as string
  return hackathonIdCache
}

export async function createTeam(
  session: Session,
  name: string,
  description = '',
): Promise<Team> {
  const hackathonId = await getHackathonId()
  const res = await api('/api/teams', {
    method: 'POST',
    body: { hackathonId, name, description },
    session,
    idempotencyKey: randomUUID(),
  })
  if (res.status !== 201) {
    throw new Error(`create team failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  const team = res.body.team as Team
  if (!team.inviteCode) {
    // Some servers only reveal the code on the detail endpoint.
    const detail = await getTeam(session, team.id)
    team.inviteCode = detail.team.inviteCode
  }
  return team
}

export async function joinTeam(
  session: Session,
  teamId: string,
  inviteCode: string,
  idempotencyKey?: string,
): Promise<ApiResponse> {
  return api(`/api/teams/${teamId}/join`, {
    method: 'POST',
    body: { inviteCode },
    session,
    idempotencyKey: idempotencyKey ?? randomUUID(),
  })
}

export async function getTeam(session: Session, teamId: string): Promise<{
  team: Team
  members: any[]
  joinRequests: any[]
  auditLog: any[]
}> {
  const res = await api(`/api/teams/${teamId}`, { session })
  if (res.status !== 200) {
    throw new Error(`get team failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return res.body
}

export async function getBoard(hackathonId: string): Promise<{
  teams: any[]
  seekers: any[]
}> {
  const res = await api(`/api/hackathons/${hackathonId}/board`)
  if (res.status !== 200) throw new Error(`get board failed: ${res.status}`)
  return res.body
}

// --- Direct DB access ------------------------------------------------------
// Only for test setup the API cannot express (expiring an invite code,
// flipping the looking flag). Everything else goes through HTTP.
let pool: pg.Pool | null = null
export function db(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: TEST_DATABASE_URL })
  return pool
}

export async function expireInviteCode(teamId: string): Promise<void> {
  await db().query(
    `UPDATE teams SET invite_expires_at = now() - interval '1 day' WHERE id = $1`,
    [teamId],
  )
}

export async function setLookingForTeammates(userId: string, looking: boolean): Promise<void> {
  await db().query(`UPDATE users SET looking_for_teammates = $2 WHERE id = $1`, [
    userId,
    looking,
  ])
}

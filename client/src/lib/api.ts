// Typed client for the Hack4Hack PS1 API (see ../../contract.md — the API
// contract is the single source of truth; this file mirrors it exactly).
//
// Same-origin in production (the server serves the built client); in dev the
// Vite proxy forwards /api to the backend on :3000. Auth is a session cookie,
// so every request sends credentials. Mutations that the contract marks
// idempotent carry an Idempotency-Key so a double submit or a retried request
// can never create the same thing twice.

export interface User {
  id: string
  email: string
  name: string
  skills: string[]
  timezone: string
  lookingForTeammates: boolean
  bio: string
  createdAt?: string
}

export interface Hackathon {
  id: string
  name: string
  startsAt: string | null
  endsAt: string | null
  teamMinSize: number
  teamMaxSize: number
}

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
  totalTeams: number
  totalSeekers: number
}

export interface BoardParams {
  teamsLimit?: number
  teamsOffset?: number
  seekersLimit?: number
  seekersOffset?: number
}

export interface Team {
  id: string
  hackathonId: string
  name: string
  description: string
  leaderId: string
  // Only sent to members; the invite code is not public.
  inviteCode?: string
  inviteExpiresAt?: string
  createdAt: string
  updatedAt: string
}

export interface TeamMember {
  id: string
  name: string
  email?: string
  skills: string[]
  timezone?: string
  bio?: string
  joinedAt: string
}

export interface JoinRequest {
  id: string
  teamId: string
  userId: string
  userName: string
  userSkills: string[]
  status: 'pending' | 'accepted' | 'declined'
  message: string
  createdAt: string
  decidedAt: string | null
}

export interface AuditEntry {
  id: string
  teamId: string | null
  actorId: string
  actorName?: string
  action: string
  details: Record<string, unknown>
  createdAt: string
}

export interface TeamDetail {
  team: Team
  members: TeamMember[]
  // Only the leader sees join requests.
  joinRequests: JoinRequest[]
  // Last 50 entries, newest first.
  auditLog: AuditEntry[]
}

export interface SuggestionBreakdown {
  skillComplement: number
  timezone: number
  base: number
}

export interface Suggestion {
  user: Seeker
  score: number
  breakdown: SuggestionBreakdown
}

/** An error the API returned on purpose — carry its message to the user verbatim. */
export class ApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

function newIdempotencyKey(): string {
  // One fresh key per user-initiated submit. The server replays the stored
  // response if the same key is ever sent twice, so a double-click or a
  // retried request cannot double-create.
  return crypto.randomUUID()
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  idempotent = false,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (idempotent) headers['Idempotency-Key'] = newIdempotencyKey()

  let res: Response
  try {
    res = await fetch(path, { ...init, headers, credentials: 'include' })
  } catch {
    // Network failure (backend down, offline) — not an API error shape.
    throw new ApiError(0, 'network_error', 'Could not reach the server. Check your connection and try again.')
  }

  if (res.status === 204) return undefined as T

  const body: unknown = await res.json().catch(() => null)

  if (!res.ok) {
    // Contract error shape: {error: {code, message}}.
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(
      res.status,
      err?.code ?? 'unknown_error',
      err?.message ?? `Request failed (${res.status})`,
    )
  }
  return body as T
}

// --- Auth -----------------------------------------------------------------

export interface RegisterInput {
  email: string
  password: string
  name: string
  skills?: string[]
  timezone?: string
  bio?: string
}

export async function register(input: RegisterInput): Promise<{ user: User }> {
  return request('/api/auth/register', { method: 'POST', body: JSON.stringify(input) })
}

export async function login(email: string, password: string): Promise<{ user: User }> {
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export async function logout(): Promise<void> {
  await request('/api/auth/logout', { method: 'POST' })
}

export async function me(): Promise<{ user: User }> {
  return request('/api/auth/me')
}

// --- Hackathons / board ---------------------------------------------------

export async function listHackathons(): Promise<Hackathon[]> {
  const body = await request<Hackathon[] | { hackathons: Hackathon[] }>('/api/hackathons')
  // Accept either a bare list or a wrapped one — the contract says "list".
  return Array.isArray(body) ? body : body.hackathons
}

export async function getBoard(hackathonId: string, params?: BoardParams): Promise<Board> {
  const q = new URLSearchParams()
  if (params?.teamsLimit !== undefined) q.set('teamsLimit', String(params.teamsLimit))
  if (params?.teamsOffset !== undefined) q.set('teamsOffset', String(params.teamsOffset))
  if (params?.seekersLimit !== undefined) q.set('seekersLimit', String(params.seekersLimit))
  if (params?.seekersOffset !== undefined) q.set('seekersOffset', String(params.seekersOffset))
  const qs = q.toString()
  return request(`/api/hackathons/${hackathonId}/board${qs ? `?${qs}` : ''}`)
}

// --- Teams ----------------------------------------------------------------

export async function createTeam(input: {
  hackathonId: string
  name: string
  description?: string
}): Promise<{ team: Team }> {
  return request(
    '/api/teams',
    { method: 'POST', body: JSON.stringify(input) },
    true,
  )
}

export async function getTeam(teamId: string): Promise<TeamDetail> {
  return request(`/api/teams/${teamId}`)
}

export async function joinTeam(teamId: string, inviteCode: string): Promise<{ team: Team }> {
  return request(
    `/api/teams/${teamId}/join`,
    { method: 'POST', body: JSON.stringify({ inviteCode }) },
    true,
  )
}

export async function requestToJoin(teamId: string, message?: string): Promise<{ request: JoinRequest }> {
  return request(
    `/api/teams/${teamId}/requests`,
    { method: 'POST', body: JSON.stringify({ message: message ?? '' }) },
    true,
  )
}

export async function acceptRequest(teamId: string, requestId: string): Promise<void> {
  await request(`/api/teams/${teamId}/requests/${requestId}/accept`, { method: 'POST' })
}

export async function declineRequest(teamId: string, requestId: string): Promise<void> {
  await request(`/api/teams/${teamId}/requests/${requestId}/decline`, { method: 'POST' })
}

export async function leaveTeam(teamId: string): Promise<void> {
  await request(`/api/teams/${teamId}/leave`, { method: 'POST' })
}

export async function removeMember(teamId: string, userId: string): Promise<void> {
  await request(`/api/teams/${teamId}/remove`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  })
}

export async function regenerateInvite(
  teamId: string,
): Promise<{ inviteCode: string; expiresAt: string }> {
  return request(
    `/api/teams/${teamId}/invite/regenerate`,
    { method: 'POST' },
    true,
  )
}

export async function getAudit(teamId: string): Promise<AuditEntry[]> {
  const body = await request<AuditEntry[] | { auditLog: AuditEntry[] }>(`/api/teams/${teamId}/audit`)
  return Array.isArray(body) ? body : body.auditLog
}

// --- Suggestions ----------------------------------------------------------

export async function getSuggestions(): Promise<Suggestion[]> {
  const body = await request<Suggestion[] | { suggestions: Suggestion[] }>('/api/users/me/suggestions')
  return Array.isArray(body) ? body : body.suggestions
}

// Row → API shape. The database speaks snake_case, the client speaks
// camelCase, and this file is the one place the translation happens —
// routes never hand a raw row to the client (which would also risk
// leaking columns like password_hash).

export interface PublicUser {
  id: string
  email: string
  name: string
  skills: string[]
  timezone: string
  lookingForTeammates: boolean
  bio: string
  createdAt: string
}

export interface HackathonOut {
  id: string
  name: string
  startsAt: string | null
  endsAt: string | null
  teamMinSize: number
  teamMaxSize: number
}

export interface TeamOut {
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

export interface TeamMemberOut {
  id: string
  name: string
  skills: string[]
  timezone: string
  bio: string
  joinedAt: string
}

export interface JoinRequestOut {
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

export interface AuditEntryOut {
  id: string
  teamId: string | null
  actorId: string
  actorName: string
  action: string
  details: Record<string, unknown>
  createdAt: string
}

type Row = Record<string, unknown>

const asString = (v: unknown): string => String(v ?? '')
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? (v as unknown[]).map(String) : []
const asIso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : asString(v)
const asIsoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : asIso(v)

export function userPublic(row: Row): PublicUser {
  return {
    id: asString(row.id),
    email: asString(row.email),
    name: asString(row.name),
    skills: asStringArray(row.skills),
    timezone: asString(row.timezone),
    lookingForTeammates: Boolean(row.looking_for_teammates),
    bio: asString(row.bio),
    createdAt: asIso(row.created_at),
  }
}

export function hackathonOut(row: Row): HackathonOut {
  return {
    id: asString(row.id),
    name: asString(row.name),
    startsAt: asIsoOrNull(row.starts_at),
    endsAt: asIsoOrNull(row.ends_at),
    teamMinSize: Number(row.team_min_size),
    teamMaxSize: Number(row.team_max_size),
  }
}

/** Invite codes are only ever sent to members — never on the public board. */
export function teamOut(row: Row, includeInvite: boolean): TeamOut {
  const team: TeamOut = {
    id: asString(row.id),
    hackathonId: asString(row.hackathon_id),
    name: asString(row.name),
    description: asString(row.description),
    leaderId: asString(row.leader_id),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  }
  if (includeInvite) {
    team.inviteCode = asString(row.invite_code)
    team.inviteExpiresAt = asIso(row.invite_expires_at)
  }
  return team
}

export function teamMemberOut(row: Row): TeamMemberOut {
  // Email is deliberately NOT included: team pages are public, and a
  // member's email is not needed to display a team.
  return {
    id: asString(row.id),
    name: asString(row.name),
    skills: asStringArray(row.skills),
    timezone: asString(row.timezone),
    bio: asString(row.bio),
    joinedAt: asIso(row.joined_at),
  }
}

export function joinRequestOut(row: Row): JoinRequestOut {
  return {
    id: asString(row.id),
    teamId: asString(row.team_id),
    userId: asString(row.user_id),
    userName: asString(row.user_name),
    userSkills: asStringArray(row.user_skills),
    status: row.status as 'pending' | 'accepted' | 'declined',
    message: asString(row.message),
    createdAt: asIso(row.created_at),
    decidedAt: asIsoOrNull(row.decided_at),
  }
}

export function auditEntryOut(row: Row): AuditEntryOut {
  return {
    id: asString(row.id),
    teamId: row.team_id === null || row.team_id === undefined ? null : asString(row.team_id),
    actorId: asString(row.actor_id),
    actorName: asString(row.actor_name),
    action: asString(row.action),
    details: (row.details as Record<string, unknown>) ?? {},
    createdAt: asIso(row.created_at),
  }
}

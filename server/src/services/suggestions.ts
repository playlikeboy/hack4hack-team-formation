// Teammate suggestions — the ranking formula, documented here and in
// docs/design-doc.md (the two must match; the design doc is the authority
// and this file implements it exactly).
//
// Candidates: users with looking_for_teammates set, excluding me and
// anyone already in a team for the hackathon (they are not available).
//
//   score = skillComplement + timezone + base            (max 80)
//
//   skillComplement = 10 points per skill they have that I lack,
//                     capped at 50. Complementary skills are what a
//                     team needs — overlap adds nothing.
//   timezone        = max(0, 20 − 2 × |Δhours|), where Δhours is the
//                     UTC-offset difference between our timezones.
//                     Same offset: 20. Ten hours apart: 0.
//   base            = flat 10 — every candidate is looking, so every
//                     candidate gets it. It exists so the breakdown
//                     shows the "looking" factor explicitly.
//
// Ties break by earliest account creation (deterministic — the same
// data always produces the same order). The API returns the breakdown
// with every suggestion, so the ranking is auditable.

import { pool } from '../db/pool'
import { notFound } from '../lib/errors'
import { utcOffsetHours } from '../lib/timezone'

export interface Suggestion {
  user: {
    id: string
    name: string
    skills: string[]
    timezone: string
    bio: string
  }
  score: number
  breakdown: { skillComplement: number; timezone: number; base: number }
}

const MAX_SUGGESTIONS = 20
const SKILL_POINTS = 10
const SKILL_CAP = 50
const TIMEZONE_MAX = 20
const TIMEZONE_PER_HOUR = 2
const BASE_POINTS = 10

export async function getSuggestions(
  userId: string,
  hackathonId?: string,
): Promise<Suggestion[]> {
  const { rows: meRows } = await pool.query(
    'SELECT skills, timezone FROM users WHERE id = $1',
    [userId],
  )
  if (meRows.length === 0) throw notFound('User not found.')
  const mySkills = new Set(
    ((meRows[0].skills as string[]) ?? []).map((s) => s.toLowerCase()),
  )
  const myOffset = utcOffsetHours(String(meRows[0].timezone))

  // Which hackathon? The client calls without one, so default to the
  // earliest-created (the seeded "Hack4Hack 2026" — there is only one).
  // An explicit ?hackathonId= is honoured when given.
  let hackathon: string | null = null
  if (hackathonId) {
    const { rows } = await pool.query('SELECT id FROM hackathons WHERE id = $1', [
      hackathonId,
    ])
    if (rows.length === 0) throw notFound('Hackathon not found.')
    hackathon = hackathonId
  } else {
    const { rows } = await pool.query(
      'SELECT id FROM hackathons ORDER BY created_at ASC LIMIT 1',
    )
    if (rows.length === 0) return []
    hackathon = String(rows[0].id)
  }

  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.skills, u.timezone, u.bio, u.created_at
     FROM users u
     WHERE u.looking_for_teammates = true
       AND u.id <> $1
       AND NOT EXISTS (
         SELECT 1 FROM team_members tm
         WHERE tm.user_id = u.id AND tm.hackathon_id = $2
       )`,
    [userId, hackathon],
  )

  const scored = rows.map((row) => {
    const theirSkills = (row.skills as string[]) ?? []
    const complement = new Set(
      theirSkills.map((s) => s.toLowerCase()).filter((s) => !mySkills.has(s)),
    ).size
    const skillComplement = Math.min(complement * SKILL_POINTS, SKILL_CAP)
    const deltaHours = Math.abs(utcOffsetHours(String(row.timezone)) - myOffset)
    const timezone = Math.max(0, TIMEZONE_MAX - TIMEZONE_PER_HOUR * deltaHours)
    const breakdown = { skillComplement, timezone, base: BASE_POINTS }
    return {
      user: {
        id: String(row.id),
        name: String(row.name),
        skills: theirSkills,
        timezone: String(row.timezone),
        bio: String(row.bio ?? ''),
      },
      score: breakdown.skillComplement + breakdown.timezone + breakdown.base,
      breakdown,
      createdAt: row.created_at as Date,
    }
  })

  scored.sort((a, b) => b.score - a.score || a.createdAt.getTime() - b.createdAt.getTime())

  return scored.slice(0, MAX_SUGGESTIONS).map(({ user, score, breakdown }) => ({
    user,
    score,
    breakdown,
  }))
}

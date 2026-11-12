// Seeds a load-test dataset directly in Postgres (batched, deterministic).
// Mirrors the contract's seed scale: 10,000 users and 2,000 teams by default.
//
// WARNING: this drops the public schema in the target database and rebuilds
// it from server/src/db/schema.sql. Point LOAD_DATABASE_URL at a scratch
// database only — never production.
//
//   LOAD_DATABASE_URL=postgres://postgres@localhost:5432/hack4hack npm run seed
//   LOAD_USERS=1000 LOAD_TEAMS=200 npm run seed   # smaller dataset
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const DATABASE_URL =
  process.env.LOAD_DATABASE_URL ?? 'postgres://postgres@localhost:5432/hack4hack'
const N_USERS = Number(process.env.LOAD_USERS ?? 10_000)
const N_TEAMS = Number(process.env.LOAD_TEAMS ?? 2_000)

// Deterministic PRNG (mulberry32) so reruns produce the same dataset.
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function inviteCode(rng) {
  let s = ''
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)]
  return s
}

const SKILLS = [
  'react',
  'typescript',
  'python',
  'go',
  'rust',
  'node',
  'postgres',
  'design',
  'ml',
  'devops',
]
const TIMEZONES = ['UTC', 'Asia/Kolkata', 'America/New_York', 'Europe/London', 'Asia/Tokyo']

// Insert rows in batches with one parameterised statement per batch.
// `casts` (parallel to `columns`, null for none) pins parameter types
// Postgres cannot deduce on its own in multi-row VALUES — citext in
// particular conflicts with text without an explicit cast.
async function insertBatches(client, table, columns, rows, batchSize = 500, casts = []) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    const params = []
    let nextParam = 1
    const values = batch
      .map((row) => {
        const placeholders = row.map((_, colIdx) => {
          const cast = casts[colIdx] ? `::${casts[colIdx]}` : ''
          return `$${nextParam++}${cast}`
        })
        params.push(...row)
        return `(${placeholders.join(', ')})`
      })
      .join(', ')
    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values}`,
      params,
    )
  }
}

async function main() {
  const started = Date.now()
  const rng = mulberry32(20261112)
  const pool = new pg.Pool({ connectionString: DATABASE_URL })
  const client = await pool.connect()
  try {
    const schemaPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'server',
      'src',
      'db',
      'schema.sql',
    )
    const schemaSql = readFileSync(schemaPath, 'utf8')
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
    await client.query(schemaSql)
    // schema.sql already seeds the one hackathon; just read its id.
    const hack = await client.query(
      `SELECT id FROM hackathons WHERE name = 'Hack4Hack 2026'`,
    )
    const hackathonId = hack.rows[0].id

    // Users: deterministic skills/timezones; password hashes are dummies —
    // load users never log in.
    const userRows = []
    for (let i = 0; i < N_USERS; i++) {
      const nSkills = Math.floor(rng() * 4)
      const skills = [...new Set(Array.from({ length: nSkills }, () => SKILLS[Math.floor(rng() * SKILLS.length)]))]
      userRows.push([
        `load-user-${i}@example.com`,
        'load-test-dummy-hash',
        `Load User ${i}`,
        skills,
        TIMEZONES[Math.floor(rng() * TIMEZONES.length)],
        rng() < 0.8,
        '',
      ])
    }
    await insertBatches(
      client,
      'users',
      ['email', 'password_hash', 'name', 'skills', 'timezone', 'looking_for_teammates', 'bio'],
      userRows,
      500,
      ['citext', null, null, null, null, null, null],
    )
    const userIds = (
      await client.query('SELECT id FROM users ORDER BY email')
    ).rows.map((r) => r.id)

    // Teams: sizes cycle 2, 3, 4; members are consecutive users, so every
    // user lands in at most one team (the unique index stays happy).
    const teamRows = []
    const memberRows = []
    const usedCodes = new Set()
    let userCursor = 0
    for (let t = 0; t < N_TEAMS; t++) {
      const size = 2 + (t % 3)
      const members = userIds.slice(userCursor, userCursor + size)
      if (members.length < 2) break
      userCursor += size
      let code = inviteCode(rng)
      while (usedCodes.has(code)) code = inviteCode(rng)
      usedCodes.add(code)
      teamRows.push([
        hackathonId,
        `Load Team ${t}`,
        members[0],
        code,
        new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        '',
      ])
      // Team ids are needed for memberships; fetch them after insert.
      for (const userId of members) memberRows.push({ teamIndex: t, userId })
    }
    await insertBatches(
      client,
      'teams',
      ['hackathon_id', 'name', 'leader_id', 'invite_code', 'invite_expires_at', 'description'],
      teamRows,
      500,
      ['uuid', null, 'uuid', null, null, null],
    )
    const teamsByCode = new Map(
      (await client.query('SELECT id, invite_code FROM teams')).rows.map((r) => [r.invite_code, r.id]),
    )
    const membershipRows = memberRows.map((m) => [
      teamsByCode.get(teamRows[m.teamIndex][3]),
      m.userId,
      hackathonId,
    ])
    await insertBatches(
      client,
      'team_members',
      ['team_id', 'user_id', 'hackathon_id'],
      membershipRows,
      500,
      ['uuid', 'uuid', 'uuid'],
    )
    console.log(
      `seeded ${N_USERS} users, ${teamRows.length} teams, ${membershipRows.length} memberships ` +
        `in ${((Date.now() - started) / 1000).toFixed(1)}s (${DATABASE_URL.replace(/\/\/.*@/, '//***@')})`,
    )
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

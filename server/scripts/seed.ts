// Seed script: `npm run seed` (10,000 users + 2,000 teams) or
// `npm run seed -- --demo` (10 users, 3 teams, 2 pending requests).
//
// Idempotent by construction: TRUNCATE + reseed. Re-running always
// produces the same data (deterministic seeded RNG for everything
// except ids and the generated password).
//
// Passwords: NO password is hardcoded anywhere in this file. The seed
// password comes from DEMO_PASSWORD (demo) / SEED_PASSWORD (full) or is
// generated randomly and PRINTED — note it if you need to log in as a
// seed user. All seed users share the one password hash: hashing 10,000
// passwords with scrypt would take ~10 minutes for zero benefit, since
// seed accounts are throwaway demo data.
//
// Invite codes for seed teams come from the seeded RNG (deterministic,
// so demo runs are identical). Real teams created through the API get
// crypto-random codes — see src/lib/invite.ts.

import { randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from '../src/db/pool'
import { migrate } from '../src/db/migrate'
import { hashPassword } from '../src/lib/crypto'

const DEMO = process.argv.includes('--demo')

// --- Deterministic RNG (mulberry32) ---------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function seededInviteCode(rng: () => number): string {
  let code = ''
  for (let i = 0; i < 8; i++) {
    code += INVITE_ALPHABET[Math.floor(rng() * INVITE_ALPHABET.length)]
  }
  return code
}

// --- Data pools -------------------------------------------------------------

const FIRST_NAMES = [
  'Aarav', 'Ananya', 'Vikram', 'Sneha', 'Arjun', 'Kavya', 'Dev', 'Ishita',
  'Priya', 'Rohan', 'Aditya', 'Meera', 'Nikhil', 'Divya', 'Karan', 'Pooja',
  'Rahul', 'Naina', 'Sanjay', 'Tara', 'Imran', 'Zoya', 'Farhan', 'Lina',
  'Omar', 'Hana', 'Yuki', 'Kenji', 'Sofia', 'Lucas', 'Maya', 'Ethan',
  'Nora', 'Liam', 'Aisha', 'Owen', 'Freya', 'Hugo', 'Ines', 'Marco',
  'Elena', 'Diego', 'Clara', 'Felix', 'Amara', 'Jonas', 'Leila', 'Ravi',
]

const LAST_NAMES = [
  'Mehta', 'Iyer', 'Nair', 'Patel', 'Desai', 'Reddy', 'Malhotra', 'Rao',
  'Sharma', 'Gupta', 'Khan', 'Singh', 'Kumar', 'Verma', 'Joshi', 'Agarwal',
  'Chopra', 'Bhatt', 'Menon', 'Pillai', 'Das', 'Ghosh', 'Banerjee', 'Kapoor',
  'Tanaka', 'Sato', 'Kim', 'Park', 'Garcia', 'Lopez', 'Muller', 'Schmidt',
  'Novak', 'Kowalski', 'Dubois', 'Martin', 'Rossi', 'Silva', 'Costa', 'Ali',
  'Hassan', 'Ahmed', 'Nguyen', 'Tran', 'Wilson', 'Brown', 'Taylor', 'Lee',
]

const SKILLS = [
  'Python', 'React', 'TypeScript', 'Node.js', 'Postgres', 'ML', 'Rust', 'Go',
  'Figma', 'C++', 'Java', 'Kubernetes', 'CSS', 'Data', 'PyTorch', 'Systems',
  'Embedded', 'UI Design', 'DevOps', 'SQL', 'Next.js', 'GraphQL', 'Docker',
  'TensorFlow',
]

const TIMEZONES = [
  'Asia/Kolkata', 'America/New_York', 'Europe/London', 'Asia/Singapore',
  'America/Los_Angeles', 'Europe/Berlin', 'Australia/Sydney', 'UTC',
]

const TEAM_ADJECTIVES = [
  'Null', 'Syntax', 'Runtime', 'Quantum', 'Binary', 'Pixel', 'Kernel',
  'Crypto', 'Astro', 'Turbo', 'Silent', 'Electric', 'Cosmic', 'Iron',
  'Neon', 'Hyper', 'Mega', 'Ultra', 'Prime', 'Zero', 'Alpha', 'Delta',
  'Omega', 'Vertex', 'Pixel', 'Lunar', 'Solar', 'Rapid', 'Agile', 'Brave',
  'Clever', 'Swift', 'Bold', 'Noble', 'Grand', 'Epic', 'Mythic', 'Stellar',
  'Cosmic', 'Atomic', 'Digital', 'Virtual', 'Cyber', 'Robo', 'Nano',
]

const TEAM_NOUNS = [
  'Pointers', 'Error', 'Terrors', 'Bytes', 'Wizards', 'Ninjas', 'Squad',
  'Crew', 'Hackers', 'Builders', 'Makers', 'Coders', 'Debuggers', 'Pilots',
  'Rangers', 'Seekers', 'Forgers', 'Crafters', 'Shapers', 'Weavers',
  'Runners', 'Jumpers', 'Climbers', 'Divers', 'Flyers', 'Riders', 'Sailors',
  'Miners', 'Harvesters', 'Guardians', 'Sentinels', 'Wardens', 'Keepers',
  'Hunters', 'Trackers', 'Explorers', 'Voyagers', 'Pioneers', 'Trailblazers',
  'Innovators', 'Creators', 'Dreamers', 'Thinkers', 'Solvers', 'Minds',
]

const TEAM_DESCRIPTIONS = [
  'Building an AI tool for students.',
  'A weekend project, taken seriously.',
  'Here to ship something real.',
  'Frontend, backend, and too much coffee.',
  'First hackathon — going for the win.',
  'We build fast and break things gently.',
  '',
  'ML-powered, human-approved.',
]

const REQUEST_MESSAGES = [
  'Hi! I would love to join — my skills fit what you are building.',
  'Hey, looking for a team — I can take the backend.',
  'Hi! Frontend is my thing, happy to own the UI.',
  'Would love to join your team for this hackathon!',
]

// --- Demo dataset (exact, per the video script) ------------------------------

interface DemoUser {
  name: string
  email: string
  skills: string[]
  timezone: string
}

const DEMO_USERS: DemoUser[] = [
  { name: 'Aarav Mehta', email: 'aarav.mehta@demo.hack4hack.test', skills: ['Python', 'ML'], timezone: 'Asia/Kolkata' },
  { name: 'Ananya Iyer', email: 'ananya.iyer@demo.hack4hack.test', skills: ['React', 'TypeScript'], timezone: 'Asia/Kolkata' },
  { name: 'Vikram Nair', email: 'vikram.nair@demo.hack4hack.test', skills: ['Node.js', 'Postgres'], timezone: 'Asia/Kolkata' },
  { name: 'Sneha Patel', email: 'sneha.patel@demo.hack4hack.test', skills: ['React', 'CSS'], timezone: 'America/New_York' },
  { name: 'Arjun Desai', email: 'arjun.desai@demo.hack4hack.test', skills: ['Python', 'Data'], timezone: 'Europe/London' },
  { name: 'Kavya Reddy', email: 'kavya.reddy@demo.hack4hack.test', skills: ['Rust', 'Systems'], timezone: 'Asia/Kolkata' },
  { name: 'Dev Malhotra', email: 'dev.malhotra@demo.hack4hack.test', skills: ['C++', 'Embedded'], timezone: 'Asia/Kolkata' },
  { name: 'Ishita Rao', email: 'ishita.rao@demo.hack4hack.test', skills: ['ML', 'PyTorch'], timezone: 'Asia/Singapore' },
  { name: 'Priya Sharma', email: 'priya.sharma@demo.hack4hack.test', skills: ['Figma', 'UI Design'], timezone: 'Asia/Kolkata' },
  { name: 'Rohan Gupta', email: 'rohan.gupta@demo.hack4hack.test', skills: ['Go', 'Kubernetes'], timezone: 'Asia/Kolkata' },
]

// [team name, leader email, member emails...]
const DEMO_TEAMS: [string, string, string[]][] = [
  ['Null Pointers', 'aarav.mehta@demo.hack4hack.test', ['ananya.iyer@demo.hack4hack.test', 'vikram.nair@demo.hack4hack.test']],
  ['Syntax Error', 'sneha.patel@demo.hack4hack.test', ['arjun.desai@demo.hack4hack.test']],
  ['Runtime Terrors', 'kavya.reddy@demo.hack4hack.test', ['dev.malhotra@demo.hack4hack.test', 'ishita.rao@demo.hack4hack.test']],
]

// [requester email, team name, message]
const DEMO_REQUESTS: [string, string, string][] = [
  ['rohan.gupta@demo.hack4hack.test', 'Syntax Error', 'Hi! I do Go and Kubernetes — happy to handle infra and deployment.'],
  ['priya.sharma@demo.hack4hack.test', 'Syntax Error', 'Hi! I can own the UI — Figma and design systems are my thing.'],
]

// --- Helpers ------------------------------------------------------------------

/** Multi-row INSERT in batches — 10k single inserts would take minutes. */
async function insertBatches(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  batchSize: number,
): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    const placeholders = batch
      .map(
        (_, r) =>
          `(${columns.map((_, c) => `$${r * columns.length + c + 1}`).join(', ')})`,
      )
      .join(', ')
    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}`,
      batch.flat(),
    )
  }
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)]
}

function pickSkills(rng: () => number): string[] {
  const count = 1 + Math.floor(rng() * 3)
  const chosen = new Set<string>()
  while (chosen.size < count) chosen.add(pick(rng, SKILLS))
  return [...chosen]
}

// --- Seed ----------------------------------------------------------------------

async function main(): Promise<void> {
  await migrate()
  const client = await pool.connect()
  try {
    // Truncate + reseed: re-running the seed always starts from a clean
    // slate, so reruns are identical (and a half-finished seed can never
    // leave the database in a mixed state).
    await client.query(
      'TRUNCATE users, sessions, hackathons, teams, team_members, join_requests, audit_log, idempotency_keys RESTART IDENTITY CASCADE',
    )

    const { rows: hackRows } = await client.query(
      `INSERT INTO hackathons (name, team_min_size, team_max_size)
       VALUES ('Hack4Hack 2026', 2, 4)
       RETURNING id`,
    )
    const hackathonId = String(hackRows[0].id)

    // Password: env var wins; otherwise generate a random one and print
    // it. Never hardcoded, never committed.
    const envVar = DEMO ? 'DEMO_PASSWORD' : 'SEED_PASSWORD'
    const fromEnv = process.env[envVar]
    const password = fromEnv ?? randomBytes(9).toString('base64url')
    const passwordHash = await hashPassword(password)

    if (DEMO) {
      await seedDemo(client, hackathonId, passwordHash)
    } else {
      await seedFull(client, hackathonId, passwordHash)
    }

    const counts = await client.query(
      `SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM teams) AS teams,
        (SELECT COUNT(*) FROM team_members) AS members,
        (SELECT COUNT(*) FROM join_requests WHERE status = 'pending') AS pending_requests`,
    )
    const c = counts.rows[0]
    console.log(
      `\nSeeded: ${c.users} users, ${c.teams} teams, ${c.members} memberships, ${c.pending_requests} pending requests.`,
    )
    if (fromEnv) {
      console.log(`Password: using ${envVar} from the environment (not printed).`)
    } else if (DEMO) {
      console.log(`Demo password: ${password} — note this for the video.`)
    } else {
      console.log(`Seed password: ${password} (shared by all seed users).`)
    }
  } finally {
    client.release()
    await pool.end()
  }
}

async function seedDemo(
  client: PoolClient,
  hackathonId: string,
  passwordHash: string,
): Promise<void> {
  const rng = mulberry32(42)
  const base = Date.UTC(2026, 10, 1)
  const userIds = new Map<string, string>()

  const userRows = DEMO_USERS.map((u, i) => {
    const id = randomUUID()
    userIds.set(u.email, id)
    return [
      id, u.email, passwordHash, u.name, u.skills, u.timezone, true, '',
      new Date(base + i * 1000),
    ]
  })
  await insertBatches(
    client, 'users',
    ['id', 'email', 'password_hash', 'name', 'skills', 'timezone', 'looking_for_teammates', 'bio', 'created_at'],
    userRows, 10,
  )

  const teamIds = new Map<string, string>()
  const inviteCodes = new Map<string, string>()
  const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  const teamRows = DEMO_TEAMS.map(([name, leaderEmail], i) => {
    const id = randomUUID()
    const code = seededInviteCode(rng)
    teamIds.set(name, id)
    inviteCodes.set(name, code)
    return [
      id, hackathonId, name, userIds.get(leaderEmail), code, expiry,
      `Demo team ${i + 1}.`, new Date(base + (100 + i) * 1000),
    ]
  })
  await insertBatches(
    client, 'teams',
    ['id', 'hackathon_id', 'name', 'leader_id', 'invite_code', 'invite_expires_at', 'description', 'created_at'],
    teamRows, 10,
  )

  const memberRows: unknown[][] = []
  const auditRows: unknown[][] = []
  for (const [name, leaderEmail, memberEmails] of DEMO_TEAMS) {
    const teamId = teamIds.get(name) as string
    const all = [leaderEmail, ...memberEmails]
    all.forEach((email, j) => {
      memberRows.push([
        teamId, userIds.get(email), hackathonId, new Date(base + (200 + j) * 1000),
      ])
    })
    auditRows.push([
      randomUUID(), teamId, userIds.get(leaderEmail), 'team.created',
      JSON.stringify({ teamName: name }), new Date(base + 300 * 1000),
    ])
  }
  await insertBatches(
    client, 'team_members',
    ['team_id', 'user_id', 'hackathon_id', 'joined_at'],
    memberRows, 10,
  )
  await insertBatches(
    client, 'audit_log',
    ['id', 'team_id', 'actor_id', 'action', 'details', 'created_at'],
    auditRows, 10,
  )

  const requestRows = DEMO_REQUESTS.map(([email, teamName, message], i) => [
    randomUUID(), teamIds.get(teamName), userIds.get(email), 'pending', message,
    new Date(base + (400 + i) * 1000), null,
  ])
  await insertBatches(
    client, 'join_requests',
    ['id', 'team_id', 'user_id', 'status', 'message', 'created_at', 'decided_at'],
    requestRows, 10,
  )

  console.log('\nDemo teams (invite codes — deterministic, same every run):')
  for (const [name] of DEMO_TEAMS) {
    console.log(`  ${name}: ${inviteCodes.get(name)}`)
  }
}

async function seedFull(
  client: PoolClient,
  hackathonId: string,
  passwordHash: string,
): Promise<void> {
  const rng = mulberry32(20261112)
  const base = Date.UTC(2026, 10, 1)
  const USER_COUNT = 10000
  const TEAM_COUNT = 2000

  // --- Users ---
  const userIds: string[] = []
  const emailCounts = new Map<string, number>()
  const userRows: unknown[][] = []
  for (let i = 0; i < USER_COUNT; i++) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length]
    const last = LAST_NAMES[(i * 7 + Math.floor(i / FIRST_NAMES.length)) % LAST_NAMES.length]
    const stem = `${first}.${last}`.toLowerCase()
    const seen = (emailCounts.get(stem) ?? 0) + 1
    emailCounts.set(stem, seen)
    const email = `${stem}${seen > 1 ? seen : ''}@seed.hack4hack.test`
    const id = randomUUID()
    userIds.push(id)
    userRows.push([
      id, email, passwordHash, `${first} ${last}`, pickSkills(rng),
      pick(rng, TIMEZONES), rng() < 0.8, '', new Date(base + i * 1000),
    ])
  }
  await insertBatches(
    client, 'users',
    ['id', 'email', 'password_hash', 'name', 'skills', 'timezone', 'looking_for_teammates', 'bio', 'created_at'],
    userRows, 500,
  )

  // --- Teams: sizes cycle 2, 3, 4 (average 3) → 6,000 members, 4,000 seekers.
  // 2,000 is not divisible by 3, so the cycle alone sums to 5,999 — the
  // last team takes one extra member to land exactly 6,000 / 4,000.
  const teamNames = new Set<string>()
  const teamRows: unknown[][] = []
  const teamIds: string[] = []
  const teamSizes: number[] = []
  const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  for (let i = 0; i < TEAM_COUNT; i++) {
    let name = `${pick(rng, TEAM_ADJECTIVES)} ${pick(rng, TEAM_NOUNS)}`
    if (teamNames.has(name)) name = `${name} ${i + 1}`
    teamNames.add(name)
    const id = randomUUID()
    teamIds.push(id)
    teamSizes.push(2 + (i % 3) + (i === TEAM_COUNT - 1 ? 1 : 0))
    teamRows.push([
      id, hackathonId, name, '', seededInviteCode(rng), expiry,
      TEAM_DESCRIPTIONS[i % TEAM_DESCRIPTIONS.length],
      new Date(base + (20000 + i) * 1000),
    ])
  }
  // Leaders are the first member of each team; fill them in now that the
  // membership split is known.
  let userCursor = 0
  const memberRows: unknown[][] = []
  const auditRows: unknown[][] = []
  for (let i = 0; i < TEAM_COUNT; i++) {
    const size = teamSizes[i]
    const leaderId = userIds[userCursor]
    teamRows[i][3] = leaderId
    for (let j = 0; j < size; j++) {
      memberRows.push([
        teamIds[i], userIds[userCursor], hackathonId,
        new Date(base + (30000 + userCursor) * 1000),
      ])
      userCursor++
    }
    auditRows.push([
      randomUUID(), teamIds[i], leaderId, 'team.created',
      JSON.stringify({ teamName: teamRows[i][2] }),
      new Date(base + (40000 + i) * 1000),
    ])
  }
  await insertBatches(
    client, 'teams',
    ['id', 'hackathon_id', 'name', 'leader_id', 'invite_code', 'invite_expires_at', 'description', 'created_at'],
    teamRows, 500,
  )
  await insertBatches(
    client, 'team_members',
    ['team_id', 'user_id', 'hackathon_id', 'joined_at'],
    memberRows, 1000,
  )
  await insertBatches(
    client, 'audit_log',
    ['id', 'team_id', 'actor_id', 'action', 'details', 'created_at'],
    auditRows, 500,
  )

  // --- Pending join requests: 500, from seekers to teams with open seats.
  const seekerStart = userCursor // users 6000..9999 are not in a team
  const openTeams = teamIds.filter((_, i) => teamSizes[i] < 4)
  const seenPairs = new Set<string>()
  const requestRows: unknown[][] = []
  let made = 0
  let guard = 0
  while (made < 500 && guard < 5000) {
    guard++
    const userIdx = seekerStart + Math.floor(rng() * (USER_COUNT - seekerStart))
    const teamId = pick(rng, openTeams)
    const key = `${teamId}:${userIds[userIdx]}`
    if (seenPairs.has(key)) continue
    seenPairs.add(key)
    requestRows.push([
      randomUUID(), teamId, userIds[userIdx], 'pending',
      pick(rng, REQUEST_MESSAGES), new Date(base + (50000 + made) * 1000), null,
    ])
    made++
  }
  await insertBatches(
    client, 'join_requests',
    ['id', 'team_id', 'user_id', 'status', 'message', 'created_at', 'decided_at'],
    requestRows, 500,
  )
}

main().catch((err: unknown) => {
  console.error('[seed] failed:', err)
  process.exit(1)
})

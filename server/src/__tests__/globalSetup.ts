// Vitest global setup: reset the scratch test database, build the server,
// start it on a dedicated test port, and wait until it answers. Tears the
// server down when the run finishes.
//
// The tests speak real HTTP to this server, so the race test exercises the
// real request path end to end — routing, auth, transactions, row locks.
//
// Environment:
//   TEST_DATABASE_URL — test database (default postgres://postgres@localhost:5432/hack4hack_test)
//   TEST_PORT         — port for the spawned server (default 3101)
//   SKIP_TEST_BUILD=1 — skip `npm run build`; requires server/dist to exist

import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'

// The server package root. Vitest runs global setup with the working
// directory set to the project root (server/), including when invoked via
// `npm run test -w server` from the repo root. TEST_SERVER_DIR overrides
// it for unusual invocations. (import.meta.url would be nicer, but the
// server's tsconfig compiles to CommonJS, where import.meta is illegal.)
const SERVER_DIR = process.env.TEST_SERVER_DIR ?? process.cwd()
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/hack4hack_test'
const TEST_PORT = process.env.TEST_PORT ?? '3101'
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`

function dbNameFrom(url: string): string {
  const name = new URL(url).pathname.replace(/^\//, '')
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`unsafe database name in TEST_DATABASE_URL: ${name}`)
  }
  return name
}

async function resetDatabase(): Promise<void> {
  const dbName = dbNameFrom(TEST_DATABASE_URL)
  const maintenanceUrl = new URL(TEST_DATABASE_URL)
  maintenanceUrl.pathname = '/postgres'
  const admin = new pg.Client({ connectionString: maintenanceUrl.toString() })
  await admin.connect()
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName}"`)
    }
  } finally {
    await admin.end()
  }

  const schemaPath = path.join(SERVER_DIR, 'src/db/schema.sql')
  if (!existsSync(schemaPath)) {
    throw new Error(
      `Backend schema not found at ${schemaPath} — the backend is not ready yet. ` +
        'Tests need server/src/db/schema.sql (contract: data model source of truth).',
    )
  }
  const schemaSql = readFileSync(schemaPath, 'utf8')
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    // Fresh schema every run: drop everything, re-apply the backend's schema.
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
    await client.query(schemaSql)
    // The one seeded hackathon the contract requires. Insert only if the
    // backend has not already seeded it (e.g. on server startup).
    await client.query(
      `INSERT INTO hackathons (name, starts_at, ends_at, team_min_size, team_max_size)
       SELECT 'Hack4Hack 2026', '2026-11-21 09:00:00+00', '2026-11-22 18:00:00+00', 2, 4
       WHERE NOT EXISTS (SELECT 1 FROM hackathons WHERE name = 'Hack4Hack 2026')`,
    )
  } finally {
    await client.end()
  }
}

function buildServer(): void {
  if (process.env.SKIP_TEST_BUILD === '1') {
    if (!existsSync(path.join(SERVER_DIR, 'dist/index.js'))) {
      throw new Error(
        'SKIP_TEST_BUILD=1 but server/dist/index.js does not exist — run npm run build first.',
      )
    }
    return
  }
  // Always build from current source so tests never run against a stale dist.
  execSync('npm run build', { cwd: SERVER_DIR, stdio: 'inherit' })
}

async function waitForServer(child: ChildProcess, stderr: { text: string }): Promise<void> {
  const deadline = Date.now() + 30_000
  let listening = false
  child.stdout?.on('data', (d: Buffer) => {
    // The server logs "[server] listening on ..." once its socket is up.
    // Waiting for OUR child's line (not just any 200 on the port) proves
    // the server answering is the one we spawned — a stale server from
    // an earlier run must never be mistaken for it.
    if (d.toString().includes('listening on')) listening = true
  })
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `test server exited early (code ${child.exitCode}):\n${stderr.text.slice(-3000)}`,
      )
    }
    if (listening) {
      try {
        const res = await fetch(`${BASE_URL}/api/hackathons`)
        if (res.ok) return
      } catch {
        // Listening but not answering yet — keep waiting.
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `test server did not answer within 30s. stderr tail:\n${stderr.text.slice(-3000)}`,
      )
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

// Fail fast if something already owns the test port: testing against a
// stale server from an earlier run would silently measure the wrong
// process (and the wrong database). The fix is to kill that listener,
// not to share its port.
async function assertPortFree(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/api/hackathons`, {
      signal: AbortSignal.timeout(1000),
    })
    if (res.status) {
      throw new Error(
        `Port ${TEST_PORT} is already in use — a stale test server may be ` +
          `running. Find it (ss -tlnp | grep ${TEST_PORT}) and kill that PID, ` +
          `then re-run. Refusing to test against a server this run did not start.`,
      )
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`Port ${TEST_PORT}`)) throw err
    // Connection refused / timeout: the port is free, as expected.
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  await assertPortFree()
  await resetDatabase()
  buildServer()
  const stderr = { text: '' }
  const child = spawn('node', ['dist/index.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PORT: TEST_PORT, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Server stdout is consumed by waitForServer (listening line); stderr
  // is kept so a failed start can explain itself.
  child.stderr?.on('data', (d: Buffer) => {
    stderr.text += d.toString()
    if (stderr.text.length > 20000) stderr.text = stderr.text.slice(-20000)
  })
  await waitForServer(child, stderr)
  return async () => {
    child.kill('SIGTERM')
    // The server shuts down gracefully on SIGTERM; give it up to 2s,
    // then escalate — a lingering server would poison the next run.
    const deadline = Date.now() + 2000
    while (child.exitCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (child.exitCode === null) {
      console.warn('[tests] test server ignored SIGTERM, sending SIGKILL')
      child.kill('SIGKILL')
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

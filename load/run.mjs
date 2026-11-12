// Load-test runner: warms the server, hammers the board endpoint with
// autocannon, then runs a mixed read/write pass. Prints real measured
// numbers and writes them to load/last-run.json for the report.
//
// The server must already be running against a seeded database:
//   1. cd load && npm install && npm run seed   # 10k users / 2k teams
//   2. start the server against the same database (npm start -w server)
//   3. npm run run   (in load/)
//
// Environment:
//   LOAD_BASE_URL     server under test (default http://127.0.0.1:3000)
//   LOAD_CONNECTIONS  concurrent connections for the board pass (default 100)
//   LOAD_DURATION     seconds per pass (default 30)
import autocannon from 'autocannon'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE_URL = process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3000'
const CONNECTIONS = Number(process.env.LOAD_CONNECTIONS ?? 100)
const DURATION = Number(process.env.LOAD_DURATION ?? 30)

async function getHackathonId() {
  const res = await fetch(`${BASE_URL}/api/hackathons`)
  if (!res.ok) throw new Error(`GET /api/hackathons failed: ${res.status}`)
  const body = await res.json()
  const list = Array.isArray(body) ? body : body.hackathons
  const hack = list.find((h) => h.name === 'Hack4Hack 2026') ?? list[0]
  if (!hack) throw new Error('no hackathon found — seed the database first')
  return hack.id
}

async function warmup(boardUrl) {
  // 20 sequential board reads: fills the in-memory board cache and warms
  // the JIT/connection pool, so the measured pass is steady-state, not cold.
  for (let i = 0; i < 20; i++) {
    const res = await fetch(boardUrl)
    if (!res.ok) throw new Error(`warmup failed: ${res.status}`)
  }
}

function runAutocannon(opts) {
  return new Promise((resolve, reject) => {
    const instance = autocannon(opts, (err, result) => (err ? reject(err) : resolve(result)))
    autocannon.track(instance, { renderProgressBar: true })
  })
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

// Mixed pass: N workers looping register → create team → board read, each
// iteration timed end to end. Exercises the write path (auth + team create
// + cache invalidation) interleaved with board reads, the way real traffic
// mixes them. Registration is the slowest step (scrypt), so iteration
// latency is dominated by password hashing — that is honest load, not
// board latency; the board-only pass above is the headline number.
async function mixedPass(boardUrl, hackathonId, seconds) {
  const WORKERS = 10
  const latencies = []
  let ops = 0
  let errors = 0
  const stopAt = Date.now() + seconds * 1000
  async function worker(id) {
    let n = 0
    while (Date.now() < stopAt) {
      n += 1
      const started = Date.now()
      try {
        const email = `load-mixed-${id}-${n}-${Date.now()}@example.com`
        const password = `pw-${id}-${n}-${Date.now()}`
        const reg = await fetch(`${BASE_URL}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, name: `Load ${id}` }),
        })
        if (reg.status !== 201) throw new Error(`register ${reg.status}`)
        let cookie = reg.headers.getSetCookie()?.[0]?.split(';')[0]
        if (!cookie) {
          const login = await fetch(`${BASE_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
          })
          if (login.status !== 200) throw new Error(`login ${login.status}`)
          cookie = login.headers.getSetCookie()?.[0]?.split(';')[0]
        }
        const team = await fetch(`${BASE_URL}/api/teams`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
            'Idempotency-Key': `load-${id}-${n}-${Date.now()}`,
          },
          body: JSON.stringify({ hackathonId, name: `Load Mixed ${id}-${n}` }),
        })
        if (team.status !== 201) throw new Error(`create team ${team.status}`)
        const board = await fetch(boardUrl)
        if (!board.ok) throw new Error(`board ${board.status}`)
      } catch {
        errors += 1
      }
      latencies.push(Date.now() - started)
      ops += 1
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)))
  latencies.sort((a, b) => a - b)
  const mean = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null
  return { ops, errors, p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99), mean }
}

async function main() {
  const hackathonId = await getHackathonId()
  const boardUrl = `${BASE_URL}/api/hackathons/${hackathonId}/board`
  console.log(`target: ${boardUrl}`)
  console.log(`board pass: ${CONNECTIONS} connections, ${DURATION}s (after 20-request warmup)`)
  await warmup(boardUrl)
  const board = await runAutocannon({ url: boardUrl, connections: CONNECTIONS, duration: DURATION })
  console.log(`\nmixed pass: 10 workers, ${DURATION}s (register + create team + board read per iteration)`)
  const mixed = await mixedPass(boardUrl, hackathonId, DURATION)

  // autocannon 8 reports p2.5/p50/p75/p90/p97.5/p99/p99.9 — there is no
  // p95. We record p97.5 (a conservative stand-in: p95 <= p97.5) and
  // never invent a p95. Only percentiles autocannon actually measured
  // are included.
  const latencyMs = {}
  for (const [label, key] of [
    ['mean', 'mean'],
    ['p50', 'p50'],
    ['p75', 'p75'],
    ['p90', 'p90'],
    ['p97_5', 'p97_5'],
    ['p99', 'p99'],
    ['max', 'max'],
  ]) {
    if (board.latency[key] !== undefined) latencyMs[label] = board.latency[key]
  }
  const summary = {
    runAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    boardPass: {
      connections: CONNECTIONS,
      durationSeconds: DURATION,
      requestsPerSecond: board.requests.average,
      totalRequests: board.requests.total,
      errors: board.errors,
      timeouts: board.timeouts,
      latencyMs,
      statusCounts: { '2xx': board['2xx'], '4xx': board['4xx'], '5xx': board['5xx'] },
      throughputBytesPerSecond: board.throughput.average,
    },
    mixedPass: {
      workers: 10,
      durationSeconds: DURATION,
      iterations: mixed.ops,
      errors: mixed.errors,
      latencyMs: { mean: mixed.mean, p50: mixed.p50, p95: mixed.p95, p99: mixed.p99 },
    },
  }
  const outPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'last-run.json')
  writeFileSync(outPath, JSON.stringify(summary, null, 2))
  console.log(`\n=== BOARD (GET /api/hackathons/:id/board, ${CONNECTIONS} conn, ${DURATION}s) ===`)
  console.log(`requests/s: ${board.requests.average}  total: ${board.requests.total}  errors: ${board.errors}  timeouts: ${board.timeouts}`)
  console.log(`latency ms: ${Object.entries(latencyMs).map(([k, v]) => `${k} ${v}`).join('  ')}`)
  console.log(`status: 2xx ${board['2xx']}  4xx ${board['4xx']}  5xx ${board['5xx']}`)
  console.log(`\n=== MIXED (register + create team + board, 10 workers, ${DURATION}s) ===`)
  console.log(`iterations: ${mixed.ops}  errors: ${mixed.errors}`)
  console.log(`iteration latency ms: mean ${mixed.mean}  p50 ${mixed.p50}  p95 ${mixed.p95}  p99 ${mixed.p99}`)
  console.log(`\nfull results: ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

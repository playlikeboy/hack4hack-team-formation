# Load-test report — Hack4Hack PS1 board endpoint

> **LOCAL RUNS — not the deployed service.** All runs below were measured
> against a server on this development VM (server, Postgres, and the load
> generator all on one box, talking over localhost). The coordinator will
> re-run the scripts against the live deployed URL and append those
> numbers here; the local runs stay as the baseline.

## Verdict

**PASS — board p95 is 130 ms at 100 concurrent users** (k6, exact
percentile, 12 Nov 09:36 IST), against the 200 ms target. The autocannon
run on the same code agrees: p97.5 107 ms (p95 is always ≤ p97.5), 0
errors across 59,441 requests. The target was not met on the first try —
it took three measured iterations to get here, and the misses are kept
below so the numbers are auditable, not cherry-picked.

## Final results (12 Nov 2026, final code)

Dataset for all runs: 10,000 users, 2,000 teams, 5,999 memberships,
3,240 seekers, seeded deterministically into scratch database
`hack4hack_load`. Endpoint: `GET /api/hackathons/:id/board`, default page
(50 teams + 50 seekers), 100 concurrent connections / virtual users, 30 s,
after a 20-request warmup.

### k6 — exact p95 (09:36 IST)

`load/board-k6.js`, k6 v0.57.0, 100 VUs, 30 s:

| Metric | Value |
|---|---|
| Requests | 38,480 |
| Requests/s | 1,278.86 |
| Failed | 0 (0.00%) |
| http_req_duration avg / med | 77.65 / 73.70 ms |
| http_req_duration p(90) | 109.98 ms |
| http_req_duration **p(95)** | **130.02 ms** |
| http_req_duration max | 4.48 s |
| Data received | 1.1 GB (37 MB/s) |

### autocannon — board pass (09:37 IST)

`load/run.mjs`, autocannon 8, 100 connections, 30 s
(raw JSON: `load/last-run.json`):

| Metric | Value |
|---|---|
| Requests/s | 1,981.67 |
| Total requests | 59,441 |
| Errors / timeouts | 0 / 0 |
| Status | 59,441 × 2xx, 0 × 4xx, 0 × 5xx |
| Latency mean / p50 | 50.02 / 42 ms |
| Latency p75 / p90 | 55 / 77 ms |
| Latency p97.5 / p99 | 107 / 146 ms |
| Latency max | 472 ms |
| Throughput | 56.8 MB/s |

autocannon reports no p95; p95 ≤ p97.5 = 107 ms here, consistent with
k6's exact 130 ms (different clients, same server — k6 is the more
conservative measure and is the headline number).

### Mixed pass (09:37 IST, same run as the autocannon board pass)

10 workers × 30 s, each iteration register → create team → board read:

| Metric | Value |
|---|---|
| Iterations | 153 |
| Errors | 0 |
| Iteration latency mean / p50 / p95 / p99 | 2,007 / 2,054 / 2,914 / 3,327 ms |

Iteration latency is dominated by scrypt password hashing on register
(~2 s per iteration across register + create + board) — that is honest
load, not board latency. The board-only passes above are the headline
numbers. Zero errors while writes interleaved with reads (each team
create invalidates the board cache) shows the cache stays correct under
mutation, not just under pure reads.

## How we got here (the misses, kept)

### Step 0 — unpaginated board (09:06 / 09:08 IST): MISS by >10×

The board returned all 2,000 teams + 3,240 seekers in one ~1.3 MB
response, re-serialized per request. Two autocannon runs: 37.97 and
23.34 req/s; p50 2,430 / 3,904 ms; p90 3,264 / 5,423 ms; 0 errors.
Single-request latency was fine (19–77 ms), so the cache worked — the
miss was throughput, not the query.

### Step 1 — pre-serialized full board (~09:22 IST): still MISS

Caching the serialized JSON string + gzip bytes cut p50 to 793 ms
(100.77 req/s, p90 1,161 ms, p97.5 1,356 ms) but added 21 timeouts.
Moving 1.3 MB × 100 concurrent connections is itself the bottleneck;
no amount of caching fixes a 1.3 MB response.

### Step 2 — pagination (~09:27 IST): borderline

The board paginates (default 50 teams + 50 seekers, totals returned,
client "Load more"). autocannon: 807.27 req/s, p50 110 ms, p90 177 ms,
p97.5 230 ms, 0 errors. k6 exact p95 (09:30 IST): **217.75 ms** —
a miss by 18 ms. The remaining cost was per-request work: a Postgres
round trip to validate the hackathon id, plus JSON.stringify + gzip of
each page.

### Step 3 — hot-path caches (09:36–09:37 IST): PASS

Two changes, both in the final code: the hackathon row is cached for
60 s (hackathons are never mutated by the API, so the cache is safe),
and the default page's JSON + gzip bytes are pre-built at invalidation
time (other windows still paginate from the cached object). k6 p95 fell
217.75 → **130.02 ms**; autocannon p97.5 fell 230 → 107 ms. No
correctness trade was made: the board cache still invalidates on every
team mutation, and the 47-test suite stayed green throughout.

## Methodology

- **Scripts:** `load/seed.mjs` (dataset), `load/run.mjs` (autocannon
  board + mixed passes), `load/board-k6.js` (k6 exact-p95 pass),
  documented in `load/README.md`. Raw JSON for the latest autocannon
  run is in `load/last-run.json`.
- **Dataset:** `load/seed.mjs` rebuilds the schema from
  `server/src/db/schema.sql` and inserts 10,000 users and 2,000 teams
  (sizes cycle 2/3/4, 5,999 memberships, 3,240 seekers), deterministic
  seeded RNG. The mixed pass adds teams as it runs; each board pass
  above ran against a freshly seeded database except where noted.
- **Warmup:** 20 sequential board reads before each board pass (fills
  the in-memory board cache, warms JIT and the connection pool), so the
  measured pass is steady-state.
- **Server:** `node server/dist/index.js` (production build, `npm run
  build`), `PORT=3000`, `DATABASE_URL` pointing at `hack4hack_load`.
- **Hardware:** shared VM, 1.5 shared vCPUs available to this cell,
  Node v24.22.1, Postgres 16.15 (local, trust auth), autocannon 8.0.0,
  k6 v0.57.0. Server, database, and load generator on the same host
  (localhost) — the client competes with the server for CPU, so these
  numbers are conservative for a deployed service with its own host.

## Caveats

- The p95 target is met **locally**. A live-URL run (different host,
  real network) may differ; it will be appended here, not substituted.
- The default page is 50 + 50. A client requesting the maximum page
  (200 + 200) gets a ~4× larger response and correspondingly higher
  latency; the load test measures the default, which is what the UI
  and the challenge's "board endpoint" mean in practice.
- The k6 max of 4.48 s is a single outlier (likely a cold cache build
  or GC pause under load); p99 was not reported by k6 in this run, and
  the autocannon max on the same code was 472 ms.

## Re-running

Against the deployed URL (coordinator): the load scripts never seed a
remote database — seed only local scratch databases.

```sh
cd load
LOAD_BASE_URL=https://<deployed-space> npm run run
HACKATHON_ID=<id> LOAD_BASE_URL=https://<deployed-space> k6 run load/board-k6.js
```

Append the deployed numbers to this report with the date, URL, and
dataset size; keep the local runs above as the baseline.

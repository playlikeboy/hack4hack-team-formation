# Load test

Measures the board endpoint under concurrent load, plus a mixed read/write
pass, against a real server and a real Postgres seeded at contract scale
(10,000 users, 2,000 teams). Numbers in `docs/load-test-report.md` come
only from runs of these scripts — never estimated.

## Run it

```sh
cd load
npm install          # autocannon + pg, local to load/
npm run seed         # drops + rebuilds the scratch DB from schema.sql, seeds 10k/2k
```

Then start the server against the same database (from the repo root):

```sh
DATABASE_URL=postgres://postgres@localhost:5432/hack4hack npm start -w server
```

Then run the load test (from `load/`):

```sh
npm run run
```

Results print to stdout and are written to `load/last-run.json`.

## Methodology

1. **Dataset** — `seed.mjs` rebuilds the schema from
   `server/src/db/schema.sql` and inserts 10,000 users and 2,000 teams
   (sizes cycle 2/3/4, ~6,000 memberships, ~4,000 seekers), with a
   deterministic seeded RNG so reruns produce the same dataset. Override
   with `LOAD_USERS` / `LOAD_TEAMS`; database with `LOAD_DATABASE_URL`
   (default `postgres://postgres@localhost:5432/hack4hack`). The seed
   **drops the schema** — scratch databases only.
2. **Warmup** — 20 sequential `GET /board` requests fill the in-memory
   board cache and warm the JIT and connection pool, so the measured pass
   is steady-state.
3. **Board pass** — autocannon, `GET /api/hackathons/:id/board`,
   100 concurrent connections for 30s (override with `LOAD_CONNECTIONS` /
   `LOAD_DURATION`). Reports req/s, errors, and mean/p50/p75/p90/p97.5/p99/
   max latency. (autocannon has no p95 percentile; p97.5 is reported
   instead — p95 is always ≤ p97.5, so it is a conservative stand-in.)
   For an exact p95, use the k6 pass: `load/board-k6.js` (100 VUs, 30s,
   needs `HACKATHON_ID` from `GET /api/hackathons`):
   `HACKATHON_ID=<id> k6 run load/board-k6.js`.
4. **Mixed pass** — 10 workers for 30s, each looping register → create
   team → board read, timed end to end. This exercises the write path
   (auth + team create + cache invalidation) interleaved with reads. Note
   iteration latency is dominated by scrypt password hashing on register —
   that is honest load, not board latency; the board pass is the headline
   number.

## Target

The design goal is board p95 < 200ms at 100 concurrent connections on the
full dataset. If a run misses it, the report says so with the real number —
no rounding up, no re-running until it passes.

## Re-running against the deployed URL

Set `LOAD_BASE_URL` to the live URL (the load scripts never seed a remote
database — seed only local scratch databases):

```sh
LOAD_BASE_URL=https://<deployed-space> npm run run
HACKATHON_ID=<id> LOAD_BASE_URL=https://<deployed-space> k6 run load/board-k6.js
```

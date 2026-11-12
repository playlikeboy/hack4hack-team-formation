# API tests

Real HTTP against a real server backed by a real Postgres. Nothing is mocked:
the race test only proves the transaction + row-lock path if the request path,
the database, and the locks are all real.

## Running

```sh
cd server
npm test              # full suite (47 tests)
npm test -- race      # the race test only
npm test -- auth      # any file whose name matches the filter
```

`npm test` needs a local Postgres on 5432 (trust auth, user `postgres`).
The suite resets the scratch database `hack4hack_test` itself: it creates the
database if missing, drops the schema, re-applies `server/src/db/schema.sql`,
and seeds the one hackathon. Never point it at a database you care about.

## How it works

`globalSetup.ts` runs once per `npm test` invocation:

1. Fail fast if something already owns port 3101 — testing against a
   stale server from an earlier run (or a teammate's concurrent run)
   would silently measure the wrong process. Kill that listener and
   re-run; two runs cannot share one port and one scratch database.
2. Reset `hack4hack_test` (drop schema, apply `src/db/schema.sql`, seed the
   "Hack4Hack 2026" hackathon row if the backend has not already).
3. Run `npm run build` so tests never run against a stale `dist/`
   (skip with `SKIP_TEST_BUILD=1` if `dist/` is already current).
4. Spawn `node dist/index.js` on port 3101 with `DATABASE_URL` pointed at
   the test database, wait for its `listening` line plus a successful
   `GET /api/hackathons`, and kill the server when the run finishes
   (SIGTERM, escalating to SIGKILL).

Tests then use `helpers.ts` (`api`, `registerUser`, `createTeam`, …) to talk
to that server over HTTP.

## Isolation strategy

No truncation between tests. Each test registers fresh users (unique emails)
and uses unique team names, and every assertion is scoped to the entities
that test created (filter by id/name, never "the board has exactly N teams").
That keeps tests order-independent and fast, and avoids stale-cache hazards:
the server's in-memory board cache is only ever invalidated through the API,
so tests never bypass it with direct deletes. The two exceptions are direct
SQL updates the API cannot express at all — expiring an invite code and
flipping `looking_for_teammates` — neither of which touches cached state.

Files run sequentially (`singleFork` in `vitest.config.ts`)
because they share one database and one server. Concurrency that matters —
the race test — is HTTP-level inside a single test and unaffected.

## Rate limits

Each simulated user carries a distinct `X-Forwarded-For` address. In
production 50 racers are 50 people on 50 IPs; the header reproduces that,
so a per-IP rate limit measures abuse by one actor rather than the whole
suite sharing localhost. It is harmless if the server ignores the header —
but if the server keys its join rate limit on the socket IP and ignores
`X-Forwarded-For`, the race test will see 429s instead of 409s. That is a
real design tension (see the race test's failure message), not a test bug:
one IP sending 50 legitimate joins from 50 different users is exactly what
the race test is.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `TEST_DATABASE_URL` | `postgres://postgres@localhost:5432/hack4hack_test` | Scratch test database |
| `TEST_PORT` | `3101` | Port for the spawned test server |
| `TEST_BASE_URL` | `http://127.0.0.1:3101` | Base URL tests talk to |
| `SKIP_TEST_BUILD` | unset | Set to `1` to skip the build step |

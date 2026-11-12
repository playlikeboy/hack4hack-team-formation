# Hack4Hack Team Formation

Race-proof team formation for a hackathon with 10,000 participants. Built for the
[Hack4Hack Crew Hiring Challenge 2026](https://hack4hack.com), Problem Statement 1.

Participants register, browse a live "looking for teammates" board, create teams with
expiring invite codes, send join requests the team leader accepts or declines, and get
teammate suggestions ranked by complementary skills and timezone. The hard requirement
is correctness under concurrency: when 50 people race for the last seat on a team,
exactly one wins — proven by an automated test, not by hope.

## Live demo

> **TODO (coordinator):** fill in the deployed URL after the Hugging Face Space goes live.
> Expected: `https://huggingface.co/spaces/<username>/hack4hack-team-formation`

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Server | Node 20 + TypeScript + Hono + `pg` | Small, fast, no framework magic to explain |
| Real-time | `ws` WebSockets, same HTTP server | One mechanism for all live updates |
| Database | PostgreSQL 16 | The **only** source of truth for seats and membership |
| Client | Vite + React + TypeScript + Tailwind | Hand-rolled components, no component library |
| Tests | Vitest against a real Postgres | Concurrency can't be tested against mocks |
| Deploy | One Docker container (server serves the built client) | Single unit to run, scale, and reason about |

Deliberately **no Redis**: a second seat count is a second source of truth, and the two
can drift. Board speed comes from an indexed query plus an in-memory cache invalidated
on every mutation, plus pagination (default 50 teams + 50 seekers per page) — the
full 2,000-team board is ~1.3 MB, and serving it whole missed the p95 target by
10× (see [docs/load-test-report.md](docs/load-test-report.md)). See
[docs/design-doc.md](docs/design-doc.md) for the full trade-off discussion.

## Quick start

### Prerequisites

- Node.js 20+ and npm
- PostgreSQL 16 (local install, or `docker compose up db` if you have Docker)

### 1. Install

```bash
git clone https://github.com/playlikeboy/hack4hack-team-formation.git
cd hack4hack-team-formation
npm install
```

### 2. Configure

Copy the example env file and fill in your local values. The values below are
**placeholders for local development only** — never commit real credentials.

```bash
cp .env.example .env
```

| Variable | Example (local) | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://localhost:5432/hack4hack` | Local Postgres, trust auth (no password) |
| `PORT` | `3000` | Server port |
| `NODE_ENV` | `development` | `production` on deploy |
| `SESSION_COOKIE_SECURE` | `false` | `true` in production (HTTPS only) |
| `PUBLIC_URL` | `http://localhost:3000` | Optional; used for invite links |

### 3. Migrate and seed

```bash
# Create the database and apply the schema
createdb hack4hack
psql hack4hack < server/src/db/schema.sql

# Seed 10,000 users + 2,000 teams (deterministic, reruns are identical)
npm run seed

# Or seed the small demo dataset instead (10 users, 3 teams, 2 pending requests)
npm run seed -- --demo
```

The seed is idempotent: re-running it truncates and reseeds from scratch.

### 4. Run the dev servers

```bash
npm run dev
```

- Client (Vite): http://localhost:5173
- API + WebSocket server: http://localhost:3000

In dev, Vite proxies `/api` and `/ws` to the server. In production the server serves
the built client statically from `server/public/` — one process, one port.

### One-command alternative (Docker)

```bash
docker compose up --build
```

This starts Postgres 16 and the app container. App on http://localhost:3000.

## Running tests

```bash
cd server
npm test            # API + concurrency tests against a scratch Postgres (hack4hack_test)
npm run typecheck   # tsc --noEmit
npm run build       # compile to dist/
```

CI (`.github/workflows/ci.yml`) runs install → typecheck → tests (with a `postgres:16`
service) → build of client and server, on every push.

The test suite includes the race test that defines this project: **50 concurrent join
attempts on the last seat of a team — exactly one succeeds, the other 49 get a 409.**
See `server/src/__tests__/`.

## How the pieces fit

```
                 ┌─────────────────────────────────────────────┐
                 │  Browser (React + Tailwind, Vite)           │
                 │  / board · /teams/:id · /suggestions · auth │
                 └──────┬──────────────────────────┬───────────┘
                        │ REST /api                │ WebSocket /ws
                        ▼                          ▼
                 ┌─────────────────────────────────────────────┐
                 │  Server (Node + Hono) — ONE container       │
                 │  routes → services → pg                     │
                 │  board cache (in-memory, invalidated on     │
                 │  every team mutation)                       │
                 │  WS rooms: board:<hackathonId>, team:<id>   │
                 └──────────────────────┬──────────────────────┘
                                        │ SQL
                                        ▼
                 ┌─────────────────────────────────────────────┐
                 │  PostgreSQL 16 — ONLY source of truth       │
                 │  txn + SELECT ... FOR UPDATE on team row    │
                 │  unique (hackathon_id, user_id) backstop    │
                 └─────────────────────────────────────────────┘
```

Request flow for a join (the race-critical path):

1. Client `POST /api/teams/:id/join` with an invite code and an `Idempotency-Key`.
2. Server opens a transaction, locks the team row (`SELECT ... FOR UPDATE`), and
   counts current members **inside** the transaction.
3. If a seat is free and the user isn't already on a team for this hackathon, the
   member row is inserted; otherwise the transaction rolls back with a 409.
4. The unique index on `team_members(hackathon_id, user_id)` is the backstop: even
   if application logic ever slipped, the database refuses a second team.
5. On commit, the server writes an audit-log row, invalidates the board cache, and
   broadcasts `member.joined` to the board and team rooms.

## API overview

All endpoints live under `/api` and return JSON. Errors are
`{ "error": { "code": "...", "message": "..." } }` with honest HTTP codes
(400 validation, 401 unauthenticated, 403 not leader / not member, 404 not found,
409 conflict / full / already in a team, 429 rate-limited).

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `POST /api/auth/register` | – | Email + password (scrypt), name, skills, timezone |
| `POST /api/auth/login` | – | Sets an httpOnly session cookie; 10 attempts / IP / min |
| `POST /api/auth/logout` | ✓ | |
| `GET /api/auth/me` | ✓ | |
| `GET /api/hackathons` | – | Seeded hackathon(s) |
| `GET /api/hackathons/:id/board` | – | Public; cached, invalidated on mutation; paginated (`teamsLimit`/`teamsOffset`/`seekersLimit`/`seekersOffset`, default 50, max 200; returns `totalTeams`/`totalSeekers`) |
| `POST /api/teams` | ✓ | Creator becomes leader + first member |
| `GET /api/teams/:id` | – | Leader sees join requests; members see audit log |
| `POST /api/teams/:id/join` | ✓ | Invite code; **the race-critical path** |
| `POST /api/teams/:id/requests` | ✓ | Join request with optional message |
| `POST /api/teams/:id/requests/:requestId/accept` | leader | Same txn + lock as join (team may fill up meanwhile) |
| `POST /api/teams/:id/requests/:requestId/decline` | leader | |
| `POST /api/teams/:id/leave` | ✓ | Leader leaving passes leadership to earliest-joined member; last member leaving deletes the team |
| `POST /api/teams/:id/remove` | leader | Leader can't remove self — use leave |
| `POST /api/teams/:id/invite/regenerate` | leader | New 8-char code, 7-day expiry |
| `GET /api/users/me/suggestions` | ✓ | Ranked by complementary skills + timezone; score breakdown included |
| `GET /api/teams/:id/audit` | member | Audit entries, newest first |

`POST /api/teams`, `/join`, `/requests`, and `/invite/regenerate` accept an
`Idempotency-Key` header: retrying with the same key replays the original response
instead of creating a duplicate. Concurrent retries are safe via a unique constraint
on `(key, user_id)`.

## Teammate suggestions

`GET /api/users/me/suggestions` ranks people who are looking for teammates by:

- **Skill complement** — their skills minus mine (the more they cover my gaps, the
  higher the score).
- **Timezone overlap** — closer timezones score higher.
- **Base** — only users with `looking_for_teammates = true` are candidates.

The exact formula is documented in the code (`server/src/services/suggestions.ts`)
and in [docs/design-doc.md](docs/design-doc.md), and the API returns the per-factor
breakdown with every suggestion.

## Project layout

```
├── client/                  Vite + React + Tailwind
│   └── src/
│       ├── pages/           board, auth, team, create, join, suggestions
│       └── lib/api.ts       typed API client
├── server/                  Node + Hono + pg + ws
│   ├── src/
│   │   ├── db/schema.sql    source of truth for the data model
│   │   ├── routes/          HTTP endpoints
│   │   ├── services/        business logic (join, suggestions, …)
│   │   ├── ws/              WebSocket rooms + broadcast
│   │   └── __tests__/       API + concurrency tests (vitest)
│   └── scripts/seed.ts      10,000 users / 2,000 teams; --demo for video
├── load/                    load-test scripts + methodology (load/README.md)
├── docs/
│   ├── design-doc.md        one-page design doc
│   └── load-test-report.md  measured numbers only (k6 p95 130 ms, local)
├── .github/workflows/ci.yml
├── Dockerfile               multi-stage: build client + server, run node
├── docker-compose.yml       postgres:16 + app
└── .env.example             placeholder values only
```

## Known limitations

Honest notes, not buried footnotes. Each one is a deliberate trade-off for a
one-weekend build, and each has a clear fix if the project grows.

- **Single instance only.** The board cache, rate limits, and WebSocket rooms all
  live in process memory. A second server instance would serve stale boards, split
  rate-limit counters, and miss broadcasts. Fix: Redis (cache + pub/sub) or sticky
  sessions + a shared store — deliberately deferred, because a second seat count
  must never become a second source of truth.
- **No email verification or password reset.** Registration trusts the email as
  given; there is no "forgot password" flow. Fix: verification tokens + a mail
  provider.
- **Board pagination is offset-based, not cursor-based.** Fine at 2,000 teams
  (the cache holds the full board and pages slice from it); deep pages past
  ~10,000 teams would want cursors.
- **Load test measured locally (12 Nov).** Board p95 **130 ms** at 100 concurrent
  users (k6, exact percentile; autocannon p97.5 107 ms), target <200 ms — see
  `docs/load-test-report.md` for the full numbers and the three iterations it
  took. A live-URL run is still to be appended.
- **Rate limits are in-memory and per-IP.** They stop casual brute force on invite
  codes (5 attempts / IP / 10 min) and login (10 / IP / min), but a distributed
  attack or a shared NAT IP would need a shared store and account-level limits.
- **Invite codes are 8 characters (~40 bits: 32^8).** Brute force is infeasible at the
  rate limit, but the codes are not unguessable in the cryptographic sense; they
  are short on purpose so humans can type them.
- **One hackathon is seeded** ("Hack4Hack 2026"). The schema supports many, but
  there is no admin UI to create one.
- **No moderation tooling.** Team names, bios, and request messages are
  user-controlled text with no reporting or admin removal flow.
- **Sessions have no "log out everywhere"** beyond deleting the session row; token
  revocation is per-session.

# Server — Hack4Hack Team Formation

Node 20 + TypeScript + Hono + `pg` + `ws`, Postgres 16. The API contract
lives in `~/workspace/hack4hack-ps1/contract.md` (repo-external); the
design decisions live in `../docs/design-doc.md`.

## Run it

```bash
# From the repo root:
npm install            # workspaces: server + client
cp .env.example .env   # local values (placeholders only)

createdb hack4hack     # or use the existing local database
npm run seed           # 10,000 users + 2,000 teams (truncate + reseed)
npm run dev            # server :3000 + Vite client :5173
```

Local Postgres uses trust auth on localhost — no password anywhere:

```
DATABASE_URL=postgres://postgres@localhost:5432/hack4hack
```

The `postgres` role is the local superuser created by the system Postgres
install; the server reads `DATABASE_URL` from the environment and falls
back to the URL above when unset. The schema is applied automatically on
boot (idempotent), so a fresh database needs no manual migration step —
but `psql hack4hack < src/db/schema.sql` works too.

## Scripts (in `server/`)

| Command | What it does |
| --- | --- |
| `npm run dev` | `tsx watch src/index.ts` — restarts on change |
| `npm run build` | `tsc` → `dist/`, plus copies `schema.sql` alongside |
| `npm start` | `node dist/index.js` (production) |
| `npm run seed` | Full seed: 10,000 users + 2,000 teams |
| `npm run seed -- --demo` | Demo seed: 10 users, 3 teams, 2 pending requests |
| `npm run typecheck` | `tsc --noEmit` (src + scripts) |
| `npm test` | Vitest — API + concurrency tests (`src/__tests__/`) |

## Layout

```
src/
├── app.ts            Hono app: routes, error shape, static client
├── index.ts          entry: migrate → serve HTTP + WS on one port
├── db/
│   ├── pool.ts       the one shared pg Pool
│   ├── migrate.ts    applies schema.sql on boot
│   └── schema.sql    the data model (source of truth)
├── lib/              pure helpers: errors, validation (zod), crypto
│                     (scrypt), invite codes, timezone offsets,
│                     serializers, static file serving
├── routes/           HTTP endpoints: auth, hackathons, teams, users
├── services/         business logic: auth sessions, audit, board cache,
│                     idempotency, rate limits, teams (the race-critical
│                     join path), suggestions, transactions
└── ws/
    └── hub.ts        WebSocket rooms + broadcast
scripts/seed.ts       truncate + reseed (deterministic RNG)
```

## Notes for the interview

- **Race-proofing:** one mechanism — transaction + `SELECT ... FOR UPDATE`
  on the team row, count check inside the transaction
  (`services/teams.ts` → `addMember`), used identically by join-by-code
  and accept-request. Backstop: the unique index on
  `team_members(hackathon_id, user_id)`.
- **Idempotency:** check–execute–store in one transaction behind a
  Postgres advisory lock scoped to `(key, user)`, so concurrent retries
  serialise and the second replays the first's stored response
  (`services/idempotency.ts`).
- **Board cache:** in-memory per hackathon, invalidated on every team
  mutation — create, join, leave, remove, request decision, delete
  (`services/board.ts`). A join request being *created* does not
  invalidate it: requests do not appear on the board.
- **Board `lookingFor`:** derived, not stored — no form collects wanted
  skills, so the board shows the three most common skills among seekers
  that the team does not already have (empty for full teams).
  See `services/board.ts`.
- **Suggestions:** `score = skillComplement + timezone + base` (max 80);
  the formula is documented in `services/suggestions.ts` and in
  `docs/design-doc.md`, and the API returns the breakdown.
- **Auth:** scrypt password hashes, opaque session tokens (SHA-256 hash
  stored, raw token in an httpOnly cookie). No JWT.
- **Static client:** in production the server serves the built client
  from `server/public/` (the Dockerfile copies `client/dist/` there);
  in dev, Vite on :5173 proxies `/api` and `/ws` to :3000.
- **Single-instance limitations** (in-memory board cache, rate limits,
  WS rooms) are deliberate and documented in `docs/design-doc.md`.

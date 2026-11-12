# Design Doc — Hack4Hack Team Formation (PS1)

**Problem.** 10,000 participants form teams of 2–4 for one hackathon: invite codes,
leader-approved join requests, a live "looking for teammates" board. One team per
person per hackathon. The defining requirement is correctness under concurrency: 50
people racing for the last seat, exactly one wins — true by construction, with
the database, not application code, as the final arbiter.

## Data model

```
users ──< team_members >── teams ──< join_requests
  │            (pk team_id,user_id;  (status: pending/
  │             unique hackathon_id,   accepted/declined;
  │             user_id)               partial unique on
  └─ sessions    teams: leader_id,     pending)
     (opaque     invite_code unique,
      tokens)    invite_expires_at
hackathons (team_min_size 2, team_max_size 4)
audit_log (every team mutation) · idempotency_keys (pk key,user_id)
```

Team size rules live on the `hackathon` row, so a future event can change 2–4 without
a deploy. `team_members` carries `hackathon_id` redundantly so the one-team
rule is one unique index.

## How races are prevented

One mechanism, used identically by join-by-code and accept-request: a Postgres
transaction that locks the team row with `SELECT ... FOR UPDATE`, then counts current
members **inside** the transaction. The lock serialises all joins to the same team, so
the count cannot be stale and the 409 is decided on true data.
Different teams lock different rows, so contention is per-team, never global.

Two backstops sit behind the lock. The unique index on
`team_members(hackathon_id, user_id)` makes a second team
impossible even if application logic slipped — the database refuses the insert.
Idempotency keys (on `POST /api/teams`, `/join`, `/requests`, `/invite/regenerate`)
make retries safe: a retry replays the stored response, and the
`(key, user_id)` unique constraint makes concurrent retries safe too. The race
is proven, not asserted: an automated test fires 50 concurrent joins at the last
seat and asserts exactly one succeeds.

## Trade-offs (deliberate)

**Postgres is the only source of truth for seats — no Redis.** A cache of the seat
count is a second count, and two counts drift. The cost is one indexed query per
join; at this scale that is cheap, and correctness is the judged criterion. Board
speed instead comes from an in-memory cache of the board per hackathon,
invalidated on *every* team mutation — correct by construction, since the cache
only changes when the data does — plus pagination (default 50 + 50; the
unpaginated 1.3 MB board missed the p95 target 10×). The default page's
JSON + gzip bytes are pre-built at invalidation, and the hackathon row is
cached 60 s. The honest price: cache,
rate limits, and WebSocket rooms are in-process, so this build is single-instance.
Scaling out means Redis pub/sub plus a shared store — a known, bounded change,
not a redesign.

**Opaque sessions, not JWT.** Session tokens are `crypto.randomBytes(32)`, stored
as a SHA-256 hash, sent as an httpOnly cookie. They are revokable (delete the row);
a JWT would add expiry and key management for zero benefit here. Passwords are hashed with `node:crypto` scrypt — zero new
dependencies.

**One container, server serves the client.** A single deployable unit removes
CORS, proxy, and version-skew bugs, and matches the single-instance constraint
honestly. Dev keeps Vite on 5173 proxying `/api` and `/ws` to the server on 3000.

**Invite codes are 8 characters from a 32-symbol alphabet (~40 bits), expiring in 7 days.** Short enough for
humans to type, long enough that brute force is infeasible at 5 attempts per IP
per 10 minutes. The rate limit, not the alphabet, is the real defence.

## Teammate suggestions

`GET /api/users/me/suggestions` scores only users with `looking_for_teammates`
set, as `score = skillComplement + timezone + base` (max 80). `skillComplement`
is 10 points per skill they have that I lack, capped at 50 — complementary
skills are what a team needs. `timezone` is `max(0, 20 − 2 × |Δhours|)`. `base` is a flat 10; ties break by earliest creation.
The API returns the breakdown, so the ranking is auditable.
*Assumption: these weights are this doc's decision — backend implements them as
written, or updates this doc.*

## With one more week

Multi-instance support first (Redis pub/sub, shared cache and rate limits), then
email verification and password reset — in that order. What would *not* change:
Postgres as the seat authority, and the lock-then-count join path.

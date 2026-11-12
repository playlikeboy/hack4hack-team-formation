# Hack4Hack client

Vite + React + TypeScript + Tailwind CSS. No component library — hand-rolled,
explainable components. The API contract lives in `../contract.md` (repo root
docs) and is mirrored in `src/lib/api.ts`.

## Run

```bash
npm install
npm run dev      # http://localhost:5173 — proxies /api and /ws to the backend on :3000
npm run build    # typecheck (tsc) + production build into dist/
npm run preview  # serve the production build locally
```

The backend must be running on `http://localhost:3000` for the dev server to
do anything useful. In production the server serves the built client
statically, so all API calls are same-origin.

## Routes

| Route | Page |
| --- | --- |
| `/` | Board — live team list + seekers (public, WebSocket updates) |
| `/login`, `/register` | Auth (cookie session) |
| `/teams/new` | Create a team |
| `/teams/:id` | Team page — members, invite code, requests, audit log, live updates |
| `/teams/join?code=XXXX&team=<id>` | Join by invite code (code alone also works — pick the team in the form) |
| `/suggestions` | Teammate suggestions with score breakdown |

## Notes

- Auth is an httpOnly cookie session; the client never sees a token.
- Mutations marked idempotent in the contract send a fresh `Idempotency-Key`
  per submit (see `src/lib/api.ts`).
- Live updates: one WebSocket (`/ws`), rooms `board:<hackathonId>` and
  `team:<teamId>`. On any event the page refetches — the server stays the
  source of truth. See `src/lib/ws.ts`.
- The join endpoint needs a team id (`POST /api/teams/:id/join`), so invite
  links carry both the code and the team id; the join form also lets a user
  pick a team from the board when they only have a code.

// One shared pg Pool for the whole server. The pool is the only way the
// app talks to Postgres — Postgres is the single source of truth for seats
// and membership, so every query goes through here.
//
// Local dev uses trust auth on localhost (no password in any config):
//   DATABASE_URL=postgres://postgres@localhost:5432/hack4hack
// Production sets DATABASE_URL as a hosting secret (never written down).

import { Pool } from 'pg'

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/hack4hack',
  // 20 connections is plenty for a single instance: joins are short
  // transactions, and the board is served from the in-memory cache.
  max: 20,
})

pool.on('error', (err) => {
  // A pool-level error (e.g. the DB restarted) must not crash the process
  // silently — log it loudly; individual requests still get their own error.
  console.error('[db] pool error:', err)
})

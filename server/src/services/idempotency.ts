// Idempotency for the four retryable mutations (POST /api/teams, /join,
// /requests, /invite/regenerate). A client that retries — double-click,
// dropped connection, impatient refresh — sends the same Idempotency-Key
// and gets the stored response replayed instead of a duplicate effect.
//
// How concurrent retries stay safe: the whole check–execute–store runs in
// ONE transaction holding a Postgres advisory lock scoped to (key, user).
// Two requests with the same key serialise on the lock; the second one
// finds the first one's stored response and replays it. The unique
// constraint on (key, user_id) is the backstop, not the mechanism.
//
// A key reused with a DIFFERENT body is a client bug, not a retry —
// that is a 409, never a silent replay of the wrong response.

import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { conflict } from '../lib/errors'
import type { IdempotentResult } from './transaction'
import { withTransaction } from './transaction'

export async function withIdempotency<T>(opts: {
  key: string | undefined
  userId: string
  endpoint: string
  body: unknown
  handler: (client: PoolClient) => Promise<IdempotentResult<T>>
}): Promise<{ status: number; body: T }> {
  const { key, userId, endpoint, body, handler } = opts
  const requestHash = createHash('sha256')
    .update(endpoint)
    .update('\n')
    .update(JSON.stringify(body ?? null))
    .digest('hex')

  return withTransaction(async (client) => {
    if (key) {
      // Serialise all requests carrying this key for this user.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${userId}:${key}`,
      ])
      const { rows } = await client.query(
        `SELECT request_hash, response_status, response_body
         FROM idempotency_keys WHERE key = $1 AND user_id = $2`,
        [key, userId],
      )
      if (rows.length > 0) {
        const stored = rows[0]
        if (stored.request_hash !== requestHash) {
          throw conflict(
            'idempotency_key_reused',
            'This Idempotency-Key was already used with a different request body.',
          )
        }
        return {
          result: {
            status: Number(stored.response_status),
            body: stored.response_body as T,
          },
        }
      }
    }

    const result = await handler(client)

    if (key) {
      await client.query(
        `INSERT INTO idempotency_keys
           (key, user_id, endpoint, request_hash, response_status, response_body)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [key, userId, endpoint, requestHash, result.status, JSON.stringify(result.body)],
      )
    }

    return {
      result: { status: result.status, body: result.body },
      afterCommit: result.afterCommit,
    }
  })
}

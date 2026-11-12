// One database transaction around a unit of work. The handler returns its
// result plus optional afterCommit effects (WebSocket broadcasts, cache
// invalidation) that run only after COMMIT — never inside the transaction,
// where a rollback would leave the outside world believing something
// happened that did not.

import type { PoolClient } from 'pg'
import { pool } from '../db/pool'

export interface IdempotentResult<T> {
  status: number
  body: T
  /**
   * Side effects that must only happen if the transaction commits
   * (WebSocket broadcasts, cache invalidation). Runs after COMMIT.
   */
  afterCommit?: () => void
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<{
    result: T
    afterCommit?: () => void
  }>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { result, afterCommit } = await fn(client)
    await client.query('COMMIT')
    afterCommit?.()
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // The connection may already be dead; the pool will discard it.
    })
    throw err
  } finally {
    client.release()
  }
}

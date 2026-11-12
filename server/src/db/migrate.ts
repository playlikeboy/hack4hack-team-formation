// Applies schema.sql on boot. The schema is idempotent (CREATE TABLE IF NOT
// EXISTS, ON CONFLICT DO NOTHING for the seed row), so running it on every
// start is safe — and it means a fresh deploy works without a manual
// migration step. `npm run build` copies schema.sql into dist/db/ so this
// resolves the same way in dev (src/) and production (dist/).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pool } from './pool'

export async function migrate(): Promise<void> {
  const schemaPath = path.join(__dirname, 'schema.sql')
  const sql = readFileSync(schemaPath, 'utf8')
  await pool.query(sql)
}

// Entry point: apply the schema, then serve HTTP + WebSockets on one
// port. The WS hub attaches to the same HTTP server, so /ws shares the
// port (and the origin) with the API — no second port, no CORS.

import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { migrate } from './db/migrate'
import { pool } from './db/pool'
import { attachHub } from './ws/hub'

const PORT = Number(process.env.PORT ?? 3000)

async function main(): Promise<void> {
  // The schema is idempotent, so applying it on every boot is safe —
  // a fresh deploy works without a manual migration step.
  await migrate()

  const app = createApp()
  const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[server] listening on http://localhost:${info.port}`)
  })
  // serve()'s return type is a union (HTTP/1.1 + HTTP/2 servers); we run
  // plain HTTP/1.1, so narrow it for the WS hub, which needs an http.Server.
  attachHub(server as Server)

  const shutdown = async () => {
    console.log('[server] shutting down…')
    server.close()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

main().catch((err: unknown) => {
  console.error('[server] failed to start:', err)
  process.exit(1)
})

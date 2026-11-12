// The Hono app: routes, error shape, static client. Kept separate from
// index.ts (which boots the server) so tests can import createApp() and
// hit the API without starting a listener.

import { Hono } from 'hono'
import { compress } from 'hono/compress'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ApiError } from './lib/errors'
import type { AppEnv } from './lib/env'
import { serveClient } from './lib/static'
import { authRoutes } from './routes/auth'
import { hackathonRoutes } from './routes/hackathons'
import { teamRoutes } from './routes/teams'
import { userRoutes } from './routes/users'

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // gzip for JSON responses (the board serves small paginated pages, so
  // per-request compression is cheap — see services/board.ts).
  app.use(compress())

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(
        { error: { code: err.code, message: err.message } },
        err.status as ContentfulStatusCode,
      )
    }
    // Anything else is a bug, not a client error — log it loudly and
    // answer 500 without leaking internals to the client.
    console.error('[api] unhandled error:', err)
    return c.json(
      { error: { code: 'internal_error', message: 'Something went wrong.' } },
      500,
    )
  })

  app.notFound((c) =>
    c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404),
  )

  // Health check for the container orchestrator / load balancer. No auth,
  // no database — it answers "is the process up", nothing more.
  app.get('/api/health', (c) => c.json({ ok: true, time: new Date().toISOString() }))

  app.route('/api/auth', authRoutes)
  app.route('/api/hackathons', hackathonRoutes)
  app.route('/api/teams', teamRoutes)
  app.route('/api/users', userRoutes)

  // The built client (production) + SPA fallback. API paths never reach
  // here — serveClient returns null for them and the 404 below applies.
  app.get('*', (c) => {
    return serveClient(c) ?? c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
  })

  return app
}

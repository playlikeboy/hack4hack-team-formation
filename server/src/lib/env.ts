// Shared Hono environment: every route can read the current user (or null
// for public routes) from context after the auth middleware runs.

import type { PublicUser } from './serialize'

export interface AppEnv {
  Variables: {
    user: PublicUser | null
  }
}

// Teammate suggestions for the signed-in user. The formula lives in
// services/suggestions.ts (and docs/design-doc.md); this route only
// authenticates and passes the optional ?hackathonId= through.

import { Hono } from 'hono'
import { z } from 'zod'
import { badRequest } from '../lib/errors'
import type { AppEnv } from '../lib/env'
import { currentUser, requireAuth } from '../services/auth'
import { getSuggestions } from '../services/suggestions'

export const userRoutes = new Hono<AppEnv>()

userRoutes.get('/me/suggestions', requireAuth, async (c) => {
  const hackathonId = c.req.query('hackathonId')
  if (hackathonId && !z.string().uuid().safeParse(hackathonId).success) {
    throw badRequest('validation_error', 'hackathonId: expected a valid id.')
  }
  return c.json(await getSuggestions(currentUser(c).id, hackathonId))
})

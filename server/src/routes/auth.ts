// Auth: register / login / logout / me. Email + password, scrypt-hashed;
// sessions are opaque tokens in an httpOnly cookie (see services/auth.ts).

import { getCookie } from 'hono/cookie'
import { Hono } from 'hono'
import { pool } from '../db/pool'
import { hashPassword, verifyPassword } from '../lib/crypto'
import {
  badRequest,
  conflict,
  isUniqueViolation,
  tooManyRequests,
  unauthorized,
} from '../lib/errors'
import { loginSchema, parseBody, registerSchema } from '../lib/validation'
import { userPublic } from '../lib/serialize'
import type { AppEnv } from '../lib/env'
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSession,
  currentUser,
  deleteSession,
  requireAuth,
  setSessionCookie,
} from '../services/auth'
import { checkRateLimit, clientIp } from '../services/rateLimit'

export const authRoutes = new Hono<AppEnv>()

authRoutes.post('/register', async (c) => {
  const input = await parseBody(c.req.raw, registerSchema)

  if (input.timezone) {
    // Reject unknown timezone names at registration — a typo here would
    // silently score 0 on timezone overlap in suggestions forever.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: input.timezone })
    } catch {
      throw badRequest('validation_error', 'timezone: not a known timezone name.')
    }
  }

  const passwordHash = await hashPassword(input.password)
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, skills, timezone, bio)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.email,
        passwordHash,
        input.name,
        input.skills ?? [],
        input.timezone ?? 'UTC',
        input.bio ?? '',
      ],
    )
    const user = userPublic(rows[0])
    setSessionCookie(c, await createSession(user.id))
    return c.json({ user }, 201)
  } catch (err) {
    // citext makes the email check case-insensitive: Foo@x and foo@x are
    // the same account, so the unique index is the arbiter.
    if (isUniqueViolation(err, 'users_email_key')) {
      throw conflict('email_taken', 'An account with this email already exists.')
    }
    throw err
  }
})

authRoutes.post('/login', async (c) => {
  // Rate-limited BEFORE any credential check: the limit is what makes
  // password guessing infeasible, so it must count failed logins too.
  if (!checkRateLimit(`login:${clientIp(c)}`, 10, 60 * 1000)) {
    throw tooManyRequests('Too many login attempts. Try again in a minute.')
  }

  const input = await parseBody(c.req.raw, loginSchema)
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [
    input.email,
  ])
  const row = rows[0]
  // One message for "no such email" and "wrong password": distinguishing
  // them would let anyone enumerate registered emails.
  if (!row || !(await verifyPassword(input.password, String(row.password_hash)))) {
    throw unauthorized('Invalid email or password.')
  }

  const user = userPublic(row)
  setSessionCookie(c, await createSession(user.id))
  return c.json({ user })
})

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) await deleteSession(token)
  clearSessionCookie(c)
  return c.json({ ok: true })
})

authRoutes.get('/me', requireAuth, async (c) => {
  return c.json({ user: currentUser(c) })
})

// Sessions: opaque tokens in an httpOnly cookie (see docs/design-doc.md
// for why not JWT — revokable, no client-side expiry, no key management).
//
// The cookie carries the raw token; the database stores only its SHA-256
// hash. Stealing the database does not steal live sessions, and logging
// out is just deleting a row.

import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { pool } from '../db/pool'
import { hashToken, newSessionToken } from '../lib/crypto'
import { unauthorized } from '../lib/errors'
import { userPublic, type PublicUser } from '../lib/serialize'
import type { AppEnv } from '../lib/env'

export const SESSION_COOKIE = 'session'
const SESSION_TTL_DAYS = 30

function cookieSecure(): boolean {
  // Secure cookies only travel over HTTPS. Local dev is plain HTTP, so
  // this stays off unless explicitly enabled or NODE_ENV is production.
  return (
    process.env.SESSION_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production'
  )
}

/** Create a session row and return the raw token (sent once, as a cookie). */
export async function createSession(userId: string): Promise<string> {
  const token = newSessionToken()
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [userId, hashToken(token), String(SESSION_TTL_DAYS)],
  )
  return token
}

/** Resolve a raw token to its user, or null (unknown token or expired). */
export async function lookupSessionUser(token: string): Promise<PublicUser | null> {
  const { rows } = await pool.query(
    `SELECT u.*
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  )
  if (rows.length === 0) {
    // Opportunistic cleanup: an expired session row is dead weight.
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)])
    return null
  }
  return userPublic(rows[0])
}

export async function deleteSession(token: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)])
}

export function setSessionCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, // JavaScript cannot read it — XSS cannot steal the session.
    sameSite: 'Lax', // Sent on top-level navigation, not on cross-site POSTs.
    secure: cookieSecure(),
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  })
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

/** Require a valid session; 401 otherwise. Public routes skip this. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE)
  const user = token ? await lookupSessionUser(token) : null
  if (!user) throw unauthorized()
  c.set('user', user)
  await next()
})

/**
 * Best-effort auth for public routes that personalise when signed in
 * (GET /api/teams/:id shows requests to the leader, the invite code to
 * members). Never 401s — an absent or invalid session just means "guest".
 */
export const optionalAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE)
  c.set('user', token ? await lookupSessionUser(token) : null)
  await next()
})

/** The authenticated user, after requireAuth has run. */
export function currentUser(c: { get: (key: 'user') => PublicUser | null }): PublicUser {
  const user = c.get('user')
  if (!user) throw unauthorized()
  return user
}

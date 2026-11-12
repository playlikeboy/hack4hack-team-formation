import { describe, expect, test } from 'vitest'
import {
  api,
  getHackathonId,
  newPassword,
  registerUser,
  uniqueEmail,
} from './helpers'

describe('auth', () => {
  test('register returns 201 with the user and no password hash', async () => {
    const session = await registerUser({ name: 'Ada Lovelace', skills: ['typescript'] })
    expect(session.user.id).toBeTruthy()
    expect(session.user.email).toContain('@example.com')
    expect(session.user.name).toBe('Ada Lovelace')
    expect(session.user.skills).toEqual(['typescript'])
    expect(session.user).not.toHaveProperty('passwordHash')
    expect(session.user).not.toHaveProperty('password_hash')
  })

  test('register with a duplicate email is rejected', async () => {
    const first = await registerUser()
    const res = await api('/api/auth/register', {
      method: 'POST',
      body: { email: first.user.email, password: newPassword(), name: 'Copy Cat' },
    })
    expect([400, 409]).toContain(res.status)
    expect(res.body?.error?.code).toBeTruthy()
  })

  test('register with invalid input returns 400', async () => {
    const badEmail = await api('/api/auth/register', {
      method: 'POST',
      body: { email: 'not-an-email', password: newPassword(), name: 'Bad' },
    })
    expect(badEmail.status).toBe(400)
    const missingName = await api('/api/auth/register', {
      method: 'POST',
      body: { email: uniqueEmail('noname'), password: newPassword() },
    })
    expect(missingName.status).toBe(400)
    const missingPassword = await api('/api/auth/register', {
      method: 'POST',
      body: { email: uniqueEmail('nopass'), name: 'No Pass' },
    })
    expect(missingPassword.status).toBe(400)
  })

  test('login succeeds with correct credentials and sets a session cookie', async () => {
    const session = await registerUser()
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { email: session.user.email, password: session.password },
      headers: { 'X-Forwarded-For': session.ip },
    })
    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe(session.user.id)
    expect(res.headers.getSetCookie().length).toBeGreaterThan(0)
  })

  test('login with the wrong password returns 401', async () => {
    const session = await registerUser()
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { email: session.user.email, password: newPassword() },
    })
    expect(res.status).toBe(401)
  })

  test('me returns the current user when authenticated, 401 without a session', async () => {
    const session = await registerUser()
    const authed = await api('/api/auth/me', { session })
    expect(authed.status).toBe(200)
    expect(authed.body.user.id).toBe(session.user.id)
    const anon = await api('/api/auth/me')
    expect(anon.status).toBe(401)
  })

  test('logout revokes the session', async () => {
    const session = await registerUser()
    const out = await api('/api/auth/logout', { method: 'POST', session })
    expect(out.status).toBe(200)
    const after = await api('/api/auth/me', { session })
    expect(after.status).toBe(401)
  })

  test('unauthenticated team creation returns 401', async () => {
    const hackathonId = await getHackathonId()
    const res = await api('/api/teams', {
      method: 'POST',
      body: { hackathonId, name: 'NoAuth Team' },
    })
    expect(res.status).toBe(401)
  })

  test('unauthenticated suggestions request returns 401', async () => {
    const res = await api('/api/users/me/suggestions')
    expect(res.status).toBe(401)
  })

  test('hackathons list contains the seeded Hack4Hack 2026', async () => {
    const res = await api('/api/hackathons')
    expect(res.status).toBe(200)
    const list = Array.isArray(res.body) ? res.body : res.body.hackathons
    const hack = list.find((h: any) => h.name === 'Hack4Hack 2026')
    expect(hack).toBeTruthy()
    expect(hack.teamMaxSize).toBe(4)
    expect(hack.teamMinSize).toBe(2)
  })
})

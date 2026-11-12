import { describe, expect, test } from 'vitest'
import {
  api,
  createTeam,
  getTeam,
  joinTeam,
  registerUser,
  uniqueName,
} from './helpers'

describe('audit log', () => {
  test('team mutations write audit rows', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('audit-mutations'))
    const member = await registerUser()
    expect((await joinTeam(member, team.id, team.inviteCode!)).status).toBe(200)
    const res = await api(`/api/teams/${team.id}/audit`, { session: leader })
    expect(res.status).toBe(200)
    const entries = Array.isArray(res.body) ? res.body : res.body.auditLog
    // At least one row per mutation (create + join).
    expect(entries.length).toBeGreaterThanOrEqual(2)
    for (const e of entries) {
      expect(typeof e.action).toBe('string')
      expect(e.action.length).toBeGreaterThan(0)
      expect(e.actorId).toBeTruthy()
      expect(e.createdAt).toBeTruthy()
    }
    const actors = new Set(entries.map((e: any) => e.actorId))
    expect(actors.has(leader.user.id)).toBe(true)
    expect(actors.has(member.user.id)).toBe(true)
  })

  test('audit endpoint is member-only', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('audit-guarded'))
    const outsider = await registerUser()
    const res = await api(`/api/teams/${team.id}/audit`, { session: outsider })
    expect(res.status).toBe(403)
  })

  test('team detail includes the audit log, newest first', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('audit-detail'))
    const member = await registerUser()
    expect((await joinTeam(member, team.id, team.inviteCode!)).status).toBe(200)
    const detail = await getTeam(leader, team.id)
    expect(detail.auditLog.length).toBeGreaterThanOrEqual(2)
    const times = detail.auditLog.map((e: any) => new Date(e.createdAt).getTime())
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1])
    }
  })
})

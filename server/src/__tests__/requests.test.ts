import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  api,
  createTeam,
  getTeam,
  joinTeam,
  registerUser,
  uniqueName,
} from './helpers'

describe('join requests', () => {
  test('requesting to join creates a pending request', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('req-create'))
    const asker = await registerUser()
    const res = await api(`/api/teams/${team.id}/requests`, {
      method: 'POST',
      body: { message: 'I do frontend' },
      session: asker,
      idempotencyKey: randomUUID(),
    })
    expect(res.status).toBe(201)
    expect(res.body.request.status).toBe('pending')
    expect(res.body.request.teamId).toBe(team.id)
    expect(res.body.request.userId).toBe(asker.user.id)
  })

  test('a second pending request to the same team returns 4xx', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('req-dup'))
    const asker = await registerUser()
    const first = await api(`/api/teams/${team.id}/requests`, {
      method: 'POST',
      body: { message: 'first' },
      session: asker,
      idempotencyKey: randomUUID(),
    })
    expect(first.status).toBe(201)
    // Fresh key: a genuinely new request, not an idempotency replay.
    const second = await api(`/api/teams/${team.id}/requests`, {
      method: 'POST',
      body: { message: 'second' },
      session: asker,
      idempotencyKey: randomUUID(),
    })
    expect(second.status).toBeGreaterThanOrEqual(400)
    expect(second.status).toBeLessThan(500)
  })

  test('the leader sees pending requests; a non-leader member does not', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('req-visibility'))
    const member = await registerUser()
    expect((await joinTeam(member, team.id, team.inviteCode!)).status).toBe(200)
    const asker = await registerUser()
    const req = await api(`/api/teams/${team.id}/requests`, {
      method: 'POST',
      body: { message: 'please let me in' },
      session: asker,
      idempotencyKey: randomUUID(),
    })
    expect(req.status).toBe(201)
    const asLeader = await getTeam(leader, team.id)
    expect(asLeader.joinRequests).toHaveLength(1)
    expect(asLeader.joinRequests[0].userId).toBe(asker.user.id)
    const asMember = await getTeam(member, team.id)
    expect(asMember.joinRequests).toHaveLength(0)
  })

  test('leader accepting a request adds the user as a member', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('req-accept'))
    const asker = await registerUser()
    const req = await api(`/api/teams/${team.id}/requests`, {
      method: 'POST',
      body: { message: 'hi' },
      session: asker,
      idempotencyKey: randomUUID(),
    })
    expect(req.status).toBe(201)
    const accept = await api(
      `/api/teams/${team.id}/requests/${req.body.request.id}/accept`,
      { method: 'POST', session: leader },
    )
    expect(accept.status).toBe(200)
    const detail = await getTeam(leader, team.id)
    expect(detail.members.map((m: any) => m.id)).toContain(asker.user.id)
  })

  test('leader declining keeps the user out, and the user can request again', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('req-decline'))
    const asker = await registerUser()
    const req = await api(`/api/teams/${team.id}/requests`, {
      method: 'POST',
      body: { message: 'hi' },
      session: asker,
      idempotencyKey: randomUUID(),
    })
    expect(req.status).toBe(201)
    const decline = await api(
      `/api/teams/${team.id}/requests/${req.body.request.id}/decline`,
      { method: 'POST', session: leader },
    )
    expect(decline.status).toBe(200)
    const detail = await getTeam(leader, team.id)
    expect(detail.members.map((m: any) => m.id)).not.toContain(asker.user.id)
    // A declined request is no longer pending, so a fresh request is allowed.
    const again = await api(`/api/teams/${team.id}/requests`, {
      method: 'POST',
      body: { message: 'second try' },
      session: asker,
      idempotencyKey: randomUUID(),
    })
    expect(again.status).toBe(201)
  })

  test('non-leader accept returns 403', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('req-accept-403'))
    const member = await registerUser()
    expect((await joinTeam(member, team.id, team.inviteCode!)).status).toBe(200)
    const asker = await registerUser()
    const req = await api(`/api/teams/${team.id}/requests`, {
      method: 'POST',
      body: { message: 'hi' },
      session: asker,
      idempotencyKey: randomUUID(),
    })
    expect(req.status).toBe(201)
    const accept = await api(
      `/api/teams/${team.id}/requests/${req.body.request.id}/accept`,
      { method: 'POST', session: member },
    )
    expect(accept.status).toBe(403)
  })

  test('non-leader decline returns 403', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('req-decline-403'))
    const member = await registerUser()
    expect((await joinTeam(member, team.id, team.inviteCode!)).status).toBe(200)
    const asker = await registerUser()
    const req = await api(`/api/teams/${team.id}/requests`, {
      method: 'POST',
      body: { message: 'hi' },
      session: asker,
      idempotencyKey: randomUUID(),
    })
    expect(req.status).toBe(201)
    const decline = await api(
      `/api/teams/${team.id}/requests/${req.body.request.id}/decline`,
      { method: 'POST', session: member },
    )
    expect(decline.status).toBe(403)
  })

  test('accepting a request when the team filled meanwhile returns 409', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('accept-race'))
    // Fill to 3 of 4.
    for (let i = 0; i < 2; i++) {
      const m = await registerUser()
      expect((await joinTeam(m, team.id, team.inviteCode!)).status).toBe(200)
    }
    const asker = await registerUser()
    const req = await api(`/api/teams/${team.id}/requests`, {
      method: 'POST',
      body: { message: 'hi' },
      session: asker,
      idempotencyKey: randomUUID(),
    })
    expect(req.status).toBe(201)
    // The last seat goes to someone else before the leader decides.
    const filler = await registerUser()
    expect((await joinTeam(filler, team.id, team.inviteCode!)).status).toBe(200)
    const accept = await api(
      `/api/teams/${team.id}/requests/${req.body.request.id}/accept`,
      { method: 'POST', session: leader },
    )
    expect(accept.status).toBe(409)
    const detail = await getTeam(leader, team.id)
    expect(detail.members).toHaveLength(4)
    expect(detail.members.map((m: any) => m.id)).not.toContain(asker.user.id)
  })
})

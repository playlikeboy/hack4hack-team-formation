import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  api,
  createTeam,
  expireInviteCode,
  getBoard,
  getHackathonId,
  getTeam,
  joinTeam,
  registerUser,
  uniqueName,
} from './helpers'

describe('teams', () => {
  test('creating a team makes the creator leader and first member', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('alpha'))
    expect(team.leaderId).toBe(leader.user.id)
    expect(team.inviteCode).toBeTruthy()
    // 8 chars from the unambiguous alphabet: no 0/O/1/I/l.
    expect(team.inviteCode).toMatch(/^[A-Za-z0-9]{8}$/)
    expect(team.inviteCode).not.toMatch(/[0O1Il]/)
    const detail = await getTeam(leader, team.id)
    expect(detail.members).toHaveLength(1)
    expect(detail.members[0].id).toBe(leader.user.id)
  })

  test('creating a second team in the same hackathon returns 409', async () => {
    const user = await registerUser()
    await createTeam(user, uniqueName('first'))
    const hackathonId = await getHackathonId()
    const res = await api('/api/teams', {
      method: 'POST',
      body: { hackathonId, name: uniqueName('second') },
      session: user,
      idempotencyKey: randomUUID(),
    })
    expect(res.status).toBe(409)
  })

  test('creating a team with invalid input returns 400', async () => {
    const user = await registerUser()
    const hackathonId = await getHackathonId()
    const noName = await api('/api/teams', {
      method: 'POST',
      body: { hackathonId },
      session: user,
    })
    expect(noName.status).toBe(400)
    const noHackathon = await api('/api/teams', {
      method: 'POST',
      body: { name: uniqueName('no-hack') },
      session: user,
    })
    expect(noHackathon.status).toBe(400)
  })

  test('join by invite code adds the member', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('join-ok'))
    const member = await registerUser()
    const res = await joinTeam(member, team.id, team.inviteCode!)
    expect(res.status).toBe(200)
    expect(res.body.team.id).toBe(team.id)
    const detail = await getTeam(leader, team.id)
    expect(detail.members).toHaveLength(2)
    expect(detail.members.map((m: any) => m.id)).toContain(member.user.id)
  })

  test('join with the wrong invite code returns 4xx and adds nobody', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('join-wrong'))
    const member = await registerUser()
    const res = await joinTeam(member, team.id, 'XXXXXXXX')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    const detail = await getTeam(leader, team.id)
    expect(detail.members).toHaveLength(1)
  })

  test('join with an expired invite code returns 4xx', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('join-expired'))
    await expireInviteCode(team.id)
    const member = await registerUser()
    const res = await joinTeam(member, team.id, team.inviteCode!)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test('joining a full team returns 409', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('join-full'))
    for (let i = 0; i < 3; i++) {
      const m = await registerUser()
      expect((await joinTeam(m, team.id, team.inviteCode!)).status).toBe(200)
    }
    const fifth = await registerUser()
    const res = await joinTeam(fifth, team.id, team.inviteCode!)
    expect(res.status).toBe(409)
    const detail = await getTeam(leader, team.id)
    expect(detail.members).toHaveLength(4)
  })

  test('joining a second team while already in one returns 409', async () => {
    const leaderA = await registerUser()
    const teamA = await createTeam(leaderA, uniqueName('team-a'))
    const leaderB = await registerUser()
    const teamB = await createTeam(leaderB, uniqueName('team-b'))
    const member = await registerUser()
    expect((await joinTeam(member, teamA.id, teamA.inviteCode!)).status).toBe(200)
    const res = await joinTeam(member, teamB.id, teamB.inviteCode!)
    expect(res.status).toBe(409)
  })

  test('joining the same team twice returns 409', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('join-twice'))
    const member = await registerUser()
    expect((await joinTeam(member, team.id, team.inviteCode!)).status).toBe(200)
    // Fresh idempotency key: this is a genuinely new join, not a replay.
    const res = await joinTeam(member, team.id, team.inviteCode!)
    expect(res.status).toBe(409)
  })

  test('leader leaving passes leadership to the earliest-joined member', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('handover'))
    const second = await registerUser()
    expect((await joinTeam(second, team.id, team.inviteCode!)).status).toBe(200)
    const third = await registerUser()
    expect((await joinTeam(third, team.id, team.inviteCode!)).status).toBe(200)
    const res = await api(`/api/teams/${team.id}/leave`, { method: 'POST', session: leader })
    expect(res.status).toBe(200)
    const detail = await getTeam(second, team.id)
    expect(detail.team.leaderId).toBe(second.user.id)
    expect(detail.members.map((m: any) => m.id).sort()).toEqual(
      [second.user.id, third.user.id].sort(),
    )
  })

  test('the last member leaving deletes the team', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('last-out'))
    const res = await api(`/api/teams/${team.id}/leave`, { method: 'POST', session: leader })
    expect(res.status).toBe(200)
    const gone = await api(`/api/teams/${team.id}`, { session: leader })
    expect(gone.status).toBe(404)
    const board = await getBoard(await getHackathonId())
    expect(board.teams.map((t: any) => t.id)).not.toContain(team.id)
  })

  test('leader can remove a member, who can then join another team', async () => {
    const leaderA = await registerUser()
    const teamA = await createTeam(leaderA, uniqueName('remove-a'))
    const member = await registerUser()
    expect((await joinTeam(member, teamA.id, teamA.inviteCode!)).status).toBe(200)
    const removed = await api(`/api/teams/${teamA.id}/remove`, {
      method: 'POST',
      body: { userId: member.user.id },
      session: leaderA,
    })
    expect(removed.status).toBe(200)
    const detail = await getTeam(leaderA, teamA.id)
    expect(detail.members.map((m: any) => m.id)).not.toContain(member.user.id)
    const leaderB = await registerUser()
    const teamB = await createTeam(leaderB, uniqueName('remove-b'))
    expect((await joinTeam(member, teamB.id, teamB.inviteCode!)).status).toBe(200)
  })

  test('leader cannot remove themself', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('remove-self'))
    const res = await api(`/api/teams/${team.id}/remove`, {
      method: 'POST',
      body: { userId: leader.user.id },
      session: leader,
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test('non-leader remove returns 403', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('remove-403'))
    const member = await registerUser()
    expect((await joinTeam(member, team.id, team.inviteCode!)).status).toBe(200)
    const other = await registerUser()
    expect((await joinTeam(other, team.id, team.inviteCode!)).status).toBe(200)
    const res = await api(`/api/teams/${team.id}/remove`, {
      method: 'POST',
      body: { userId: other.user.id },
      session: member,
    })
    expect(res.status).toBe(403)
  })

  test('non-leader invite regenerate returns 403', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('regen-403'))
    const member = await registerUser()
    expect((await joinTeam(member, team.id, team.inviteCode!)).status).toBe(200)
    const res = await api(`/api/teams/${team.id}/invite/regenerate`, {
      method: 'POST',
      session: member,
    })
    expect(res.status).toBe(403)
  })

  test('leader regenerating the invite code rotates it: old code dies, new code works', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('regen-ok'))
    const oldCode = team.inviteCode!
    const res = await api(`/api/teams/${team.id}/invite/regenerate`, {
      method: 'POST',
      session: leader,
      idempotencyKey: randomUUID(),
    })
    expect(res.status).toBe(200)
    expect(res.body.inviteCode).toBeTruthy()
    expect(res.body.inviteCode).not.toBe(oldCode)
    expect(res.body.expiresAt).toBeTruthy()
    const stale = await registerUser()
    const staleJoin = await joinTeam(stale, team.id, oldCode)
    expect(staleJoin.status).toBeGreaterThanOrEqual(400)
    expect(staleJoin.status).toBeLessThan(500)
    const fresh = await registerUser()
    expect((await joinTeam(fresh, team.id, res.body.inviteCode)).status).toBe(200)
  })

  test('fetching a nonexistent team returns 404', async () => {
    const user = await registerUser()
    const res = await api(`/api/teams/${randomUUID()}`, { session: user })
    expect(res.status).toBe(404)
  })
})

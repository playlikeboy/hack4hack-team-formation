// The race test is the point of PS1: 50 people racing for the last seat,
// exactly one wins. It runs against the real server over real HTTP with a
// real Postgres behind it — nothing is mocked, so a pass proves the
// transaction + row-lock path, not a simulation of it.
//
// Runnable on its own: `npm test -- race` (from server/).
import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  api,
  createTeam,
  getBoard,
  getHackathonId,
  getTeam,
  joinTeam,
  registerUser,
  uniqueName,
} from './helpers'

describe('race-proofing and idempotency', () => {
  test('race: 50 concurrent joins on the last seat — exactly one wins', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('race'))
    // Fill to 3 of 4: the leader plus two members.
    for (let i = 0; i < 2; i++) {
      const m = await registerUser()
      expect((await joinTeam(m, team.id, team.inviteCode!)).status).toBe(200)
    }
    // 50 fresh users, registered up front so the race measures the join path.
    const racers = await Promise.all(Array.from({ length: 50 }, () => registerUser()))
    // Fire all 50 joins at once. Each racer carries a distinct
    // X-Forwarded-For (see helpers.ts): 50 distinct users, 50 distinct IPs.
    const results = await Promise.all(
      racers.map((r) => joinTeam(r, team.id, team.inviteCode!)),
    )
    const byStatus = new Map<number, number>()
    for (const r of results) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1)
    const summary = [...byStatus.entries()].map(([s, n]) => `${n}x ${s}`).join(', ')
    const winners = results.filter((r) => r.status >= 200 && r.status < 300)
    const conflicts = results.filter((r) => r.status === 409)
    expect(
      winners,
      `expected exactly 1 winner, got ${winners.length} (statuses: ${summary})`,
    ).toHaveLength(1)
    expect(
      conflicts,
      `expected 49 conflicts, got ${conflicts.length} (statuses: ${summary})`,
    ).toHaveLength(49)
    // The database agrees: exactly 4 members, no duplicates.
    const detail = await getTeam(leader, team.id)
    expect(detail.members).toHaveLength(4)
    const ids = detail.members.map((m: any) => m.id)
    expect(new Set(ids).size).toBe(4)
  })

  test('idempotency: replaying team creation returns the same team, created once', async () => {
    const user = await registerUser()
    const hackathonId = await getHackathonId()
    const name = uniqueName('idem-create')
    const key = randomUUID()
    const first = await api('/api/teams', {
      method: 'POST',
      body: { hackathonId, name },
      session: user,
      idempotencyKey: key,
    })
    expect(first.status).toBe(201)
    // Without replay this would 409 (already in a team); the replay returns
    // the stored 201 with the same team id.
    const replay = await api('/api/teams', {
      method: 'POST',
      body: { hackathonId, name },
      session: user,
      idempotencyKey: key,
    })
    expect(replay.status).toBe(201)
    expect(replay.body.team.id).toBe(first.body.team.id)
    const board = await getBoard(hackathonId)
    expect(board.teams.filter((t: any) => t.name === name)).toHaveLength(1)
  })

  test('idempotency: replaying a join returns the same response with one membership', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('idem-join'))
    const member = await registerUser()
    const key = randomUUID()
    const first = await joinTeam(member, team.id, team.inviteCode!, key)
    expect(first.status).toBe(200)
    // Without replay this would 409 (already a member).
    const replay = await joinTeam(member, team.id, team.inviteCode!, key)
    expect(replay.status).toBe(200)
    expect(replay.body.team.id).toBe(team.id)
    const detail = await getTeam(leader, team.id)
    expect(detail.members.filter((m: any) => m.id === member.user.id)).toHaveLength(1)
  })

  test('idempotency: replaying an invite regenerate returns the same code', async () => {
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('idem-regen'))
    const key = randomUUID()
    const first = await api(`/api/teams/${team.id}/invite/regenerate`, {
      method: 'POST',
      session: leader,
      idempotencyKey: key,
    })
    expect(first.status).toBe(200)
    const replay = await api(`/api/teams/${team.id}/invite/regenerate`, {
      method: 'POST',
      session: leader,
      idempotencyKey: key,
    })
    expect(replay.status).toBe(200)
    expect(replay.body.inviteCode).toBe(first.body.inviteCode)
  })
})

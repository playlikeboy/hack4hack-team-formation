import { describe, expect, test } from 'vitest'
import {
  api,
  createTeam,
  getBoard,
  getHackathonId,
  registerUser,
  setLookingForTeammates,
  uniqueName,
} from './helpers'

describe('board and suggestions', () => {
  test('board is public and lists teams and seekers', async () => {
    const hackathonId = await getHackathonId()
    const leader = await registerUser({ name: 'Board Leader' })
    const team = await createTeam(leader, uniqueName('board-team'))
    const seeker = await registerUser({ name: 'Board Seeker', skills: ['go'] })
    // No auth — the board is the shop window.
    const board = await getBoard(hackathonId)
    const found = board.teams.find((t: any) => t.id === team.id)
    expect(found).toBeTruthy()
    expect(found.name).toBe(team.name)
    expect(found.memberCount).toBe(1)
    expect(found.maxSize).toBe(4)
    expect(found.members.map((m: any) => m.id)).toContain(leader.user.id)
    expect(board.seekers.map((s: any) => s.id)).toContain(seeker.user.id)
  })

  test('board reflects a newly created team immediately (cache invalidated on mutation)', async () => {
    const hackathonId = await getHackathonId()
    const before = await getBoard(hackathonId)
    const beforeIds = new Set(before.teams.map((t: any) => t.id))
    const leader = await registerUser()
    const team = await createTeam(leader, uniqueName('board-fresh'))
    const after = await getBoard(hackathonId)
    expect(after.teams.map((t: any) => t.id)).toContain(team.id)
    expect(after.teams.length).toBe(before.teams.length + 1)
    expect([...beforeIds].every((id) => after.teams.some((t: any) => t.id === id))).toBe(true)
  })

  test('suggestions are ranked by score with an auditable breakdown', async () => {
    // Formula (design doc): score = skillComplement + timezone + base.
    // skillComplement is 10 per skill they have that I lack (cap 50);
    // timezone is max(0, 20 − 2×|Δhours|); base is a flat 10.
    // Me: only React. High: five skills I lack, same timezone → 50+20+10 = 80.
    // Far: five skills I lack, New York (UTC−5 in November) → 50+10+10 = 70.
    // Low: one skill I lack, same timezone → 10+20+10 = 40.
    const me = await registerUser({ skills: ['react'], timezone: 'UTC' })
    const high = await registerUser({
      skills: ['python', 'go', 'rust', 'docker', 'kubernetes'],
      timezone: 'UTC',
    })
    const far = await registerUser({
      skills: ['python', 'go', 'rust', 'docker', 'kubernetes'],
      timezone: 'America/New_York',
    })
    const low = await registerUser({ skills: ['python'], timezone: 'UTC' })
    const res = await api('/api/users/me/suggestions', { session: me })
    expect(res.status).toBe(200)
    const list = Array.isArray(res.body) ? res.body : res.body.suggestions
    const mine = list.filter((s: any) =>
      [high.user.id, far.user.id, low.user.id].includes(s.user.id),
    )
    expect(mine).toHaveLength(3)
    // Ranked best first.
    expect(mine.map((s: any) => s.user.id)).toEqual([high.user.id, far.user.id, low.user.id])
    // Every breakdown adds up to its score.
    for (const s of mine) {
      expect(s.breakdown).toBeTruthy()
      expect(typeof s.breakdown.skillComplement).toBe('number')
      expect(typeof s.breakdown.timezone).toBe('number')
      expect(typeof s.breakdown.base).toBe('number')
      expect(s.score).toBe(
        s.breakdown.skillComplement + s.breakdown.timezone + s.breakdown.base,
      )
    }
    expect(mine[0].breakdown).toEqual({ skillComplement: 50, timezone: 20, base: 10 })
    expect(mine[0].score).toBe(80)
    expect(mine[1].breakdown).toEqual({ skillComplement: 50, timezone: 10, base: 10 })
    expect(mine[1].score).toBe(70)
    expect(mine[2].breakdown).toEqual({ skillComplement: 10, timezone: 20, base: 10 })
    expect(mine[2].score).toBe(40)
  })

  test('suggestions exclude users who are not looking for teammates', async () => {
    const me = await registerUser({ skills: ['react'] })
    const hidden = await registerUser({
      skills: ['python', 'go', 'rust', 'docker', 'kubernetes'],
    })
    await setLookingForTeammates(hidden.user.id, false)
    const res = await api('/api/users/me/suggestions', { session: me })
    expect(res.status).toBe(200)
    const list = Array.isArray(res.body) ? res.body : res.body.suggestions
    expect(list.map((s: any) => s.user.id)).not.toContain(hidden.user.id)
  })

  test('suggestions exclude the requesting user', async () => {
    const me = await registerUser({ skills: ['react'] })
    const res = await api('/api/users/me/suggestions', { session: me })
    expect(res.status).toBe(200)
    const list = Array.isArray(res.body) ? res.body : res.body.suggestions
    expect(list.map((s: any) => s.user.id)).not.toContain(me.user.id)
  })
})

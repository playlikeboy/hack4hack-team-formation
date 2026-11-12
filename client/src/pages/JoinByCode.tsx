// Join a team with an invite code.
//
// One wrinkle worth explaining: the API joins by team id
// (POST /api/teams/:id/join {inviteCode}), so a bare code is not enough —
// the client needs to know which team the code belongs to. Invite links
// therefore carry both: /teams/join?code=XXXX&team=<id>. When someone arrives
// with only a code typed in by hand, the form lets them pick the team from
// the board first. No extra endpoint was invented to resolve codes.

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, getBoard, getTeam, joinTeam } from '../lib/api'
import type { BoardTeam } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useHackathon } from '../lib/hackathon'
import { ErrorBox, Field, Loading, inputClass, primaryButtonClass } from '../components/ui'

export default function JoinByCodePage() {
  const [searchParams] = useSearchParams()
  const { user, loading: authLoading } = useAuth()
  const { hackathon, loading: hackathonLoading } = useHackathon()
  const navigate = useNavigate()

  const [code, setCode] = useState(searchParams.get('code') ?? '')
  const [teamId, setTeamId] = useState(searchParams.get('team') ?? '')
  const [teams, setTeams] = useState<BoardTeam[]>([])
  const [teamName, setTeamName] = useState<string | null>(null)
  const [loadingTeams, setLoadingTeams] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // When the link names a team, show its name so the user can confirm.
  // When it doesn't, load the board so the user can pick one.
  useEffect(() => {
    if (!hackathon) return
    if (teamId) {
      getTeam(teamId)
        .then(({ team }) => setTeamName(team.name))
        .catch(() => setTeamName(null))
      return
    }
    setLoadingTeams(true)
    getBoard(hackathon.id)
      .then((board) => setTeams(board.teams))
      .catch(() => setTeams([]))
      .finally(() => setLoadingTeams(false))
  }, [hackathon, teamId])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!teamId) {
      setError('Pick a team first.')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const { team } = await joinTeam(teamId, code.trim().toUpperCase())
      navigate(`/teams/${team.id}`)
    } catch (err) {
      // 409 = team full / already in a team; 404/400 = bad code. The
      // server's message says which — show it verbatim.
      setError(err instanceof ApiError ? err.message : 'Could not join the team.')
    } finally {
      setSubmitting(false)
    }
  }

  if (authLoading || hackathonLoading) return <Loading />

  if (!user) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Join by invite code</h1>
        <ErrorBox message="You need an account to join a team." />
        <p className="text-sm text-slate-600">
          <Link
            to="/login"
            state={{ from: `/teams/join?${searchParams.toString()}` }}
            className="font-medium text-indigo-700 underline"
          >
            Log in
          </Link>{' '}
          or{' '}
          <Link to="/register" className="font-medium text-indigo-700 underline">
            register
          </Link>{' '}
          first — your invite code will still be here.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Join by invite code</h1>
      <p className="mt-1 text-sm text-slate-600">
        {teamName ? (
          <>
            Joining <span className="font-medium text-slate-900">{teamName}</span>. Enter the
            invite code the team shared with you.
          </>
        ) : (
          'Enter the invite code the team shared with you, and pick the team it belongs to.'
        )}
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        {error && <ErrorBox message={error} />}

        {!teamId && (
          <Field label="Team">
            {loadingTeams ? (
              <p className="text-sm text-slate-500">Loading teams…</p>
            ) : (
              <select
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
                className={inputClass}
                required
              >
                <option value="">Select a team…</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.memberCount}/{t.maxSize} members)
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}

        <Field label="Invite code" hint="8 characters, e.g. K7Q2X9MP.">
          <input
            type="text"
            required
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={8}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            className={`${inputClass} font-mono tracking-widest uppercase`}
            placeholder="XXXXXXXX"
          />
        </Field>

        <button type="submit" disabled={submitting} className={`${primaryButtonClass} w-full`}>
          {submitting ? 'Joining…' : 'Join team'}
        </button>
      </form>
    </div>
  )
}

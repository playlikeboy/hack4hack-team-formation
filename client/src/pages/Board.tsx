// The shop window: every team with open seats, plus people looking for
// teammates. Public — no login needed. Live over WebSocket: any board event
// triggers a refetch, so the list updates without a page refresh.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, getBoard } from '../lib/api'
import type { BoardTeam, Seeker } from '../lib/api'
import { useHackathon } from '../lib/hackathon'
import { useAuth } from '../lib/auth'
import { useRoom } from '../lib/ws'
import type { WsStatus } from '../lib/ws'
import { EmptyState, ErrorBox, Loading, SeatsPill, SkillTag, primaryButtonClass, secondaryButtonClass } from '../components/ui'

function LiveDot({ status }: { status: WsStatus }) {
  // Honest connection state: green when the socket is live, amber while
  // connecting/reconnecting. The board still works without it (it just
  // won't auto-update until the socket comes back).
  const label =
    status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline — updates paused'
  const dot =
    status === 'live' ? 'bg-green-500' : status === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-slate-400'
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500" role="status">
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </span>
  )
}

function TeamCard({ team }: { team: BoardTeam }) {
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-base font-semibold text-slate-900">
          <Link
            to={`/teams/${team.id}`}
            className="hover:text-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {team.name}
          </Link>
        </h3>
        <SeatsPill memberCount={team.memberCount} maxSize={team.maxSize} />
      </div>

      {team.description && <p className="mt-1 text-sm text-slate-600">{team.description}</p>}

      <p className="mt-3 text-xs font-medium uppercase tracking-wide text-slate-500">
        Members ({team.memberCount}/{team.maxSize})
      </p>
      <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Team members">
        {team.members.map((m) => (
          <li key={m.id} className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-800">
            {m.name}
            {m.skills.length > 0 && (
              <span className="ml-1 font-normal text-indigo-600">· {m.skills.slice(0, 2).join(', ')}</span>
            )}
          </li>
        ))}
      </ul>

      {team.lookingFor.length > 0 && (
        <p className="mt-3 text-xs text-slate-500">
          Looking for: <span className="font-medium text-slate-700">{team.lookingFor.join(', ')}</span>
        </p>
      )}

      <div className="mt-3">
        <Link to={`/teams/${team.id}`} className={secondaryButtonClass}>
          View team
        </Link>
      </div>
    </li>
  )
}

function SeekerCard({ seeker }: { seeker: Seeker }) {
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="text-base font-semibold text-slate-900">{seeker.name}</h3>
      {seeker.bio && <p className="mt-1 text-sm text-slate-600">{seeker.bio}</p>}
      {seeker.skills.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Skills">
          {seeker.skills.map((s) => (
            <SkillTag key={s} skill={s} />
          ))}
        </div>
      )}
      <p className="mt-2 text-xs text-slate-500">Timezone: {seeker.timezone}</p>
    </li>
  )
}

export default function BoardPage() {
  const { hackathon, loading: hackathonLoading, error: hackathonError } = useHackathon()
  const { user } = useAuth()
  // Teams and seekers page independently (50 per page); totals come from
  // the API so the UI knows when there is more to load.
  const [teams, setTeams] = useState<BoardTeam[]>([])
  const [seekers, setSeekers] = useState<Seeker[]>([])
  const [totalTeams, setTotalTeams] = useState(0)
  const [totalSeekers, setTotalSeekers] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState<'teams' | 'seekers' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Loaded counts in refs so refresh() keeps a stable identity (it is a
  // useEffect dependency — depending on the lists themselves would loop).
  const teamsCountRef = useRef(0)
  const seekersCountRef = useRef(0)

  // Refetch the currently loaded windows (used on mount and on every live
  // board event). Limits grow with what the user has loaded, so a live
  // update never collapses an expanded list back to the first page.
  const refresh = useCallback(async () => {
    if (!hackathon) return
    try {
      const data = await getBoard(hackathon.id, {
        teamsLimit: Math.max(teamsCountRef.current, 50),
        seekersLimit: Math.max(seekersCountRef.current, 50),
      })
      setTeams(data.teams)
      setSeekers(data.seekers)
      setTotalTeams(data.totalTeams)
      setTotalSeekers(data.totalSeekers)
      teamsCountRef.current = data.teams.length
      seekersCountRef.current = data.seekers.length
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the board.')
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }, [hackathon])

  useEffect(() => {
    setLoading(true)
    refresh()
  }, [refresh])

  // Live updates: any board event refetches the (server-cached) board.
  const wsStatus = useRoom(
    hackathon ? `board:${hackathon.id}` : null,
    useCallback(() => {
      refresh()
    }, [refresh]),
  )

  // Load the next window of one section. The other section is fetched with
  // limit 1 — the API pages both lists per call, and we only need one.
  async function loadMore(section: 'teams' | 'seekers') {
    if (!hackathon || loadingMore) return
    setLoadingMore(section)
    try {
      const data =
        section === 'teams'
          ? await getBoard(hackathon.id, {
              teamsOffset: teams.length,
              teamsLimit: 50,
              seekersLimit: 1,
            })
          : await getBoard(hackathon.id, {
              seekersOffset: seekers.length,
              seekersLimit: 50,
              teamsLimit: 1,
            })
      if (section === 'teams') {
        setTeams((prev) => [...prev, ...data.teams])
        teamsCountRef.current += data.teams.length
      } else {
        setSeekers((prev) => [...prev, ...data.seekers])
        seekersCountRef.current += data.seekers.length
      }
      setTotalTeams(data.totalTeams)
      setTotalSeekers(data.totalSeekers)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load more.')
    } finally {
      setLoadingMore(null)
    }
  }

  if (hackathonLoading) return <Loading label="Loading hackathon…" />
  if (hackathonError) return <ErrorBox message={hackathonError} />
  if (!hackathon) return <EmptyState title="No hackathon yet." />

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{hackathon.name}</h1>
          <p className="mt-1 text-sm text-slate-600">
            Teams of {hackathon.teamMinSize}–{hackathon.teamMaxSize}. Find a crew — or start one.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LiveDot status={wsStatus} />
          {user ? (
            <>
              <Link to="/teams/new" className={primaryButtonClass}>
                Create team
              </Link>
              <Link to="/teams/join" className={secondaryButtonClass}>
                Join by code
              </Link>
            </>
          ) : (
            <Link to="/register" className={primaryButtonClass}>
              Register to join a team
            </Link>
          )}
        </div>
      </div>

      {error && <ErrorBox message={error} />}

      {loading ? (
        <Loading label="Loading teams…" />
      ) : loaded ? (
        <>
          <section aria-labelledby="teams-heading">
            <h2 id="teams-heading" className="text-lg font-semibold text-slate-900">
              Teams ({totalTeams})
            </h2>
            {teams.length === 0 ? (
              <div className="mt-3">
                <EmptyState title="No teams yet.">
                  {user ? (
                    <>
                      Be the first —{' '}
                      <Link to="/teams/new" className="font-medium text-indigo-700 underline">
                        create a team
                      </Link>
                      .
                    </>
                  ) : (
                    'Register and create the first team.'
                  )}
                </EmptyState>
              </div>
            ) : (
              <>
                <ul className="mt-3 grid gap-4 sm:grid-cols-2">
                  {teams.map((team) => (
                    <TeamCard key={team.id} team={team} />
                  ))}
                </ul>
                {teams.length < totalTeams && (
                  <div className="mt-4">
                    <button
                      type="button"
                      onClick={() => loadMore('teams')}
                      disabled={loadingMore !== null}
                      className={secondaryButtonClass}
                    >
                      {loadingMore === 'teams'
                        ? 'Loading…'
                        : `Load more teams (showing ${teams.length} of ${totalTeams})`}
                    </button>
                  </div>
                )}
              </>
            )}
          </section>

          <section aria-labelledby="seekers-heading">
            <h2 id="seekers-heading" className="text-lg font-semibold text-slate-900">
              Looking for teammates ({totalSeekers})
            </h2>
            {seekers.length === 0 ? (
              <div className="mt-3">
                <EmptyState title="Nobody is looking right now." />
              </div>
            ) : (
              <>
                <ul className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {seekers.map((s) => (
                    <SeekerCard key={s.id} seeker={s} />
                  ))}
                </ul>
                {seekers.length < totalSeekers && (
                  <div className="mt-4">
                    <button
                      type="button"
                      onClick={() => loadMore('seekers')}
                      disabled={loadingMore !== null}
                      className={secondaryButtonClass}
                    >
                      {loadingMore === 'seekers'
                        ? 'Loading…'
                        : `Load more people (showing ${seekers.length} of ${totalSeekers})`}
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        </>
      ) : null}
    </div>
  )
}

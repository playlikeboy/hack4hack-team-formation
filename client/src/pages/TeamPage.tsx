// One team: members, invite code, join requests, audit log. Live over
// WebSocket (room team:<id>) — joins, leaves and request decisions show up
// without a refresh. Leader-only controls (requests, regenerate, remove)
// render only for the leader; the server re-checks every one of them.

import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ApiError,
  acceptRequest,
  declineRequest,
  getTeam,
  leaveTeam,
  regenerateInvite,
  removeMember,
  requestToJoin,
} from '../lib/api'
import type { AuditEntry, JoinRequest, TeamDetail } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useHackathon } from '../lib/hackathon'
import { useRoom } from '../lib/ws'
import {
  EmptyState,
  ErrorBox,
  Loading,
  SeatsPill,
  SkillTag,
  SuccessBox,
  dangerButtonClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from '../components/ui'

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** "member.joined" -> "Member joined" — audit actions are dot-separated verbs. */
function humanizeAction(action: string): string {
  const words = action.replace(/[._-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Render the readable bits of an audit entry's details object. */
function AuditDetails({ entry }: { entry: AuditEntry }) {
  const details = entry.details ?? {}
  const bits: string[] = []
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string' && value && !key.toLowerCase().endsWith('id')) {
      bits.push(value)
    }
  }
  if (bits.length === 0) return null
  return <span className="text-slate-500"> — {bits.join(' · ')}</span>
}

export default function TeamPage() {
  const { id } = useParams<{ id: string }>()
  const { user } = useAuth()
  const { hackathon } = useHackathon()
  const navigate = useNavigate()
  const [detail, setDetail] = useState<TeamDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [requestMessage, setRequestMessage] = useState('')
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async () => {
    if (!id) return
    try {
      const data = await getTeam(id)
      setDetail(data)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the team.')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    setLoading(true)
    refresh()
  }, [refresh])

  useRoom(
    id ? `team:${id}` : null,
    useCallback(() => {
      refresh()
    }, [refresh]),
  )

  if (loading) return <Loading label="Loading team…" />
  if (error && !detail) return <ErrorBox message={error} />
  if (!detail || !id) return <EmptyState title="Team not found." />

  const { team, members, joinRequests, auditLog } = detail
  const isLeader = user?.id === team.leaderId
  const isMember = user ? members.some((m) => m.id === user.id) : false
  const pendingRequests = joinRequests.filter((r: JoinRequest) => r.status === 'pending')
  const inviteLink = team.inviteCode
    ? `${window.location.origin}/teams/join?code=${team.inviteCode}&team=${team.id}`
    : null

  const runAction = async (key: string, fn: () => Promise<void>, done?: string) => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      await fn()
      if (done) setNotice(done)
      await refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  const handleCopyCode = async () => {
    if (!team.inviteCode) return
    try {
      await navigator.clipboard.writeText(team.inviteCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy — select the code and copy it manually.')
    }
  }

  const handleCopyLink = async () => {
    if (!inviteLink) return
    try {
      await navigator.clipboard.writeText(inviteLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy — select the link and copy it manually.')
    }
  }

  const handleRegenerate = () => {
    // The old code stops working immediately, so ask first.
    if (!window.confirm('Generate a new invite code? The old code will stop working.')) return
    runAction('regenerate', async () => {
      await regenerateInvite(id)
    }, 'New invite code generated. The old code no longer works.')
  }

  const handleLeave = () => {
    const lastMember = members.length === 1
    const msg = lastMember
      ? 'You are the last member — leaving will delete this team. Leave anyway?'
      : isLeader
        ? 'You are the leader — leadership will pass to the earliest-joined remaining member. Leave anyway?'
        : 'Leave this team?'
    if (!window.confirm(msg)) return
    runAction('leave', async () => {
      await leaveTeam(id)
      navigate('/')
    })
  }

  const handleRemove = (memberId: string, memberName: string) => {
    if (!window.confirm(`Remove ${memberName} from the team?`)) return
    runAction(`remove:${memberId}`, async () => {
      await removeMember(id, memberId)
    }, `${memberName} was removed from the team.`)
  }

  const handleRequest = async () => {
    await runAction('request', async () => {
      await requestToJoin(id, requestMessage)
      setRequestMessage('')
    }, 'Request sent. The team leader will decide.')
  }

  return (
    <div className="space-y-8">
      <div>
        <Link to="/" className="text-sm font-medium text-indigo-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
          ← Back to board
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">{team.name}</h1>
            {team.description && <p className="mt-1 text-sm text-slate-600">{team.description}</p>}
          </div>
          {/* Max team size comes from the hackathon, not the team row. */}
          {hackathon && <SeatsPill memberCount={members.length} maxSize={hackathon.teamMaxSize} />}
        </div>
      </div>

      {error && <ErrorBox message={error} />}
      {notice && <SuccessBox message={notice} />}

      {/* Members */}
      <section aria-labelledby="members-heading">
        <h2 id="members-heading" className="text-lg font-semibold text-slate-900">
          Members ({members.length})
        </h2>
        <ul className="mt-3 space-y-2">
          {members.map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-white px-4 py-3"
            >
              <span className="font-medium text-slate-900">{m.name}</span>
              {m.id === team.leaderId && (
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-800">
                  Leader
                </span>
              )}
              {m.skills.length > 0 && (
                <span className="flex flex-wrap gap-1">
                  {m.skills.map((s) => (
                    <SkillTag key={s} skill={s} />
                  ))}
                </span>
              )}
              <span className="ml-auto text-xs text-slate-500">Joined {formatTime(m.joinedAt)}</span>
              {isLeader && m.id !== user?.id && (
                <button
                  type="button"
                  disabled={busy === `remove:${m.id}`}
                  onClick={() => handleRemove(m.id, m.name)}
                  className={`${dangerButtonClass} !px-3 !py-1 text-xs`}
                >
                  {busy === `remove:${m.id}` ? 'Removing…' : 'Remove'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* Invite code — members only (the server only sends it to members). */}
      {isMember && team.inviteCode && (
        <section aria-labelledby="invite-heading" className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
          <h2 id="invite-heading" className="text-lg font-semibold text-slate-900">
            Invite code
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Share this code (or the link) so others can join directly. The code expires{' '}
            {team.inviteExpiresAt ? formatTime(team.inviteExpiresAt) : 'after 7 days'}.
          </p>
          <p className="mt-3 font-mono text-2xl font-bold tracking-widest text-slate-900" aria-label={`Invite code ${team.inviteCode}`}>
            {team.inviteCode}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={handleCopyCode} className={secondaryButtonClass}>
              Copy code
            </button>
            <button type="button" onClick={handleCopyLink} className={secondaryButtonClass}>
              Copy invite link
            </button>
            {isLeader && (
              <button
                type="button"
                onClick={handleRegenerate}
                disabled={busy === 'regenerate'}
                className={secondaryButtonClass}
              >
                {busy === 'regenerate' ? 'Regenerating…' : 'Regenerate code'}
              </button>
            )}
            {copied && (
              <span role="status" className="self-center text-sm text-green-700">
                Copied!
              </span>
            )}
          </div>
        </section>
      )}

      {/* Join requests — leader only. */}
      {isLeader && (
        <section aria-labelledby="requests-heading">
          <h2 id="requests-heading" className="text-lg font-semibold text-slate-900">
            Join requests ({pendingRequests.length} pending)
          </h2>
          {pendingRequests.length === 0 ? (
            <div className="mt-3">
              <EmptyState title="No pending requests." />
            </div>
          ) : (
            <ul className="mt-3 space-y-2">
              {pendingRequests.map((r) => (
                <li key={r.id} className="rounded-lg border border-slate-200 bg-white px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-medium text-slate-900">{r.userName}</span>
                    {r.userSkills.length > 0 && (
                      <span className="flex flex-wrap gap-1">
                        {r.userSkills.map((s) => (
                          <SkillTag key={s} skill={s} />
                        ))}
                      </span>
                    )}
                    <span className="text-xs text-slate-500">{formatTime(r.createdAt)}</span>
                  </div>
                  {r.message && <p className="mt-1 text-sm text-slate-600">{r.message}</p>}
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      disabled={busy === `accept:${r.id}`}
                      onClick={() =>
                        runAction(`accept:${r.id}`, async () => {
                          await acceptRequest(id, r.id)
                        }, `${r.userName} joined the team.`)
                      }
                      className={primaryButtonClass}
                    >
                      {busy === `accept:${r.id}` ? 'Accepting…' : 'Accept'}
                    </button>
                    <button
                      type="button"
                      disabled={busy === `decline:${r.id}`}
                      onClick={() =>
                        runAction(`decline:${r.id}`, async () => {
                          await declineRequest(id, r.id)
                        }, `Declined ${r.userName}'s request.`)
                      }
                      className={secondaryButtonClass}
                    >
                      {busy === `decline:${r.id}` ? 'Declining…' : 'Decline'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Request to join — signed-in non-members. */}
      {!isMember && user && (
        <section aria-labelledby="join-heading" className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 id="join-heading" className="text-lg font-semibold text-slate-900">
            Want to join this team?
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Send a request to the leader, or{' '}
            <Link to={`/teams/join?team=${team.id}`} className="font-medium text-indigo-700 underline">
              join directly with an invite code
            </Link>
            .
          </p>
          <label className="mt-3 block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Message to the leader (optional)</span>
            <textarea
              rows={2}
              value={requestMessage}
              onChange={(e) => setRequestMessage(e.target.value)}
              className={inputClass}
              placeholder="Hi, I'd love to join — I do frontend and…"
            />
          </label>
          <button
            type="button"
            onClick={handleRequest}
            disabled={busy === 'request'}
            className={`${primaryButtonClass} mt-3`}
          >
            {busy === 'request' ? 'Sending…' : 'Send join request'}
          </button>
        </section>
      )}

      {!isMember && !user && (
        <p className="text-sm text-slate-600">
          <Link to="/login" state={{ from: `/teams/${team.id}` }} className="font-medium text-indigo-700 underline">
            Log in
          </Link>{' '}
          to request to join this team.
        </p>
      )}

      {/* Leave — members only. */}
      {isMember && (
        <section aria-label="Leave team">
          <button
            type="button"
            onClick={handleLeave}
            disabled={busy === 'leave'}
            className={dangerButtonClass}
          >
            {busy === 'leave' ? 'Leaving…' : 'Leave team'}
          </button>
        </section>
      )}

      {/* Audit log — members only (the server only sends it to members). */}
      {isMember && (
        <section aria-labelledby="audit-heading">
          <h2 id="audit-heading" className="text-lg font-semibold text-slate-900">
            Activity
          </h2>
          {auditLog.length === 0 ? (
            <div className="mt-3">
              <EmptyState title="No activity yet." />
            </div>
          ) : (
            <ol className="mt-3 space-y-1 rounded-lg border border-slate-200 bg-white px-4 py-3">
              {auditLog.map((entry) => (
                <li key={entry.id} className="flex flex-wrap gap-x-2 py-1 text-sm">
                  <time className="w-36 shrink-0 text-slate-500" dateTime={entry.createdAt}>
                    {formatTime(entry.createdAt)}
                  </time>
                  <span className="text-slate-800">
                    {entry.actorName ? `${entry.actorName} — ` : ''}
                    {humanizeAction(entry.action)}
                    <AuditDetails entry={entry} />
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  )
}

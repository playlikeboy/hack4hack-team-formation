// Create a team. The creator becomes leader + first member. Fails with 409
// if the user is already in a team for this hackathon — the server enforces
// that, we just show its message.

import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, createTeam } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useHackathon } from '../lib/hackathon'
import { ErrorBox, Field, Loading, inputClass, primaryButtonClass } from '../components/ui'

export default function CreateTeamPage() {
  const { user, loading: authLoading } = useAuth()
  const { hackathon, loading: hackathonLoading, error: hackathonError } = useHackathon()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!hackathon) return
    setError(null)
    setSubmitting(true)
    try {
      const { team } = await createTeam({ hackathonId: hackathon.id, name, description })
      navigate(`/teams/${team.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the team.')
    } finally {
      setSubmitting(false)
    }
  }

  if (authLoading || hackathonLoading) return <Loading />
  if (hackathonError) return <ErrorBox message={hackathonError} />
  if (!hackathon) return <ErrorBox message="No hackathon is set up yet." />

  if (!user) {
    return (
      <ErrorBox message="You need an account to create a team. Log in or register first." />
    )
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Create a team</h1>
      <p className="mt-1 text-sm text-slate-600">
        For {hackathon.name}. Teams are {hackathon.teamMinSize}–{hackathon.teamMaxSize} people;
        you will be the leader and first member.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        {error && <ErrorBox message={error} />}
        <Field label="Team name">
          <input
            type="text"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            placeholder="The Debuggers"
          />
        </Field>
        <Field label="Description" hint="Optional — what the team plans to build, or who you are looking for.">
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={inputClass}
            placeholder="Building a tool for…"
          />
        </Field>
        <div className="flex gap-2">
          <button type="submit" disabled={submitting} className={primaryButtonClass}>
            {submitting ? 'Creating…' : 'Create team'}
          </button>
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}

// Teammate suggestions, ranked by the server. The breakdown is the point:
// show WHY each person was suggested (complementary skills, timezone overlap,
// base score for looking) instead of a bare number.

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, getSuggestions } from '../lib/api'
import type { Suggestion } from '../lib/api'
import { useAuth } from '../lib/auth'
import { EmptyState, ErrorBox, Loading, SkillTag } from '../components/ui'

function BreakdownRow({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <span className="text-slate-600">
        {label} <span className="text-xs text-slate-400">({hint})</span>
      </span>
      <span className="font-mono font-medium text-slate-900">+{value}</span>
    </div>
  )
}

export default function SuggestionsPage() {
  const { user, loading: authLoading } = useAuth()
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (authLoading || !user) return
    getSuggestions()
      .then((list) => setSuggestions(list))
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'Could not load suggestions.')
      })
      .finally(() => setLoading(false))
  }, [authLoading, user])

  if (authLoading) return <Loading />
  if (!user) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Teammate suggestions</h1>
        <ErrorBox message="Suggestions are personal — log in to see yours." />
        <p className="text-sm text-slate-600">
          <Link to="/login" state={{ from: '/suggestions' }} className="font-medium text-indigo-700 underline">
            Log in
          </Link>{' '}
          or{' '}
          <Link to="/register" className="font-medium text-indigo-700 underline">
            register
          </Link>
          .
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Teammate suggestions</h1>
        <p className="mt-1 text-sm text-slate-600">
          Ranked for you: people whose skills complement yours, in nearby timezones, who are
          looking for a team. Reach out on the board — or create a team and invite them with
          your code.
        </p>
      </div>

      {error && <ErrorBox message={error} />}

      {loading ? (
        <Loading label="Finding teammates…" />
      ) : suggestions.length === 0 ? (
        <EmptyState title="No suggestions yet.">
          Add skills to your profile and check back once more people have registered.
        </EmptyState>
      ) : (
        <ol className="space-y-4">
          {suggestions.map(({ user: person, score, breakdown }, i) => (
            <li key={person.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    <span className="mr-2 text-sm font-normal text-slate-400">#{i + 1}</span>
                    {person.name}
                  </h2>
                  {person.bio && <p className="mt-1 text-sm text-slate-600">{person.bio}</p>}
                </div>
                <span className="rounded-full bg-indigo-100 px-3 py-1 text-sm font-bold text-indigo-800" aria-label={`Score ${score}`}>
                  {score}
                </span>
              </div>

              {person.skills.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Skills">
                  {person.skills.map((s) => (
                    <SkillTag key={s} skill={s} />
                  ))}
                </div>
              )}
              <p className="mt-2 text-xs text-slate-500">Timezone: {person.timezone}</p>

              <div className="mt-3 space-y-1 border-t border-slate-100 pt-3">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Why this match
                </p>
                <BreakdownRow
                  label="Skill complement"
                  value={breakdown.skillComplement}
                  hint="skills they have that you don't"
                />
                <BreakdownRow
                  label="Timezone overlap"
                  value={breakdown.timezone}
                  hint="working hours in common"
                />
                <BreakdownRow
                  label="Looking for a team"
                  value={breakdown.base}
                  hint="actively seeking teammates"
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

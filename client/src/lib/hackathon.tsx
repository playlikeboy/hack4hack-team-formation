// The current hackathon. The seed creates exactly one ("Hack4Hack 2026"), so
// we take the first row the API returns. If more hackathons ever exist, this
// is the one place that picks — pages never guess an id.

import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError, listHackathons } from './api'
import type { Hackathon } from './api'

interface HackathonState {
  hackathon: Hackathon | null
  loading: boolean
  error: string | null
}

const HackathonContext = createContext<HackathonState | null>(null)

export function HackathonProvider({ children }: { children: ReactNode }) {
  const [hackathon, setHackathon] = useState<Hackathon | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listHackathons()
      .then((list) => {
        if (cancelled) return
        if (list.length === 0) {
          setError('No hackathon is set up yet. The server seed has not run.')
        } else {
          setHackathon(list[0])
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not load the hackathon.')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <HackathonContext.Provider value={{ hackathon, loading, error }}>
      {children}
    </HackathonContext.Provider>
  )
}

export function useHackathon(): HackathonState {
  const ctx = useContext(HackathonContext)
  if (!ctx) throw new Error('useHackathon must be used inside <HackathonProvider>')
  return ctx
}

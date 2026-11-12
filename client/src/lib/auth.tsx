// Auth state: the session lives in an httpOnly cookie, so the client never
// sees a token. On load we ask GET /api/auth/me who we are; a 401 just means
// "not signed in" and is not an error.

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError, login as apiLogin, logout as apiLogout, me as apiMe, register as apiRegister } from './api'
import type { RegisterInput, User } from './api'

interface AuthState {
  user: User | null
  /** True while the initial /me check is running. */
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (input: RegisterInput) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    apiMe()
      .then(({ user }) => {
        if (!cancelled) setUser(user)
      })
      .catch((err: unknown) => {
        // 401 = simply not signed in. Anything else (network down) also
        // leaves us signed out; the pages surface their own errors.
        if (!cancelled && err instanceof ApiError && err.status !== 401) {
          console.error('auth check failed', err)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const { user } = await apiLogin(email, password)
    setUser(user)
  }, [])

  const register = useCallback(async (input: RegisterInput) => {
    const { user } = await apiRegister(input)
    setUser(user)
  }, [])

  const logout = useCallback(async () => {
    await apiLogout()
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

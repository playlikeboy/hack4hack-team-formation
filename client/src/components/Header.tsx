import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useHackathon } from '../lib/hackathon'

function navClass({ isActive }: { isActive: boolean }): string {
  return `rounded-md px-3 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
    isActive ? 'bg-indigo-100 text-indigo-800' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
  }`
}

export default function Header() {
  const { user, loading, logout } = useAuth()
  const { hackathon } = useHackathon()
  const navigate = useNavigate()

  const handleLogout = async () => {
    await logout()
    navigate('/')
  }

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link
          to="/"
          className="text-lg font-bold tracking-tight text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          Hack4Hack
          <span className="ml-2 hidden text-sm font-normal text-slate-500 sm:inline">
            {hackathon ? hackathon.name : 'Team formation'}
          </span>
        </Link>

        <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
          <NavLink to="/" end className={navClass}>
            Board
          </NavLink>
          {user && (
            <NavLink to="/suggestions" className={navClass}>
              Suggestions
            </NavLink>
          )}
          {user && (
            <NavLink to="/teams/new" className={navClass}>
              Create team
            </NavLink>
          )}
          <NavLink to="/teams/join" className={navClass}>
            Join by code
          </NavLink>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {loading ? (
            <span className="text-sm text-slate-400">…</span>
          ) : user ? (
            <>
              <span className="hidden text-sm text-slate-600 sm:inline" aria-label={`Signed in as ${user.name}`}>
                {user.name}
              </span>
              <button
                type="button"
                onClick={handleLogout}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                Log out
              </button>
            </>
          ) : (
            <>
              <Link
                to="/login"
                className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                Log in
              </Link>
              <Link
                to="/register"
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                Register
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  )
}

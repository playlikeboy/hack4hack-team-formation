import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './lib/auth'
import { HackathonProvider } from './lib/hackathon'
import Header from './components/Header'
import BoardPage from './pages/Board'
import LoginPage from './pages/Login'
import RegisterPage from './pages/Register'
import CreateTeamPage from './pages/CreateTeam'
import TeamPage from './pages/TeamPage'
import JoinByCodePage from './pages/JoinByCode'
import SuggestionsPage from './pages/Suggestions'

function NotFound() {
  return (
    <div className="py-10 text-center">
      <h1 className="text-xl font-bold text-slate-900">Page not found</h1>
      <p className="mt-1 text-sm text-slate-600">That page does not exist.</p>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <HackathonProvider>
          <div className="min-h-screen bg-slate-50 text-slate-900">
            <Header />
            <main className="mx-auto max-w-5xl px-4 py-6 sm:py-8">
              <Routes>
                <Route path="/" element={<BoardPage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/teams/new" element={<CreateTeamPage />} />
                <Route path="/teams/join" element={<JoinByCodePage />} />
                <Route path="/teams/:id" element={<TeamPage />} />
                <Route path="/suggestions" element={<SuggestionsPage />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </main>
            <footer className="border-t border-slate-200 py-4 text-center text-xs text-slate-400">
              Hack4Hack 2026 — race-proof team formation
            </footer>
          </div>
        </HackathonProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}

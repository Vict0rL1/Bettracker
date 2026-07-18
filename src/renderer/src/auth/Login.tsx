import { useState } from 'react'
import { useAuth } from './AuthProvider'
import { SparkIcon } from '../components/icons'

type Mode = 'in' | 'up'

export default function Login() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<Mode>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (mode === 'in') {
        await signIn(email.trim(), password)
      } else {
        const { needsConfirmation } = await signUp(email.trim(), password)
        if (needsConfirmation) {
          setNotice('Account created. Check your email to confirm, then sign in.')
          setMode('in')
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <form className="card auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <span className="brand-mark">
            <SparkIcon size={20} />
          </span>
          <h1>
            Bet<span>Tracker</span>
          </h1>
        </div>
        <p className="auth-tag">
          {mode === 'in' ? 'Sign in to sync your bets across devices.' : 'Create an account to start tracking.'}
        </p>

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'up' ? 'At least 6 characters' : '••••••••'}
          />
        </label>

        {error && <div className="auth-error">{error}</div>}
        {notice && <div className="auth-notice">{notice}</div>}

        <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'in' ? 'Sign in' : 'Create account'}
        </button>

        <button
          type="button"
          className="auth-toggle"
          onClick={() => {
            setMode(mode === 'in' ? 'up' : 'in')
            setError(null)
            setNotice(null)
          }}
        >
          {mode === 'in' ? 'Need an account? Sign up' : 'Already have an account? Sign in'}
        </button>
      </form>
    </div>
  )
}

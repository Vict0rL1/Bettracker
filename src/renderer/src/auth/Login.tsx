import { useEffect, useState } from 'react'
import { useAuth } from './AuthProvider'
import { SparkIcon } from '../components/icons'
import { useLang } from '../lib/i18n'
import { authErrorKey, linkError, type AuthFailure } from './authErrors'

type Mode = 'in' | 'up'

/**
 * `onCancel`: shown again after a session ended, over this device's data;
 * leaving goes back to it, changes still queued.
 */
export default function Login({ onCancel }: { onCancel?: () => void } = {}) {
  const { t } = useLang()
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<Mode>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  // Kept as Supabase gave it and put into words when shown, so it follows a
  // change of language.
  // An email link that didn't work opens the app with the reason in the address.
  const [error, setError] = useState<AuthFailure | null>(() => linkError(window.location.hash))
  const [notice, setNotice] = useState<string | null>(null)

  // Said once: a reload shouldn't say it again.
  useEffect(() => {
    if (linkError(window.location.hash)) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
  }, [])

  const errorText = (e: AuthFailure): string => {
    const key = authErrorKey(e)
    return key ? t(key) : e.message || t('common.error')
  }

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
          setNotice(t('login.created'))
          setMode('in')
        }
      }
    } catch (err) {
      setError(err instanceof Error ? (err as Error & AuthFailure) : { message: '' })
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
        <p className="auth-tag">{mode === 'in' ? t('login.tagIn') : t('login.tagUp')}</p>

        <label className="field">
          <span className="field-label">{t('login.email')}</span>
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </label>

        <label className="field">
          <span className="field-label">{t('login.password')}</span>
          <input
            type="password"
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'up' ? t('login.passwordHint') : '••••••••'}
          />
        </label>

        {error && <div className="auth-error">{errorText(error)}</div>}
        {notice && <div className="auth-notice">{notice}</div>}

        <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
          {busy ? t('login.working') : mode === 'in' ? t('login.signIn') : t('login.create')}
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
          {mode === 'in' ? t('login.needAccount') : t('login.haveAccount')}
        </button>
        {onCancel && (
          <button type="button" className="auth-toggle login-back" onClick={onCancel}>
            {t('login.back')}
          </button>
        )}
      </form>
    </div>
  )
}

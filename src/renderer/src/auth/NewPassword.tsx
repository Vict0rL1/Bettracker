import { useId, useRef, useState } from 'react'
import FieldError, { describedBy } from '../components/FieldError'
import { SparkIcon } from '../components/icons'
import type { Problem } from '../lib/betForm'
import { useLang } from '../lib/i18n'
import { useAuth } from './AuthProvider'
import { authErrorKey, type AuthFailure } from './authErrors'

const MIN_LENGTH = 6

/**
 * Opened from a password reset email: the link signed this device in, and
 * the new password is set here before anything else. Keeping the old one
 * goes straight in.
 */
export default function NewPassword() {
  const { t } = useLang()
  const { email, updatePassword, finishRecovery } = useAuth()
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AuthFailure | null>(null)
  const [done, setDone] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)
  const againRef = useRef<HTMLInputElement>(null)
  const errId = useId()

  const problems: { password: Problem | null; again: Problem | null } = {
    password: password.length < MIN_LENGTH ? { key: 'login.newTooShort', vars: { n: MIN_LENGTH } } : null,
    again: again !== password ? { key: 'login.newMismatch' } : null
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setShown(true)
    if (problems.password) return passwordRef.current?.focus()
    if (problems.again) return againRef.current?.focus()
    setBusy(true)
    setError(null)
    try {
      await updatePassword(password)
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? (err as Error & AuthFailure) : { message: '' })
    } finally {
      setBusy(false)
    }
  }

  const errorText = (e: AuthFailure): string => {
    const key = authErrorKey(e)
    return key ? t(key) : e.message || t('common.error')
  }

  return (
    <div className="auth-screen">
      <form className="card auth-card new-password" onSubmit={submit} noValidate>
        <div className="auth-brand">
          <span className="brand-mark">
            <SparkIcon size={20} />
          </span>
          <h1>
            Bet<span>Tracker</span>
          </h1>
        </div>
        <p className="auth-tag">{t('login.newTitle', { email: email ?? '' })}</p>

        {done ? (
          <>
            <div className="auth-notice" role="status">
              {t('login.newDone')}
            </div>
            <button type="button" className="btn btn-primary auth-submit" onClick={finishRecovery}>
              {t('login.newContinue')}
            </button>
          </>
        ) : (
          <>
            <label className="field">
              <span className="field-label">{t('login.newPassword')}</span>
              <input
                ref={passwordRef}
                type="password"
                autoComplete="new-password"
                autoFocus
                value={password}
                aria-invalid={shown && problems.password !== null}
                aria-describedby={describedBy(shown && problems.password && `${errId}-p`)}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('login.passwordHint')}
              />
              <FieldError id={`${errId}-p`} problem={shown ? problems.password : null} />
            </label>
            <label className="field">
              <span className="field-label">{t('login.newAgain')}</span>
              <input
                ref={againRef}
                type="password"
                autoComplete="new-password"
                value={again}
                aria-invalid={shown && problems.again !== null}
                aria-describedby={describedBy(shown && problems.again && `${errId}-a`)}
                onChange={(e) => setAgain(e.target.value)}
              />
              <FieldError id={`${errId}-a`} problem={shown ? problems.again : null} />
            </label>

            {error && (
              <div className="auth-error" role="alert">
                {errorText(error)}
              </div>
            )}

            <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
              {busy ? t('login.working') : t('login.newSave')}
            </button>
            <button type="button" className="auth-toggle new-password-skip" onClick={finishRecovery}>
              {t('login.newSkip')}
            </button>
          </>
        )}
      </form>
    </div>
  )
}

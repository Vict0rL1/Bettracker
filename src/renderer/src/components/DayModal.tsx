import { useEffect, useId, useRef, useState } from 'react'
import type { BetEntry, EntryInput } from '../../../shared/types'
import { humanDate } from '../lib/dates'
import { fmtMoney, fmtPctSigned, fmtStake } from '../lib/format'
import { round2, total as sumTotal } from '../lib/stats'
import { MAX_AMOUNT } from '../lib/validate'
import { CloseIcon, PencilIcon, PlusIcon, TrashIcon } from './icons'

type Kind = 'win' | 'loss' | 'push'

export interface TagSuggestions {
  sport: string[]
  book: string[]
  betType: string[]
}

interface Props {
  date: string
  sessions: BetEntry[]
  suggestions: TagSuggestions
  onAdd: (input: EntryInput) => Promise<void>
  onUpdate: (id: string, input: EntryInput) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onClose: () => void
}

const kindOf = (amount: number): Kind => (amount > 0 ? 'win' : amount < 0 ? 'loss' : 'push')

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function DayModal({ date, sessions, suggestions, onAdd, onUpdate, onDelete, onClose }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [kind, setKind] = useState<Kind>('win')
  const [amountStr, setAmountStr] = useState('')
  const [stakeStr, setStakeStr] = useState('')
  const [note, setNote] = useState('')
  const [sport, setSport] = useState('')
  const [book, setBook] = useState('')
  const [betType, setBetType] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  // A loss almost always costs exactly the stake, so we mirror it — until the
  // user types their own figure, which is remembered for the rest of the entry.
  const amountEdited = useRef(false)
  const titleId = useId()
  const listId = useId()

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const timer = confirmTimer
    return () => {
      if (timer.current) clearTimeout(timer.current)
      // Send focus back where it came from so keyboard users aren't dumped at
      // the top of the document when the dialog closes.
      previouslyFocused?.focus?.()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      )
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const dayTotal = sumTotal(sessions)

  const resetForm = (): void => {
    setEditingId(null)
    setKind('win')
    setAmountStr('')
    setStakeStr('')
    setNote('')
    setSport('')
    setBook('')
    setBetType('')
    amountEdited.current = false
  }

  const startEdit = (s: BetEntry): void => {
    setEditingId(s.id)
    setKind(kindOf(s.amount))
    setAmountStr(s.amount === 0 ? '' : String(Math.abs(s.amount)))
    setStakeStr(s.stake === null ? '' : String(s.stake))
    setNote(s.note)
    setSport(s.sport)
    setBook(s.book)
    setBetType(s.betType)
    amountEdited.current = true
    amountRef.current?.focus()
  }

  const handleStakeChange = (value: string): void => {
    setStakeStr(value)
    if (kind === 'loss' && !amountEdited.current) setAmountStr(value)
  }

  const handleKindChange = (next: Kind): void => {
    setKind(next)
    if (next === 'loss' && !amountEdited.current && stakeStr) setAmountStr(stakeStr)
  }

  const amount = parseFloat(amountStr)
  const stake = stakeStr.trim() === '' ? null : parseFloat(stakeStr)
  const stakeValid = stake === null || (Number.isFinite(stake) && stake >= 0 && stake <= MAX_AMOUNT)
  const amountValid = kind === 'push' || (Number.isFinite(amount) && amount > 0 && amount <= MAX_AMOUNT)
  const canSave = amountValid && stakeValid && !busy
  const signedAmount = kind === 'push' ? 0 : kind === 'win' ? round2(amount) : -round2(amount)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!canSave) return
    setBusy(true)
    try {
      const input: EntryInput = {
        date,
        amount: signedAmount,
        stake,
        note: note.trim(),
        sport,
        book,
        betType
      }
      if (editingId) await onUpdate(editingId, input)
      else await onAdd(input)
      resetForm()
      amountRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (id: string): Promise<void> => {
    if (confirmId !== id) {
      setConfirmId(id)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      confirmTimer.current = setTimeout(() => setConfirmId(null), 3000)
      return
    }
    setConfirmId(null)
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    if (editingId === id) resetForm()
    setBusy(true)
    try {
      await onDelete(id)
    } finally {
      setBusy(false)
    }
  }

  const amountLabel = kind === 'win' ? 'Profit' : kind === 'loss' ? 'Amount lost' : 'Result'

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal card day-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        <header className="modal-head">
          <div>
            <h2 id={titleId}>{humanDate(date)}</h2>
            <span className="day-sub">
              {sessions.length === 0
                ? 'No sessions yet'
                : `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}`}
            </span>
          </div>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        {sessions.length > 0 && (
          <>
            <div className="day-total-row">
              <span className="day-total-label">Day total</span>
              <span className={`day-total ${kindOf(dayTotal)}`}>{fmtMoney(dayTotal)}</span>
            </div>

            <ul className="session-list">
              {sessions.map((s) => {
                const k = kindOf(s.amount)
                const tags = [s.sport, s.book, s.betType].filter(Boolean)
                return (
                  <li key={s.id} className={`session ${editingId === s.id ? 'editing' : ''}`}>
                    <span className={`session-amt ${k}`}>{s.amount === 0 ? 'PUSH' : fmtMoney(s.amount)}</span>
                    <span className="session-body">
                      <span className="session-note">{s.note || <span className="td-none">no note</span>}</span>
                      <span className="session-meta">
                        {s.stake !== null && (
                          <span className="session-stake">
                            {fmtStake(s.stake)} risked
                            {s.stake > 0 && ` · ${fmtPctSigned((s.amount / s.stake) * 100)}`}
                          </span>
                        )}
                        {tags.map((t) => (
                          <span key={t} className="tag">
                            {t}
                          </span>
                        ))}
                      </span>
                    </span>
                    <span className="session-actions">
                      <button
                        type="button"
                        className="btn-icon"
                        aria-label="Edit session"
                        title="Edit"
                        onClick={() => startEdit(s)}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        className={`btn-icon danger ${confirmId === s.id ? 'confirming' : ''}`}
                        aria-label="Delete session"
                        title={confirmId === s.id ? 'Click again to confirm' : 'Delete'}
                        onClick={() => handleDelete(s.id)}
                      >
                        {confirmId === s.id ? <span className="confirm-text">Sure?</span> : <TrashIcon />}
                      </button>
                    </span>
                  </li>
                )
              })}
            </ul>
          </>
        )}

        <form className="session-form" onSubmit={submit}>
          <div className="session-form-head">
            <span>{editingId ? 'Edit session' : 'Add a session'}</span>
            {editingId && (
              <button type="button" className="auth-toggle" onClick={resetForm}>
                Cancel edit
              </button>
            )}
          </div>

          <div className="seg">
            {(['win', 'loss', 'push'] as const).map((k) => (
              <button
                type="button"
                key={k}
                className={`seg-btn ${k} ${kind === k ? 'active' : ''}`}
                aria-pressed={kind === k}
                onClick={() => handleKindChange(k)}
              >
                {k.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="session-grid">
            <label className="field">
              <span className="field-label">
                Stake <span className="field-opt">optional</span>
              </span>
              <div className="amount-wrap">
                <span className="amount-cur">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={stakeStr}
                  onChange={(e) => handleStakeChange(e.target.value)}
                />
              </div>
            </label>

            <label className="field">
              <span className="field-label">{amountLabel}</span>
              <div className={`amount-wrap ${kind === 'push' ? 'disabled' : ''}`}>
                <span className="amount-cur">$</span>
                <input
                  ref={amountRef}
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  placeholder={kind === 'push' ? 'break-even' : '0.00'}
                  value={kind === 'push' ? '' : amountStr}
                  disabled={kind === 'push'}
                  onChange={(e) => {
                    amountEdited.current = true
                    setAmountStr(e.target.value)
                  }}
                  autoFocus
                />
              </div>
            </label>

            <label className="field">
              <span className="field-label">
                Sport <span className="field-opt">optional</span>
              </span>
              <input
                type="text"
                list={`${listId}-sport`}
                maxLength={40}
                placeholder="NBA"
                value={sport}
                onChange={(e) => setSport(e.target.value)}
              />
            </label>

            <label className="field">
              <span className="field-label">
                Book <span className="field-opt">optional</span>
              </span>
              <input
                type="text"
                list={`${listId}-book`}
                maxLength={40}
                placeholder="DraftKings"
                value={book}
                onChange={(e) => setBook(e.target.value)}
              />
            </label>

            <label className="field">
              <span className="field-label">
                Bet type <span className="field-opt">optional</span>
              </span>
              <input
                type="text"
                list={`${listId}-type`}
                maxLength={40}
                placeholder="Parlay"
                value={betType}
                onChange={(e) => setBetType(e.target.value)}
              />
            </label>

            <label className="field field-wide">
              <span className="field-label">
                Note <span className="field-opt">optional</span>
              </span>
              <input
                type="text"
                maxLength={200}
                placeholder="e.g. morning parlay"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          </div>

          <datalist id={`${listId}-sport`}>
            {suggestions.sport.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <datalist id={`${listId}-book`}>
            {suggestions.book.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <datalist id={`${listId}-type`}>
            {suggestions.betType.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>

          <div className="session-submit">
            <p className="hint">
              {kind === 'win' && 'Profit only — what you got back beyond the stake.'}
              {kind === 'loss' && 'Subtracted from the day total. Defaults to your stake.'}
              {kind === 'push' && 'Push counts as $0 toward the day total.'}
              {stake !== null && stakeValid && ' Stake feeds ROI.'}
            </p>
            <button type="submit" className="btn btn-primary session-add" disabled={!canSave}>
              {editingId ? 'Save' : (<><PlusIcon /> Add</>)}
            </button>
          </div>
        </form>

        <footer className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}

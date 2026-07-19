import { useEffect, useRef, useState } from 'react'
import type { BetEntry, EntryInput } from '../../../shared/types'
import { humanDate } from '../lib/dates'
import { fmtMoney } from '../lib/format'
import { round2, total as sumTotal } from '../lib/stats'
import { CloseIcon, PencilIcon, PlusIcon, TrashIcon } from './icons'

type Kind = 'win' | 'loss' | 'push'

interface Props {
  date: string
  sessions: BetEntry[]
  onAdd: (input: EntryInput) => Promise<void>
  onUpdate: (id: string, input: EntryInput) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onClose: () => void
}

const kindOf = (amount: number): Kind => (amount > 0 ? 'win' : amount < 0 ? 'loss' : 'push')

export default function DayModal({ date, sessions, onAdd, onUpdate, onDelete, onClose }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [kind, setKind] = useState<Kind>('win')
  const [amountStr, setAmountStr] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const amountRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [onClose])

  const dayTotal = sumTotal(sessions)

  const resetForm = () => {
    setEditingId(null)
    setKind('win')
    setAmountStr('')
    setNote('')
  }

  const startEdit = (s: BetEntry) => {
    setEditingId(s.id)
    setKind(kindOf(s.amount))
    setAmountStr(s.amount === 0 ? '' : String(Math.abs(s.amount)))
    setNote(s.note)
    amountRef.current?.focus()
  }

  const amount = parseFloat(amountStr)
  const validAmount = kind === 'push' || (Number.isFinite(amount) && amount > 0 && amount <= 10_000_000)
  const canSave = validAmount && !busy
  const signedAmount = kind === 'push' ? 0 : kind === 'win' ? round2(amount) : -round2(amount)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSave) return
    setBusy(true)
    try {
      const input: EntryInput = { date, amount: signedAmount, note: note.trim() }
      if (editingId) await onUpdate(editingId, input)
      else await onAdd(input)
      resetForm()
      amountRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (id: string) => {
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

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal card day-modal">
        <header className="modal-head">
          <div>
            <h2>{humanDate(date)}</h2>
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
                return (
                  <li key={s.id} className={`session ${editingId === s.id ? 'editing' : ''}`}>
                    <span className={`session-amt ${k}`}>{s.amount === 0 ? 'PUSH' : fmtMoney(s.amount)}</span>
                    <span className="session-note">{s.note || <span className="td-none">no note</span>}</span>
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
                onClick={() => setKind(k)}
              >
                {k.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="session-inputs">
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
                onChange={(e) => setAmountStr(e.target.value)}
                autoFocus
              />
            </div>
            <input
              type="text"
              className="session-note-input"
              maxLength={200}
              placeholder="Note (e.g. morning parlay)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button type="submit" className="btn btn-primary session-add" disabled={!canSave}>
              {editingId ? 'Save' : (<><PlusIcon /> Add</>)}
            </button>
          </div>
          <p className="hint">
            {kind === 'win' && 'Logged as a win — added to the day total.'}
            {kind === 'loss' && 'Logged as a loss — subtracted from the day total.'}
            {kind === 'push' && 'Push counts as $0 toward the day total.'}
          </p>
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

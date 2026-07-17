import { useEffect, useMemo, useRef, useState } from 'react'
import type { BetEntry, EntryInput } from '../../../shared/types'
import { humanDate } from '../lib/dates'
import { fmtMoney } from '../lib/format'
import { round2 } from '../lib/stats'
import { CloseIcon } from './icons'

type Kind = 'win' | 'loss' | 'push'

interface Props {
  date: string
  entryMap: Map<string, BetEntry>
  onSave: (input: EntryInput) => Promise<void>
  onDelete: (date: string) => Promise<void>
  onClose: () => void
}

const kindOf = (amount: number): Kind => (amount > 0 ? 'win' : amount < 0 ? 'loss' : 'push')

export default function EntryModal({ date: initialDate, entryMap, onSave, onDelete, onClose }: Props) {
  const existing = entryMap.get(initialDate)
  const isEdit = Boolean(existing)

  const [date, setDate] = useState(initialDate)
  const [kind, setKind] = useState<Kind>(existing ? kindOf(existing.amount) : 'win')
  const [amountStr, setAmountStr] = useState(
    existing && existing.amount !== 0 ? String(Math.abs(existing.amount)) : ''
  )
  const [note, setNote] = useState(existing?.note ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  // Warn when a freshly-picked date would silently replace an existing day.
  const collision = useMemo(() => (isEdit ? undefined : entryMap.get(date)), [isEdit, date, entryMap])

  const amount = parseFloat(amountStr)
  const validAmount = kind === 'push' || (Number.isFinite(amount) && amount > 0 && amount <= 10_000_000)
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date)
  const canSave = validDate && validAmount && !busy

  const signedAmount = kind === 'push' ? 0 : kind === 'win' ? round2(amount) : -round2(amount)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSave) return
    setBusy(true)
    try {
      await onSave({ date, amount: signedAmount, note: note.trim() })
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      confirmTimer.current = setTimeout(() => setConfirmDelete(false), 3000)
      return
    }
    setBusy(true)
    try {
      await onDelete(date)
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
      <form className="modal card" onSubmit={submit}>
        <header className="modal-head">
          <h2>{isEdit ? 'Edit entry' : 'Log result'}</h2>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <label className="field">
          <span>Date</span>
          <input type="date" value={date} disabled={isEdit} onChange={(e) => setDate(e.target.value)} required />
        </label>
        {isEdit && <p className="hint">The date is fixed for an existing entry — delete it to move the result.</p>}

        <div className="field">
          <span>Result</span>
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
        </div>

        <label className="field">
          <span>Amount</span>
          <div className={`amount-wrap ${kind === 'push' ? 'disabled' : ''}`}>
            <span className="amount-cur">$</span>
            <input
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              placeholder={kind === 'push' ? '0.00 (break-even)' : '0.00'}
              value={kind === 'push' ? '' : amountStr}
              disabled={kind === 'push'}
              onChange={(e) => setAmountStr(e.target.value)}
              autoFocus
            />
          </div>
        </label>
        <p className="hint">
          {kind === 'win' && 'Saved as a positive amount — net profit for the day.'}
          {kind === 'loss' && 'Saved as a negative amount — net loss for the day.'}
          {kind === 'push' && 'Push logs the day at $0 (break-even).'}
        </p>

        <label className="field">
          <span>
            Note <em>optional</em>
          </span>
          <input
            type="text"
            maxLength={200}
            placeholder="e.g. NBA parlay +450"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>

        {collision && (
          <div className="warn">
            {humanDate(date)} already has an entry ({collision.amount === 0 ? 'push' : fmtMoney(collision.amount)}).
            Saving will replace it.
          </div>
        )}

        <footer className="modal-actions">
          {isEdit && (
            <button
              type="button"
              className={`btn btn-danger ${confirmDelete ? 'confirming' : ''}`}
              disabled={busy}
              onClick={handleDelete}
            >
              {confirmDelete ? 'Confirm delete' : 'Delete'}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!canSave}>
            {isEdit ? 'Save changes' : 'Save'}
          </button>
        </footer>
      </form>
    </div>
  )
}

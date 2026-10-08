import { useEffect, useId, useRef, useState } from 'react'
import type { Bet, BetInput, BetStatus } from '../../../shared/types'
import { humanDate } from '../lib/dates'
import { fmtMoney, fmtOdds, fmtPctSigned, fmtStake } from '../lib/format'
import { round2, total as sumTotal } from '../lib/stats'
import { MAX_AMOUNT, MAX_ODDS, suggestedAmount } from '../lib/validate'
import { CloseIcon, PencilIcon, PlusIcon, TrashIcon } from './icons'

export interface TagSuggestions {
  sport: string[]
  book: string[]
  betType: string[]
}

interface Props {
  date: string
  bets: Bet[]
  suggestions: TagSuggestions
  onAdd: (input: BetInput) => Promise<void>
  onUpdate: (id: string, input: BetInput) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onClose: () => void
}

const STATUSES: readonly BetStatus[] = ['won', 'lost', 'push', 'void', 'pending']
const LABEL: Record<BetStatus, string> = { won: 'WON', lost: 'LOST', push: 'PUSH', void: 'VOID', pending: 'PENDING' }
/** CSS tone for a status (the stylesheet's older names, kept for the calendar's sake). */
export const toneOf = (s: BetStatus): string => (s === 'won' ? 'win' : s === 'lost' ? 'loss' : s)

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const toInput = (b: Bet): BetInput => ({
  date: b.date,
  amount: b.amount,
  stake: b.stake,
  odds: b.odds,
  status: b.status,
  note: b.note,
  sport: b.sport,
  book: b.book,
  betType: b.betType
})

export default function DayModal({ date, bets, suggestions, onAdd, onUpdate, onDelete, onClose }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [status, setStatus] = useState<BetStatus>('won')
  const [amountStr, setAmountStr] = useState('')
  const [stakeStr, setStakeStr] = useState('')
  const [oddsStr, setOddsStr] = useState('')
  const [note, setNote] = useState('')
  const [sport, setSport] = useState('')
  const [book, setBook] = useState('')
  const [betType, setBetType] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const stakeRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  // Once the user types their own result we stop suggesting one from the stake
  // and odds, for the rest of this entry.
  const amountEdited = useRef(false)
  // Legacy bets never recorded a stake; editing one shouldn't force it.
  const [stakeOptional, setStakeOptional] = useState(false)
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

  const dayTotal = sumTotal(bets)
  const pendingHere = bets.filter((b) => b.status === 'pending').length

  const parsedStake = stakeStr.trim() === '' ? null : parseFloat(stakeStr)
  const parsedOdds = oddsStr.trim() === '' ? null : parseFloat(oddsStr)

  /** Put the result the stake and odds imply into the amount box, unless the user has typed one. */
  const suggest = (s: BetStatus, stake: number | null, odds: number | null): void => {
    if (amountEdited.current) return
    const hint = suggestedAmount(s, stake, odds)
    setAmountStr(hint === null || hint === 0 ? '' : String(Math.abs(hint)))
  }

  const resetForm = (): void => {
    setEditingId(null)
    setStatus('won')
    setAmountStr('')
    setStakeStr('')
    setOddsStr('')
    setNote('')
    setSport('')
    setBook('')
    setBetType('')
    setStakeOptional(false)
    amountEdited.current = false
  }

  const startEdit = (b: Bet, as: BetStatus = b.status): void => {
    setEditingId(b.id)
    setStatus(as)
    setStakeStr(b.stake === null ? '' : String(b.stake))
    setOddsStr(b.odds === null ? '' : String(b.odds))
    setNote(b.note)
    setSport(b.sport)
    setBook(b.book)
    setBetType(b.betType)
    setStakeOptional(b.stake === null)
    if (as === b.status && b.amount !== null) {
      amountEdited.current = true
      setAmountStr(b.amount === 0 ? '' : String(Math.abs(b.amount)))
    } else {
      // Settling from the list: the result is still to be worked out.
      amountEdited.current = false
      const hint = suggestedAmount(as, b.stake, b.odds)
      setAmountStr(hint === null || hint === 0 ? '' : String(Math.abs(hint)))
    }
    ;(as === 'won' || as === 'lost' ? amountRef : stakeRef).current?.focus()
  }

  const handleStatus = (next: BetStatus): void => {
    setStatus(next)
    suggest(next, parsedStake, parsedOdds)
  }
  const handleStake = (value: string): void => {
    setStakeStr(value)
    suggest(status, value.trim() === '' ? null : parseFloat(value), parsedOdds)
  }
  const handleOdds = (value: string): void => {
    setOddsStr(value)
    suggest(status, parsedStake, value.trim() === '' ? null : parseFloat(value))
  }

  const amount = parseFloat(amountStr)
  const needsAmount = status === 'won' || status === 'lost'
  const amountValid = !needsAmount || (Number.isFinite(amount) && amount > 0 && amount <= MAX_AMOUNT)
  const stakeValid =
    parsedStake === null
      ? stakeOptional
      : Number.isFinite(parsedStake) && parsedStake >= 0 && parsedStake <= MAX_AMOUNT
  const oddsValid = parsedOdds === null || (Number.isFinite(parsedOdds) && parsedOdds > 1 && parsedOdds <= MAX_ODDS)
  const canSave = amountValid && stakeValid && oddsValid && !busy

  const signedAmount: number | null =
    status === 'pending' ? null : status === 'won' ? round2(amount) : status === 'lost' ? -round2(amount) : 0

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!canSave) return
    setBusy(true)
    try {
      const input: BetInput = {
        date,
        amount: signedAmount,
        stake: parsedStake,
        odds: parsedOdds,
        status,
        note: note.trim(),
        sport,
        book,
        betType
      }
      if (editingId) await onUpdate(editingId, input)
      else await onAdd(input)
      resetForm()
      stakeRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  /** One tap from the list. Falls back to the form when the result can't be worked out. */
  const quickSettle = async (b: Bet, as: BetStatus): Promise<void> => {
    const hint = suggestedAmount(as, b.stake, b.odds)
    if (hint === null) {
      startEdit(b, as)
      return
    }
    setBusy(true)
    try {
      await onUpdate(b.id, { ...toInput(b), status: as, amount: hint })
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

  const amountLabel = status === 'won' ? 'Profit' : status === 'lost' ? 'Amount lost' : 'Result'
  const hint =
    status === 'won'
      ? parsedOdds === null
        ? 'Profit only — what you got back beyond the stake. Add the odds and it fills in.'
        : 'Profit only — filled in from stake × (odds − 1). Edit it if the book paid differently.'
      : status === 'lost'
        ? 'Defaults to the stake, since that is what a loss costs.'
        : status === 'push'
          ? 'A push returns the stake: counts as $0 and stays out of ROI.'
          : status === 'void'
            ? 'Cancelled by the book: stake returned, out of the record entirely.'
            : 'No result yet. It stays out of P/L, ROI and streaks until you settle it.'

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
              {bets.length === 0
                ? 'No bets yet'
                : `${bets.length} ${bets.length === 1 ? 'bet' : 'bets'}` +
                  (pendingHere > 0 ? ` · ${pendingHere} pending` : '')}
            </span>
          </div>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        {bets.length > 0 && (
          <>
            <div className="day-total-row">
              <span className="day-total-label">Day total</span>
              <span className={`day-total ${dayTotal > 0 ? 'win' : dayTotal < 0 ? 'loss' : 'push'}`}>
                {fmtMoney(dayTotal)}
              </span>
            </div>

            <ul className="bet-list">
              {bets.map((b) => {
                const tags = [b.sport, b.book, b.betType].filter(Boolean)
                const ret = b.amount !== null && b.stake !== null && b.stake > 0 ? (b.amount / b.stake) * 100 : null
                return (
                  <li key={b.id} className={`bet-item ${editingId === b.id ? 'editing' : ''}`}>
                    <span className={`bet-amt ${toneOf(b.status)}`}>
                      {b.status === 'pending' || b.amount === 0 ? LABEL[b.status] : fmtMoney(b.amount ?? 0)}
                    </span>
                    <span className="bet-body">
                      <span className="bet-note">{b.note || <span className="td-none">no note</span>}</span>
                      <span className="bet-meta">
                        {b.stake !== null && (
                          <span className="bet-stake">
                            {fmtStake(b.stake)} {b.status === 'pending' ? 'riding' : 'risked'}
                            {b.odds !== null && ` @ ${fmtOdds(b.odds)}`}
                            {ret !== null && (b.status === 'won' || b.status === 'lost') && ` · ${fmtPctSigned(ret)}`}
                          </span>
                        )}
                        {tags.map((t) => (
                          <span key={t} className="tag">
                            {t}
                          </span>
                        ))}
                      </span>
                      {b.status === 'pending' && (
                        <span className="settle" role="group" aria-label="Settle this bet">
                          {(['won', 'lost', 'push', 'void'] as const).map((s) => (
                            <button
                              key={s}
                              type="button"
                              className={`settle-btn ${toneOf(s)}`}
                              disabled={busy}
                              onClick={() => quickSettle(b, s)}
                            >
                              {LABEL[s]}
                            </button>
                          ))}
                        </span>
                      )}
                    </span>
                    <span className="bet-actions">
                      <button type="button" className="btn-icon" aria-label="Edit bet" title="Edit" onClick={() => startEdit(b)}>
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        className={`btn-icon danger ${confirmId === b.id ? 'confirming' : ''}`}
                        aria-label="Delete bet"
                        title={confirmId === b.id ? 'Click again to confirm' : 'Delete'}
                        onClick={() => handleDelete(b.id)}
                      >
                        {confirmId === b.id ? <span className="confirm-text">Sure?</span> : <TrashIcon />}
                      </button>
                    </span>
                  </li>
                )
              })}
            </ul>
          </>
        )}

        <form className="bet-form" onSubmit={submit}>
          <div className="bet-form-head">
            <span>{editingId ? 'Edit bet' : 'Add a bet'}</span>
            {editingId && (
              <button type="button" className="auth-toggle" onClick={resetForm}>
                Cancel edit
              </button>
            )}
          </div>

          <div className="seg" role="group" aria-label="Result">
            {STATUSES.map((s) => (
              <button
                type="button"
                key={s}
                className={`seg-btn ${toneOf(s)} ${status === s ? 'active' : ''}`}
                aria-pressed={status === s}
                onClick={() => handleStatus(s)}
              >
                {LABEL[s]}
              </button>
            ))}
          </div>

          <div className="bet-grid">
            <label className="field">
              <span className="field-label">
                Stake {stakeOptional && <span className="field-opt">not recorded</span>}
              </span>
              <div className="amount-wrap">
                <span className="amount-cur">$</span>
                <input
                  ref={stakeRef}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  required={!stakeOptional}
                  placeholder="0.00"
                  value={stakeStr}
                  onChange={(e) => handleStake(e.target.value)}
                  autoFocus
                />
              </div>
            </label>

            <label className="field">
              <span className="field-label">
                Odds <span className="field-opt">decimal, optional</span>
              </span>
              <input
                type="number"
                inputMode="decimal"
                min="1.01"
                step="0.01"
                placeholder="1.91"
                value={oddsStr}
                onChange={(e) => handleOdds(e.target.value)}
              />
            </label>

            <label className="field">
              <span className="field-label">{amountLabel}</span>
              <div className={`amount-wrap ${needsAmount ? '' : 'disabled'}`}>
                <span className="amount-cur">$</span>
                <input
                  ref={amountRef}
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  placeholder={status === 'pending' ? 'not yet' : needsAmount ? '0.00' : '0.00 (stake returned)'}
                  value={needsAmount ? amountStr : ''}
                  disabled={!needsAmount}
                  onChange={(e) => {
                    amountEdited.current = true
                    setAmountStr(e.target.value)
                  }}
                />
              </div>
            </label>

            <label className="field">
              <span className="field-label">
                Sport <span className="field-opt">optional</span>
              </span>
              <input type="text" list={`${listId}-sport`} maxLength={40} placeholder="NBA" value={sport} onChange={(e) => setSport(e.target.value)} />
            </label>

            <label className="field">
              <span className="field-label">
                Book <span className="field-opt">optional</span>
              </span>
              <input type="text" list={`${listId}-book`} maxLength={40} placeholder="DraftKings" value={book} onChange={(e) => setBook(e.target.value)} />
            </label>

            <label className="field">
              <span className="field-label">
                Bet type <span className="field-opt">optional</span>
              </span>
              <input type="text" list={`${listId}-type`} maxLength={40} placeholder="Parlay" value={betType} onChange={(e) => setBetType(e.target.value)} />
            </label>

            <label className="field field-wide">
              <span className="field-label">
                Note <span className="field-opt">optional</span>
              </span>
              <input type="text" maxLength={200} placeholder="e.g. morning parlay" value={note} onChange={(e) => setNote(e.target.value)} />
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

          <div className="bet-submit">
            <p className="hint">{hint}</p>
            <button type="submit" className="btn btn-primary bet-add" disabled={!canSave}>
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

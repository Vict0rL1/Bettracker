import { useEffect, useId, useRef, useState } from 'react'
import type { BankrollMove, MoveInput } from '../../../shared/types'
import { moveHints, type Bankroll } from '../lib/bankroll'
import { humanDate, shortDate, todayStr } from '../lib/dates'
import { fmtMoney, fmtMoneyPlain } from '../lib/format'
import { useLang } from '../lib/i18n'
import { useMoney } from '../lib/money'
import { isValidDate, MAX_AMOUNT, parseMoneyBox, roundCents } from '../lib/validate'
import { CloseIcon, PencilIcon, PlusIcon, TrashIcon } from './icons'

interface Props {
  bankroll: Bankroll
  /** Every deposit and withdrawal, queued ones included. */
  moves: readonly BankrollMove[]
  /** The saved starting bankroll (a setting), shown in its box. */
  startingBankroll: number | null
  /** No session or no connection: what is still loading waits for one. */
  offline: boolean
  /** A move or a setting is still waiting to reach the server. */
  dirty: boolean
  /** What it waits for is a database migration, not the connection. */
  blocked: boolean
  onSetStart: (value: number | null) => void
  onAdd: (input: MoveInput) => void
  onUpdate: (id: string, input: MoveInput) => void
  onDelete: (move: BankrollMove) => void
  onClose: () => void
}

type Kind = 'deposit' | 'withdrawal'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const newestFirst = (a: BankrollMove, b: BankrollMove): number =>
  a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : a.id < b.id ? 1 : -1

/**
 * Where the bankroll adds up: the starting bankroll, every deposit and
 * withdrawal, and the settled P/L, down to the current figure. Money here is
 * always in dollars, as it is typed; the current figure also shows its units
 * when units are on. Deposits and withdrawals are not bets: they are never
 * painted as wins or losses and never count in P/L, ROI or the loss limit.
 */
export default function BankrollDialog({ bankroll, moves, startingBankroll, offline, dirty, blocked, onSetStart, onAdd, onUpdate, onDelete, onClose }: Props) {
  const { t, tn } = useLang()
  const money = useMoney()
  const titleId = useId()
  const startId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const today = todayStr()

  const [startStr, setStartStr] = useState(startingBankroll === null ? '' : String(startingBankroll))
  const [kind, setKind] = useState<Kind>('deposit')
  const [amountStr, setAmountStr] = useState('')
  const [date, setDate] = useState(today)
  const [note, setNote] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** The start box commits on blur, Enter or close; nonsense reverts to the saved value. */
  const commitStart = (): void => {
    const parsed = parseMoneyBox(startStr, { allowZero: true })
    if (parsed === 'invalid') {
      setStartStr(startingBankroll === null ? '' : String(startingBankroll))
      return
    }
    setStartStr(parsed === null ? '' : String(parsed))
    if (parsed !== startingBankroll) onSetStart(parsed)
  }
  // Escape and the backdrop close the dialog without a blur: the typed start
  // must not be lost on the way out.
  const commitRef = useRef(commitStart)
  commitRef.current = commitStart
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const close = (): void => {
    commitRef.current()
    closeRef.current()
  }

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const timer = confirmTimer
    dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    return () => {
      if (timer.current) clearTimeout(timer.current)
      // Opened from Settings, the button that opened it is gone: land on the settings button instead.
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
      else document.querySelector<HTMLElement>('.settings-btn')?.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        commitRef.current()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
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
  }, [])

  const amount = parseFloat(amountStr)
  const amountValid = Number.isFinite(amount) && amount > 0 && roundCents(amount) > 0 && amount <= MAX_AMOUNT
  const dateValid = isValidDate(date) && date <= today
  const canSave = amountValid && dateValid
  const signed = amountValid ? roundCents(kind === 'deposit' ? amount : -amount) : 0
  const hints = canSave ? moveHints({ date, amount: signed }, moves, bankroll, editingId ?? undefined) : []

  const resetForm = (): void => {
    setEditingId(null)
    setKind('deposit')
    setAmountStr('')
    setDate(todayStr())
    setNote('')
  }

  const startEdit = (m: BankrollMove): void => {
    setEditingId(m.id)
    setKind(m.amount > 0 ? 'deposit' : 'withdrawal')
    setAmountStr(String(Math.abs(m.amount)))
    setDate(m.date)
    setNote(m.note)
    amountRef.current?.focus()
  }

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!canSave) return
    const input: MoveInput = { date, amount: signed, note: note.trim() }
    if (editingId) onUpdate(editingId, input)
    else onAdd(input)
    resetForm()
  }

  const handleDelete = (m: BankrollMove): void => {
    if (confirmId !== m.id) {
      setConfirmId(m.id)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      confirmTimer.current = setTimeout(() => setConfirmId(null), 3000)
      return
    }
    setConfirmId(null)
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    if (editingId === m.id) resetForm()
    onDelete(m)
  }

  const kindOf = (m: BankrollMove): Kind => (m.amount > 0 ? 'deposit' : 'withdrawal')
  const sorted = [...moves].sort(newestFirst)
  const known = bankroll.known ? bankroll : null

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="modal card bank-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        <header className="modal-head">
          <h2 id={titleId}>{t('bank.title')}</h2>
          <button type="button" className="btn-icon" aria-label={t('common.close')} onClick={close}>
            <CloseIcon />
          </button>
        </header>

        <div className="bank-current">
          <span className="stat-label">{t('bank.current')}</span>
          <span className={`bank-figure ${known && known.current <= 0 ? 'loss' : ''}`}>
            {known ? fmtMoneyPlain(known.current) : bankroll.known === false && bankroll.reason === 'unset' ? '—' : '…'}
            {known && money.unit !== null && <span className="bank-units"> · {money.bankroll(known.current)}</span>}
          </span>
          <span className="stat-sub">
            {known
              ? known.inPlayCount > 0
                ? t('bank.riding', { amount: fmtMoneyPlain(known.inPlay), bets: tn('bet', known.inPlayCount) }) +
                  (known.unstakedPending > 0 ? t('bank.noStake', { n: known.unstakedPending }) : '')
                : ''
              : bankroll.known === false && bankroll.reason === 'loading'
                ? t(offline ? 'bank.loadingOffline' : 'bank.loading')
                : ''}
          </span>
        </div>

        <dl className="bank-ledger">
          <div className="bank-line">
            <dt>
              <label htmlFor={startId}>{t('bank.start')}</label>
            </dt>
            <dd>
              <div className="amount-wrap bank-start">
                <span className="amount-cur">$</span>
                <input
                  id={startId}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={startStr}
                  onChange={(e) => setStartStr(e.target.value)}
                  onBlur={commitStart}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitStart()
                    }
                  }}
                />
              </div>
            </dd>
          </div>
          <p className="hint">
            {known?.firstBetDate ? t('bank.startHint', { date: humanDate(known.firstBetDate) }) : t('bank.startHintNoBets')}
            {known && !known.startSet ? ` ${t('bank.countsAsZero')}` : ''}
          </p>
          {known && (
            <>
              <div className="bank-line">
                <dt>{t('bank.deposits', { n: known.deposits.count })}</dt>
                <dd>{fmtMoney(known.deposits.sum)}</dd>
              </div>
              <div className="bank-line">
                <dt>{t('bank.withdrawals', { n: known.withdrawals.count })}</dt>
                <dd>{fmtMoney(known.withdrawals.sum)}</dd>
              </div>
              <div className="bank-line">
                <dt>{t('bank.settledPL')}</dt>
                <dd className={known.settledPL > 0 ? 'win' : known.settledPL < 0 ? 'loss' : ''}>{fmtMoney(known.settledPL)}</dd>
              </div>
              <div className="bank-line bank-total">
                <dt>{t('bank.current')}</dt>
                <dd>{fmtMoneyPlain(known.current)}</dd>
              </div>
            </>
          )}
        </dl>

        <form className="bank-form" onSubmit={submit}>
          <div className="bet-form-head">
            <span>{editingId ? t(kind === 'deposit' ? 'bank.editDeposit' : 'bank.editWithdrawal') : t('bank.addTitle')}</span>
            {editingId && (
              <button type="button" className="auth-toggle" onClick={resetForm}>
                {t('modal.cancelEdit')}
              </button>
            )}
          </div>
          <div className="seg seg-2" role="group" aria-label={t('bank.kindGroup')}>
            {(['deposit', 'withdrawal'] as const).map((k) => (
              <button key={k} type="button" className={`seg-btn move-kind-btn ${kind === k ? 'active' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)}>
                {t(`bank.${k}`)}
              </button>
            ))}
          </div>
          <div className="bank-grid">
            <label className="field">
              <span className="field-label">{t('bank.amount')}</span>
              <div className="amount-wrap">
                <span className="amount-cur">$</span>
                <input
                  ref={amountRef}
                  className="move-amount"
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  placeholder="0.00"
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                />
              </div>
            </label>
            <label className="field">
              <span className="field-label">{t('bank.date')}</span>
              <input className="move-date" type="date" max={today} value={date} aria-invalid={!dateValid} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="field field-wide">
              <span className="field-label">
                {t('bank.note')} <span className="field-opt">{t('common.optional')}</span>
              </span>
              <input className="move-note" type="text" maxLength={200} placeholder={t('bank.notePlaceholder')} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          </div>
          {hints.length > 0 && (
            <ul className="move-hints">
              {hints.map((h) => (
                <li key={h}>
                  {h === 'duplicate'
                    ? t(kind === 'deposit' ? 'bank.duplicateDeposit' : 'bank.duplicateWithdrawal', { amount: fmtMoneyPlain(Math.abs(signed)), date: shortDate(date) })
                    : h === 'belowZero'
                      ? t('bank.belowZero')
                      : t('bank.beforeStart', { date: known?.firstBetDate ? shortDate(known.firstBetDate) : '' })}
                </li>
              ))}
            </ul>
          )}
          <div className="bet-submit">
            <span className="spacer" />
            <button type="submit" className="btn btn-primary move-save" disabled={!canSave}>
              {editingId ? t('common.save') : (<><PlusIcon /> {t('common.add')}</>)}
            </button>
          </div>
        </form>

        <section className="move-section">
          <h3 className="field-label">{t('bank.listTitle')}</h3>
          {sorted.length === 0 ? (
            <p className="hint">{t('bank.empty')}</p>
          ) : (
            <ul className="bet-list move-list">
              {sorted.map((m) => {
                const k = kindOf(m)
                return (
                  <li key={m.id} className={`bet-item move-item ${editingId === m.id ? 'editing' : ''}`}>
                    <span className="move-amt">{fmtMoney(m.amount)}</span>
                    <span className="bet-body">
                      <span className="bet-note">{m.note || <span className="td-none">{t(`bank.${k}`)}</span>}</span>
                      <span className="bet-meta">
                        <span className="move-date-label">{shortDate(m.date)}</span>
                        <span className="tag move-kind">{t(`bank.${k}`)}</span>
                      </span>
                    </span>
                    <span className="bet-actions">
                      <button
                        type="button"
                        className="btn-icon"
                        aria-label={t(k === 'deposit' ? 'bank.editDepositAria' : 'bank.editWithdrawalAria', { date: humanDate(m.date) })}
                        title={t('common.edit')}
                        onClick={() => startEdit(m)}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        className={`btn-icon danger ${confirmId === m.id ? 'confirming' : ''}`}
                        aria-label={t(k === 'deposit' ? 'bank.deleteDepositAria' : 'bank.deleteWithdrawalAria', { date: humanDate(m.date) })}
                        title={confirmId === m.id ? t('common.clickAgain') : t('common.delete')}
                        onClick={() => handleDelete(m)}
                      >
                        {confirmId === m.id ? <span className="confirm-text">{t('common.sure')}</span> : <TrashIcon />}
                      </button>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <footer className="modal-actions">
          <span className={`settings-sync ${dirty ? 'is-dirty' : ''}`} aria-live="polite">
            {dirty ? t(blocked ? 'settings.blocked' : 'settings.pending') : ''}
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={close}>
            {t('common.done')}
          </button>
        </footer>
      </div>
    </div>
  )
}

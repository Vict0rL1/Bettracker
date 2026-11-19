import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { Bet, BetInput, BetStatus, OddsFormat } from '../../../shared/types'
import { dayDraftId, type DayDraft } from '../data/drafts'
import { isFreeStake, moneyOf, oddsProblem, refusalText, resultProblem, stakeProblem, type Problem } from '../lib/betForm'
import { toInput } from '../lib/bulk'
import { stakeNoteApplies } from '../lib/bankroll'
import { betTags, isCasino } from '../lib/casino'
import { humanDate, todayStr } from '../lib/dates'
import { fmtPctSigned } from '../lib/format'
import { useLang } from '../lib/i18n'
import { useMoney } from '../lib/money'
import { formatOdds, ODDS_PLACEHOLDER, oddsInputMode, parseOdds } from '../lib/odds'
import { clvOf, round2, total as sumTotal } from '../lib/stats'
import { suggestedAmount } from '../lib/validate'
import FieldError, { describedBy } from './FieldError'
import { CloseIcon, PencilIcon, PlusIcon, TrashIcon } from './icons'
import StakeNote from './StakeNote'

export interface TagSuggestions {
  sport: string[]
  book: string[]
  betType: string[]
}

/** The drafts of this form (see data/drafts.ts), filed by dayDraftId. */
export interface DayDrafts {
  load: (date: string, editingId: string | null) => DayDraft | null
  save: (id: string, draft: DayDraft | null) => void
}

interface Props {
  date: string
  bets: Bet[]
  /** Open on the edit of this bet, as this status when it is being settled. */
  edit?: { id: string; as?: BetStatus } | null
  oddsFormat: OddsFormat
  suggestions: TagSuggestions
  /** The current bankroll, or null while it is unknown: a stake still riding is measured against it. */
  bankroll: number | null
  drafts: DayDrafts
  /** Each resolves once the change is accepted, and throws when it is refused: the form keeps what was typed and says why. */
  onAdd: (input: BetInput) => Promise<void>
  onUpdate: (id: string, input: BetInput) => Promise<void>
  onDelete: (id: string) => Promise<void>
  /** `draftKept`: closed with something typed, which waits as a draft. */
  onClose: (draftKept: boolean) => void
}

const STATUSES: readonly BetStatus[] = ['won', 'lost', 'push', 'void', 'pending']
const SETTLE: readonly BetStatus[] = ['won', 'lost', 'push', 'void']
/** CSS tone for a status (the stylesheet's older names, kept for the calendar's sake). */
export const toneOf = (s: BetStatus): string => (s === 'won' ? 'win' : s === 'lost' ? 'loss' : s)

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The form's boxes, as typed. */
interface Fields {
  status: BetStatus
  amount: string
  stake: string
  odds: string
  closing: string
  note: string
  sport: string
  book: string
  betType: string
}

const BLANK: Fields = { status: 'won', amount: '', stake: '', odds: '', closing: '', note: '', sport: '', book: '', betType: '' }

const FIELD_KEYS = Object.keys(BLANK) as (keyof Fields)[]
const sameFields = (a: Fields, b: Fields): boolean => FIELD_KEYS.every((k) => a[k] === b[k])
const fieldsOfDraft = (d: DayDraft): Fields => ({
  status: d.status,
  amount: d.amount,
  stake: d.stake,
  odds: d.odds,
  closing: d.closing,
  note: d.note,
  sport: d.sport,
  book: d.book,
  betType: d.betType
})

type Box = 'stake' | 'odds' | 'amount' | 'closing'

/** What one form shows: the bet it edits (or none), its boxes, and how they started. */
interface Target {
  editingId: string | null
  fields: Fields
  /** The boxes as they opened, before any draft: what counts as nothing changed. */
  baseline: Fields
  restored: boolean
  /** The amount box holds a result of its own, not one worked out from stake and odds. */
  amountTyped: boolean
}

export default function DayModal({ date, bets, edit, oddsFormat, suggestions, bankroll, drafts, onAdd, onUpdate, onDelete, onClose: close }: Props) {
  const { t, tn } = useLang()
  const money = useMoney()
  // Closed by any of its ways out: says whether a draft waits.
  const dirtyRef = useRef(false)
  const closeRef = useRef(close)
  closeRef.current = close
  const onClose = useCallback(() => closeRef.current(dirtyRef.current), [])

  /** A bet's boxes; `as` settles it (its result still to be worked out). */
  const fieldsOf = (b: Bet, as: BetStatus = b.status): Fields => {
    const settled = as === b.status && b.amount !== null
    const hint = suggestedAmount(as, b.stake, b.odds)
    return {
      status: as,
      amount: settled ? (b.amount === 0 ? '' : String(Math.abs(b.amount as number))) : hint === null || hint === 0 ? '' : String(Math.abs(hint)),
      stake: b.stake === null ? '' : String(b.stake),
      odds: b.odds === null ? '' : formatOdds(b.odds, oddsFormat),
      closing: b.closingOdds === null ? '' : formatOdds(b.closingOdds, oddsFormat),
      note: b.note,
      sport: b.sport,
      book: b.book,
      betType: b.betType
    }
  }

  /** The form for a new bet on this day, or for the edit of `b`: its draft when one was kept. */
  const targetFor = (b: Bet | null, as?: BetStatus): Target => {
    const baseline = b ? fieldsOf(b, as) : BLANK
    const draft = drafts.load(date, b?.id ?? null)
    const fields = draft ? { ...fieldsOfDraft(draft), ...(as ? { status: as } : {}) } : baseline
    return {
      editingId: b?.id ?? null,
      fields,
      baseline,
      restored: draft !== null,
      amountTyped: draft ? draft.amount !== '' : b !== null && as === undefined && b.amount !== null
    }
  }

  const [target, setTarget] = useState<Target>(() => targetFor((edit && bets.find((b) => b.id === edit.id)) || null, edit?.as))
  const { editingId, fields: f } = target
  const set = (patch: Partial<Fields>): void => setTarget((x) => ({ ...x, fields: { ...x.fields, ...patch } }))

  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [shown, setShown] = useState<ReadonlySet<Box>>(new Set())
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const stakeRef = useRef<HTMLInputElement>(null)
  const oddsRef = useRef<HTMLInputElement>(null)
  const closingRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const formHeadRef = useRef<HTMLSpanElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const listId = useId()
  const noteId = useId()
  const errId = useId()

  // The bet being edited, as stored: an odds box showing its price (which can
  // round in the chosen format: 1.91 reads as −110) saves that exact price.
  const edited = editingId === null ? undefined : bets.find((b) => b.id === editingId)
  const coarse = (): boolean => Boolean(window.matchMedia?.('(pointer: coarse)').matches)

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const timer = confirmTimer
    if (edit) {
      // Opened on one bet: its form, in view.
      formRef.current?.scrollIntoView?.({ block: 'nearest' })
      if (coarse()) formHeadRef.current?.focus({ preventScroll: true })
      else ((edit.as === 'won' || edit.as === 'lost' ? amountRef : stakeRef).current ?? stakeRef.current)?.focus({ preventScroll: true })
    } else if (coarse()) {
      // Ready to type on a computer. On a touch screen, focusing the stake would
      // open the keyboard and scroll the dialog past the day's total and bets,
      // so the dialog itself takes focus instead.
      dialogRef.current?.focus({ preventScroll: true })
    } else stakeRef.current?.focus({ preventScroll: true })
    return () => {
      if (timer.current) clearTimeout(timer.current)
      // Send focus back where it came from so keyboard users aren't dumped at
      // the top of the document when the dialog closes.
      previouslyFocused?.focus?.()
    }
    // Only as it opens.
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

  // What is typed is kept as a draft, filed by what the form is for; back as
  // it opened, there is nothing to keep.
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const fileId = dayDraftId(date, editingId)
  const fieldsText = JSON.stringify(f)
  const baselineText = JSON.stringify(target.baseline)
  useEffect(() => {
    const now = JSON.parse(fieldsText) as Fields
    const base = JSON.parse(baselineText) as Fields
    draftsRef.current.save(fileId, sameFields(now, base) ? null : { savedAt: new Date().toISOString(), date, editingId, ...now })
  }, [fieldsText, baselineText, fileId, date, editingId])

  const dayTotal = sumTotal(bets)
  const pendingHere = bets.filter((b) => b.status === 'pending').length

  /** An odds box read in the chosen format; untouched, the edited bet's exact price. */
  const oddsOf = (text: string, stored: number | null | undefined): number | null =>
    stored !== null && stored !== undefined && text === formatOdds(stored, oddsFormat) ? stored : parseOdds(text, oddsFormat)
  const parsedStake = moneyOf(f.stake)
  const parsedOdds = oddsOf(f.odds, edited?.odds)
  const parsedClosing = oddsOf(f.closing, edited?.closingOdds)
  const fmtWord = t(`odds.${oddsFormat}`).toLowerCase()
  const freeBet = isFreeStake(parsedStake)

  /** The result the stake and odds imply, in the amount box, unless the user typed one. */
  const suggest = (patch: Partial<Fields>): Partial<Fields> => {
    if (target.amountTyped) return patch
    const next = { ...f, ...patch }
    const hint = suggestedAmount(next.status, moneyOf(next.stake), oddsOf(next.odds, edited?.odds))
    return { ...patch, amount: hint === null || hint === 0 ? '' : String(Math.abs(hint)) }
  }

  /** Switch the form to a new bet on this day, or to the edit of `b`. */
  const switchTo = (b: Bet | null, as?: BetStatus): void => {
    setTarget(targetFor(b, as))
    setShown(new Set())
    setRefusal(null)
  }

  const startEdit = (b: Bet, as?: BetStatus): void => {
    switchTo(b, as)
    // After the boxes are filled in, unless the focus has moved on meanwhile
    // (a box clicked or tabbed into while the dialog was busy): taking it
    // back would send what is typed next into the wrong box.
    const from = document.activeElement
    setTimeout(() => {
      const now = document.activeElement
      if (now !== from && now !== null && now !== document.body) return
      ;(as === 'won' || as === 'lost' ? amountRef : stakeRef).current?.focus()
    }, 0)
  }

  /** Put the boxes back as they opened, and let the draft go. */
  const discard = (): void => {
    setTarget((x) => ({ ...x, fields: x.baseline, restored: false, amountTyped: x.editingId !== null && x.baseline.amount !== '' }))
    setShown(new Set())
    setRefusal(null)
  }

  // A lost free bet costs nothing: there is no amount to type.
  const needsAmount = f.status === 'won' || (f.status === 'lost' && !freeBet)
  // A casino play (lib/casino.ts): what was wagered is optional, and it needs no odds.
  const casino = isCasino(f.sport)
  const stakeOptional = (edited !== undefined && edited.stake === null) || casino
  const problems: Record<Box, Problem | null> = {
    stake: stakeProblem(f.stake, stakeOptional),
    odds: oddsProblem(f.odds, parsedOdds, oddsFormat),
    amount: needsAmount ? resultProblem(f.amount) : null,
    closing: oddsProblem(f.closing, parsedClosing, oddsFormat)
  }
  const showing = (box: Box): Problem | null => (shown.has(box) ? problems[box] : null)

  const amount = moneyOf(f.amount) ?? 0
  const signedAmount: number | null =
    f.status === 'pending' ? null : f.status === 'won' ? round2(amount) : f.status === 'lost' ? (freeBet ? 0 : -round2(amount)) : 0

  // The bankroll before the bet being edited: its own settled result is
  // already in the current figure, and a stake is measured against what was
  // there before it, not after.
  const bankrollBefore = bankroll === null ? null : round2(bankroll - (edited?.amount ?? 0))

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    const boxes: Box[] = ['stake', 'odds', 'amount', 'closing']
    setShown(new Set(boxes))
    const first = boxes.find((b) => problems[b] !== null)
    if (first) {
      const refs = { stake: stakeRef, odds: oddsRef, amount: amountRef, closing: closingRef }
      refs[first].current?.focus()
      return
    }
    setBusy(true)
    setRefusal(null)
    try {
      const input: BetInput = {
        date,
        amount: signedAmount,
        stake: parsedStake,
        odds: parsedOdds,
        closingOdds: parsedClosing,
        status: f.status,
        note: f.note.trim(),
        sport: f.sport,
        book: f.book,
        betType: f.betType
      }
      if (editingId) await onUpdate(editingId, input)
      else await onAdd(input)
      // Saved: the draft has served its purpose.
      drafts.save(fileId, null)
      switchTo(null)
      stakeRef.current?.focus()
    } catch (err) {
      setRefusal(refusalText(err, t))
    } finally {
      setBusy(false)
    }
  }

  /** One tap from the list. Falls back to the form when the result can't be worked out. */
  const quickSettle = async (b: Bet, as: BetStatus): Promise<void> => {
    const hint = suggestedAmount(as, b.stake, b.odds)
    // No odds, a free bet's win, a profit that rounds to $0.00: typed in the form.
    if (hint === null || (as === 'won' && hint === 0)) {
      startEdit(b, as)
      return
    }
    setBusy(true)
    setRefusal(null)
    try {
      await onUpdate(b.id, { ...toInput(b), status: as, amount: hint })
    } catch (err) {
      setRefusal(refusalText(err, t))
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
    // Its unfinished edit goes with it.
    drafts.save(dayDraftId(date, id), null)
    if (editingId === id) switchTo(null)
    setBusy(true)
    try {
      await onDelete(id)
    } finally {
      setBusy(false)
    }
  }

  const freeWin = f.status === 'won' && freeBet
  const amountLabel =
    f.status === 'won' ? (freeWin ? t('quick.promoProfit') : t('modal.profit')) : f.status === 'lost' ? t('modal.amountLost') : t('modal.result')
  const wonHint = suggestedAmount('won', parsedStake, parsedOdds)
  const hint =
    // A casino play's result is typed, net: no odds to work it out from.
    casino && (f.status === 'won' || f.status === 'lost') && !freeBet
      ? t('modal.hintCasino')
      : f.status === 'won'
        ? freeWin
          ? t('quick.hintFreeBet')
          : parsedOdds === null
            ? t('modal.hintWon')
            : wonHint === 0
              ? t('quick.hintRoundsZero')
              : t('modal.hintWonOdds')
        : f.status === 'lost'
          ? freeBet
            ? t('modal.hintLostFree')
            : t('modal.hintLost')
          : f.status === 'push'
            ? t('modal.hintPush')
            : f.status === 'void'
              ? t('modal.hintVoid')
              : t('modal.hintPending')
  const dirty = !sameFields(f, target.baseline)
  dirtyRef.current = dirty
  const draftIds = new Set(bets.filter((b) => drafts.load(date, b.id) !== null).map((b) => b.id))

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal card day-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef} tabIndex={-1}>
        <header className="modal-head">
          <div>
            <h2 id={titleId}>{humanDate(date)}</h2>
            <span className="day-sub">
              {bets.length === 0 ? t('modal.noBets') : tn('bet', bets.length) + (pendingHere > 0 ? t('modal.pendingSuffix', { n: pendingHere }) : '')}
            </span>
          </div>
          <button type="button" className="btn-icon" aria-label={t('common.close')} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        {bets.length > 0 && (
          <>
            <div className="day-total-row">
              <span className="day-total-label">{t('modal.dayTotal')}</span>
              <span className={`day-total ${dayTotal > 0 ? 'win' : dayTotal < 0 ? 'loss' : 'push'}`}>{money.signed(dayTotal)}</span>
            </div>

            <ul className="bet-list">
              {bets.map((b) => {
                const tags = betTags(b)
                const ret = b.amount !== null && b.stake !== null && b.stake > 0 ? (b.amount / b.stake) * 100 : null
                return (
                  <li key={b.id} className={`bet-item ${editingId === b.id ? 'editing' : ''}`}>
                    <span className={`bet-amt ${toneOf(b.status)}`}>
                      {b.status === 'pending' || b.amount === 0 ? t(`status.${b.status}`) : money.signed(b.amount ?? 0)}
                    </span>
                    <span className="bet-body">
                      <span className="bet-note">{b.note || <span className="td-none">{t('modal.noNote')}</span>}</span>
                      <span className="bet-meta">
                        {b.stake !== null && (
                          <span className="bet-stake">
                            {b.stake === 0 ? t('modal.freeBet') : t(b.status === 'pending' ? 'modal.riding' : 'modal.risked', { amount: money.stake(b.stake) })}
                            {b.odds !== null && ` @ ${formatOdds(b.odds, oddsFormat)}`}
                            {ret !== null && (b.status === 'won' || b.status === 'lost') && ` · ${fmtPctSigned(ret)}`}
                            {b.odds !== null && b.closingOdds !== null && ` · ${t('modal.clv', { pct: fmtPctSigned(clvOf(b.odds, b.closingOdds)) })}`}
                          </span>
                        )}
                        {tags.map((x) => (
                          <span key={x} className="tag">
                            {x}
                          </span>
                        ))}
                        {draftIds.has(b.id) && editingId !== b.id && <span className="tag draft-tag">{t('draft.unfinishedEdit')}</span>}
                      </span>
                      {b.status === 'pending' && (
                        <span className="settle" role="group" aria-label={t('modal.settleGroup')}>
                          {SETTLE.map((s) => (
                            <button key={s} type="button" className={`settle-btn ${toneOf(s)}`} disabled={busy} onClick={() => quickSettle(b, s)}>
                              {t(`status.${s}`)}
                            </button>
                          ))}
                        </span>
                      )}
                    </span>
                    <span className="bet-actions">
                      <button type="button" className="btn-icon" aria-label={t('modal.editBet')} title={t('common.edit')} onClick={() => startEdit(b)}>
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        className={`btn-icon danger ${confirmId === b.id ? 'confirming' : ''}`}
                        aria-label={t('modal.deleteBet')}
                        title={confirmId === b.id ? t('common.clickAgain') : t('common.delete')}
                        onClick={() => handleDelete(b.id)}
                      >
                        {confirmId === b.id ? <span className="confirm-text">{t('common.sure')}</span> : <TrashIcon />}
                      </button>
                    </span>
                  </li>
                )
              })}
            </ul>
          </>
        )}

        <form className={`bet-form ${editingId ? 'is-editing' : ''}`} onSubmit={submit} ref={formRef} noValidate>
          <div className="bet-form-head">
            <span ref={formHeadRef} tabIndex={-1}>
              {editingId ? t('modal.editTitle') : t('modal.addTitle')}
            </span>
            {editingId && (
              <button type="button" className="auth-toggle" onClick={() => switchTo(null)}>
                {t('modal.cancelEdit')}
              </button>
            )}
          </div>

          {target.restored && dirty && (
            <div className="draft-note" role="status">
              <span>{editingId ? t('draft.restoredEdit') : t('draft.restored')}</span>
              <button type="button" className="auth-toggle draft-discard" onClick={discard}>
                {t('draft.discard')}
              </button>
            </div>
          )}

          <div className="seg" role="group" aria-label={t('modal.resultGroup')}>
            {STATUSES.map((s) => (
              <button
                type="button"
                key={s}
                className={`seg-btn ${toneOf(s)} ${f.status === s ? 'active' : ''}`}
                aria-pressed={f.status === s}
                onClick={() => set(suggest({ status: s }))}
              >
                {t(`status.${s}`)}
              </button>
            ))}
          </div>

          <div className="bet-grid">
            <label className="field">
              <span className="field-label">
                {t('modal.stake')}{' '}
                {edited !== undefined && edited.stake === null ? (
                  <span className="field-opt">{t('modal.notRecorded')}</span>
                ) : (
                  casino && <span className="field-opt">{t('common.optional')}</span>
                )}
              </span>
              <div className="amount-wrap">
                <span className="amount-cur">$</span>
                <input
                  ref={stakeRef}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={f.stake}
                  aria-invalid={showing('stake') !== null}
                  aria-describedby={describedBy(showing('stake') && `${errId}-stake`, noteId)}
                  onChange={(e) => set(suggest({ stake: e.target.value }))}
                />
              </div>
              <FieldError id={`${errId}-stake`} problem={showing('stake')} />
            </label>

            <label className="field">
              <span className="field-label">
                {t('modal.odds')} <span className="field-opt">{t('modal.oddsOpt', { format: fmtWord })}</span>
              </span>
              <input
                ref={oddsRef}
                type="text"
                inputMode={oddsInputMode(oddsFormat)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="odds-input"
                placeholder={ODDS_PLACEHOLDER[oddsFormat]}
                value={f.odds}
                aria-invalid={showing('odds') !== null}
                aria-describedby={describedBy(showing('odds') && `${errId}-odds`)}
                onChange={(e) => set(suggest({ odds: e.target.value }))}
              />
              <FieldError id={`${errId}-odds`} problem={showing('odds')} />
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
                  placeholder={f.status === 'pending' ? t('modal.notYet') : f.status === 'lost' && freeBet ? t('modal.freeBetLost') : needsAmount ? '0.00' : t('modal.stakeReturned')}
                  value={needsAmount ? f.amount : ''}
                  disabled={!needsAmount}
                  aria-invalid={showing('amount') !== null}
                  aria-describedby={describedBy(showing('amount') && `${errId}-amount`, `${errId}-hint`)}
                  onChange={(e) => {
                    setTarget((x) => ({ ...x, amountTyped: true, fields: { ...x.fields, amount: e.target.value } }))
                  }}
                />
              </div>
              <FieldError id={`${errId}-amount`} problem={showing('amount')} />
            </label>

            <label className="field">
              <span className="field-label">
                {t('modal.closingOdds')} <span className="field-opt">{t('modal.oddsOpt', { format: fmtWord })}</span>
              </span>
              <input
                ref={closingRef}
                type="text"
                inputMode={oddsInputMode(oddsFormat)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="odds-input closing-input"
                placeholder={ODDS_PLACEHOLDER[oddsFormat]}
                value={f.closing}
                aria-invalid={showing('closing') !== null}
                aria-describedby={describedBy(showing('closing') && `${errId}-closing`)}
                onChange={(e) => set({ closing: e.target.value })}
              />
              <FieldError id={`${errId}-closing`} problem={showing('closing')} />
            </label>

            <label className="field">
              <span className="field-label">
                {t('modal.sport')} <span className="field-opt">{t('common.optional')}</span>
              </span>
              <input type="text" list={`${listId}-sport`} maxLength={40} placeholder="NBA" value={f.sport} onChange={(e) => set({ sport: e.target.value })} />
            </label>

            <label className="field">
              <span className="field-label">
                {t('modal.book')} <span className="field-opt">{t('common.optional')}</span>
              </span>
              <input type="text" list={`${listId}-book`} maxLength={40} placeholder="DraftKings" value={f.book} onChange={(e) => set({ book: e.target.value })} />
            </label>

            <label className="field">
              <span className="field-label">
                {t('modal.betType')} <span className="field-opt">{t('common.optional')}</span>
              </span>
              <input type="text" list={`${listId}-type`} maxLength={40} placeholder="Parlay" value={f.betType} onChange={(e) => set({ betType: e.target.value })} />
            </label>

            <label className="field field-wide">
              <span className="field-label">
                {t('modal.note')} <span className="field-opt">{t('common.optional')}</span>
              </span>
              <input type="text" maxLength={200} placeholder={t('modal.notePlaceholder')} value={f.note} onChange={(e) => set({ note: e.target.value })} />
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

          {freeBet ? (
            <p className="stake-note free-bet-note" id={noteId}>
              {t('quick.freeBetNote')}
            </p>
          ) : (
            <StakeNote
              id={noteId}
              stake={problems.stake === null ? parsedStake : null}
              current={bankrollBefore}
              applies={stakeNoteApplies(date, f.status, todayStr())}
            />
          )}

          {refusal && (
            <p className="form-error" role="alert">
              {refusal}
            </p>
          )}

          <div className="bet-submit">
            <p className="hint" id={`${errId}-hint`}>
              {hint}
            </p>
            <div className="bet-submit-actions">
              {dirty && (
                <button type="button" className="btn btn-ghost bet-discard" onClick={discard}>
                  {editingId ? t('draft.discardChanges') : t('draft.discard')}
                </button>
              )}
              <button type="submit" className="btn btn-primary bet-add" disabled={busy}>
                {editingId ? t('modal.saveChanges') : (<><PlusIcon /> {t('modal.addBet')}</>)}
              </button>
            </div>
          </div>
        </form>

        <footer className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.done')}
          </button>
        </footer>
      </div>
    </div>
  )
}

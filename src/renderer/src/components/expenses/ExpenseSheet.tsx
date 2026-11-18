import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import type { ExtractResult } from '../../../../shared/expenseExtraction'
import { EXPENSE_CATEGORIES, type Expense, type ExpenseCard, type ExpenseInput } from '../../../../shared/types'
import type { ExpenseLast } from '../../data/expenseLast'
import type { ExtractOutcome } from '../../data/extract'
import { refusalText, type Problem } from '../../lib/betForm'
import { categoryKey } from '../../lib/categories'
import { currencyDigits, currencySymbol } from '../../lib/currency'
import { addDays, todayStr } from '../../lib/dates'
import {
  draftOf,
  draftToInput,
  expenseAmountProblem,
  expenseDateProblem,
  initialDraft,
  parseAmountText,
  pasteIsTyping,
  resumedDraft,
  type ExpenseDraft
} from '../../lib/expenseForm'
import { buildReview, findDuplicate, type ReviewRow } from '../../lib/expenseReview'
import { useLang } from '../../lib/i18n'
import { useMoney } from '../../lib/money'
import type { PreparedImage } from '../../lib/scanImageDom'
import { merchantSuggestions } from '../../lib/spend'
import FieldError, { describedBy } from '../FieldError'
import { CloseIcon, ReceiptIcon } from '../icons'
import ScanPanel, { useScan } from './ScanPanel'
import ScanReview from './ScanReview'
import { useDialog } from './useDialog'

export type ScanBlocked = 'offline' | 'signed_out' | 'loading' | null

export interface ExpenseSheetProps {
  /** The expense being edited, or null to add one. */
  editing: Expense | null
  startWithScan: boolean
  /** A draft handed back after "Add card" (memory only). */
  draft: ExpenseDraft | null
  /** The card added during that handover. */
  preferCardId: string | null
  /** All the cards: pickers show the active ones plus the edited expense's own. */
  cards: ExpenseCard[]
  cardsLoaded: boolean
  /** Every expense (queued included): duplicates and merchant suggestions. */
  existing: Expense[]
  last: ExpenseLast | null
  currency: string
  /** The demo build: the image never leaves the device. */
  demo: boolean
  scanBlocked: ScanBlocked
  extract: (image: PreparedImage, signal: AbortSignal) => Promise<ExtractOutcome>
  /** Resolve once queued; throw when refused (the sheet stays open, saying why). */
  onAdd: (input: ExpenseInput) => Promise<void>
  onUpdate: (id: string, input: ExpenseInput) => Promise<void>
  onDelete: (e: Expense) => Promise<void>
  onAddMany: (inputs: ExpenseInput[]) => Promise<void>
  /** Hand the draft over to Expense settings to add a card; the sheet comes back with it. */
  onManageCards: (draft: ExpenseDraft) => void
  onClose: () => void
}

type Stage = 'form' | 'scan' | 'review'
type Field = 'amount' | 'date'

/** Up to this many cards, the picker is a row of segments; more, a select. */
const SEGMENTED_MAX = 3

/**
 * Adding or editing one expense: typed by hand, or read from a receipt photo
 * or an Apple Wallet screenshot by AI and checked before anything is saved.
 * A dialog on a computer, a bottom sheet on a phone. Nothing typed and no
 * image is ever stored: the form is short, and the image lives in memory
 * until the reading is reviewed or the sheet closes.
 */
export default function ExpenseSheet(p: ExpenseSheetProps) {
  const { t } = useLang()
  const money = useMoney()
  const { editing, cards, currency, scanBlocked } = p
  const [today] = useState(todayStr)
  const yesterday = addDays(today, -1)
  const titleId = useId()
  const fieldId = useId()
  const listId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const dateRef = useRef<HTMLInputElement>(null)

  const [stage, setStage] = useState<Stage>(p.startWithScan && !editing && !scanBlocked ? 'scan' : 'form')
  // Back from "Add card": what was typed, with the card added chosen.
  const [d, setD] = useState<ExpenseDraft>(() =>
    p.draft
      ? resumedDraft(p.draft, cards, p.preferCardId)
      : editing
        ? draftOf(editing, currency)
        : initialDraft({ today, last: p.last, cards, preferCardId: p.preferCardId ?? undefined })
  )
  const set = (patch: Partial<ExpenseDraft>): void => setD((x) => ({ ...x, ...patch }))
  const [shown, setShown] = useState<ReadonlySet<Field>>(new Set())
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [result, setResult] = useState<ExtractResult | null>(null)
  const [rows, setRows] = useState<ReviewRow[]>([])
  const [discardSure, setDiscardSure] = useState(false)
  const [over, setOver] = useState(false)
  const timers = useRef<{ del?: ReturnType<typeof setTimeout>; discard?: ReturnType<typeof setTimeout>; over?: ReturnType<typeof setTimeout> }>({})
  useEffect(() => {
    const all = timers.current
    return () => {
      for (const tm of Object.values(all)) if (tm) clearTimeout(tm)
    }
  }, [])

  // "Add card" hands over to Expense settings: its code is fetched now, so the handover never shows an empty frame.
  useEffect(() => {
    void import('./ExpenseSettings')
  }, [])

  const scan = useScan(p.extract, (found) => {
    setResult(found)
    setRows(buildReview(found, { today, cards, existing: p.existing, currency }))
    setDiscardSure(false)
    setStage('review')
  })

  // ---- closing (a finished reading with something ticked asks first) ----
  const ticked = rows.filter((r) => r.include).length
  const guarded = (action: () => void): void => {
    if (stage === 'review' && ticked > 0 && !discardSure) {
      setDiscardSure(true)
      if (timers.current.discard) clearTimeout(timers.current.discard)
      timers.current.discard = setTimeout(() => setDiscardSure(false), 3000)
      return
    }
    setDiscardSure(false)
    action()
  }
  const requestClose = (): void => guarded(p.onClose)
  useDialog(dialogRef, requestClose)

  // ---- focus per stage ----
  useEffect(() => {
    if (stage === 'form') {
      // On a touch screen the dialog itself, so the keyboard doesn't cover the sheet as it opens.
      if (window.matchMedia?.('(pointer: coarse)').matches) dialogRef.current?.focus({ preventScroll: true })
      else amountRef.current?.focus({ preventScroll: true })
    } else if (stage === 'review') titleRef.current?.focus({ preventScroll: true })
    // The scan stage focuses its own controls (ScanPanel).
  }, [stage])

  // ---- a pasted or dropped image (add mode, scanning allowed, form or scan stage) ----
  const live = useRef({ stage, phase: scan.phase, editing, scanBlocked, start: scan.start })
  live.current = { stage, phase: scan.phase, editing, scanBlocked, start: scan.start }
  useEffect(() => {
    const take = (file: File | undefined): boolean => {
      const s = live.current
      if (!file || s.editing || s.scanBlocked) return false
      if (!(s.stage === 'form' || (s.stage === 'scan' && s.phase !== 'reading'))) return false
      setStage('scan')
      s.start(file)
      return true
    }
    const hasFiles = (e: DragEvent): boolean => Boolean(e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files'))
    // Always: a file dropped on the window would otherwise be opened in its place (Electron navigates to it).
    const onDragOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setOver(true)
      if (timers.current.over) clearTimeout(timers.current.over)
      timers.current.over = setTimeout(() => setOver(false), 200)
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setOver(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      take(files.find((f) => f.type.startsWith('image/')) ?? files[0])
    }
    const onPaste = (e: ClipboardEvent): void => {
      // Text pasted into a box is typing, even with a picture beside it (Excel and Word copy one).
      if (pasteIsTyping(e.target instanceof HTMLElement ? e.target : null, Array.from(e.clipboardData?.types ?? []))) return
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'))
      if (file && take(file)) e.preventDefault()
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [])

  // ---- the review's duplicates follow the saved expenses while it is open ----
  const existing = p.existing
  useEffect(() => {
    setRows((current) => {
      if (current.length === 0) return current
      const taken = new Set<string>()
      const digits = currencyDigits(currency)
      let changed = false
      const next = current.map((r) => {
        const n = parseAmountText(r.amount, digits)
        const dup = typeof n === 'number' ? findDuplicate({ date: r.date, amount: r.refund ? -n : n, cardId: r.cardId, merchant: r.merchant }, existing, taken) : null
        if ((dup?.id ?? null) === (r.duplicateOf?.id ?? null)) return r
        changed = true
        return { ...r, duplicateOf: dup, include: dup === null }
      })
      return changed ? next : current
    })
  }, [existing, currency])

  // ---- the form ----
  const problems: Record<Field, Problem | null> = { amount: expenseAmountProblem(d.amount, currency), date: expenseDateProblem(d.date) }
  const showing = (f: Field): Problem | null => (shown.has(f) ? problems[f] : null)
  const parsed = parseAmountText(d.amount, currencyDigits(currency))
  const reads = /[.,]/.test(d.amount) && typeof parsed === 'number' && problems.amount === null ? parsed : null
  const symbol = currencySymbol(currency)
  const suggestions = useMemo(() => merchantSuggestions(p.existing), [p.existing])
  const selectable = cards.filter((c) => !c.archived || c.id === editing?.cardId)

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    if (busy) return
    setShown(new Set<Field>(['amount', 'date']))
    if (problems.amount) {
      amountRef.current?.focus()
      return
    }
    if (problems.date) {
      dateRef.current?.focus()
      return
    }
    setBusy(true)
    setRefusal(null)
    try {
      const input = draftToInput(d, editing?.source ?? 'manual', currency)
      if (editing) await p.onUpdate(editing.id, input)
      else await p.onAdd(input)
      p.onClose()
    } catch (err) {
      setRefusal(refusalText(err, t))
      setBusy(false)
    }
  }

  const deleteClick = (): void => {
    if (!editing) return
    if (timers.current.del) clearTimeout(timers.current.del)
    if (!confirmDelete) {
      setConfirmDelete(true)
      timers.current.del = setTimeout(() => setConfirmDelete(false), 3000)
      return
    }
    setConfirmDelete(false)
    void p.onDelete(editing).then(p.onClose, (err) => setRefusal(refusalText(err, t)))
  }

  const scanOff = scanBlocked ? t(`scan.err.${scanBlocked}`) : null
  const title = stage === 'review' ? t('scan.reviewTitle') : stage === 'scan' ? t('scan.title') : editing ? t('exp.editTitle') : t('exp.addTitle')
  const cardLabelId = `${fieldId}-card`
  const catLabelId = `${fieldId}-cat`
  const kindLabelId = `${fieldId}-kind`

  const cardPicker =
    !p.cardsLoaded ? (
      <p className="hint">{t('exp.loading')}</p>
    ) : selectable.length === 0 ? (
      <p className="hint exp-add-card-hint">
        <span>{t('exp.addCardHint')}</span>
        <button type="button" className="btn btn-ghost exp-add-card" onClick={() => p.onManageCards(d)}>
          {t('expset.addCard')}
        </button>
      </p>
    ) : selectable.length <= SEGMENTED_MAX ? (
      <div className="scope-toggle exp-paycard-seg" role="group" aria-labelledby={cardLabelId}>
        <button type="button" className="scope-btn" aria-pressed={d.cardId === null} title={t('spend.noCard')} onClick={() => set({ cardId: null })}>
          {t('spend.noCard')}
        </button>
        {selectable.map((c) => (
          <button key={c.id} type="button" className="scope-btn" aria-pressed={d.cardId === c.id} title={c.name} onClick={() => set({ cardId: c.id })}>
            {c.name}
          </button>
        ))}
      </div>
    ) : (
      <select className="exp-paycard-select" aria-labelledby={cardLabelId} value={d.cardId ?? ''} onChange={(e) => set({ cardId: e.target.value === '' ? null : e.target.value })}>
        <option value="">{t('spend.noCard')}</option>
        {selectable.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
        {d.cardId !== null && !selectable.some((c) => c.id === d.cardId) && <option value={d.cardId}>{t('spend.noCard')}</option>}
      </select>
    )

  const form = (
    <form className="exp-form" noValidate onSubmit={(e) => void submit(e)}>
      {!editing && (
        <div className="exp-scan-row">
          <button
            type="button"
            className="btn btn-ghost exp-scan-btn"
            title={t('scan.openTitle')}
            disabled={scanBlocked !== null}
            aria-describedby={scanOff ? `${fieldId}-scanoff` : undefined}
            onClick={() => setStage('scan')}
          >
            <ReceiptIcon /> {t('scan.open')}
          </button>
          {scanOff && (
            <p className="hint exp-scan-off" id={`${fieldId}-scanoff`}>
              {scanOff}
            </p>
          )}
        </div>
      )}

      <div className="field exp-amount-field">
        <label className="field-label" htmlFor={`${fieldId}-amount`}>
          {t('exp.amount')}
        </label>
        <div className="amount-wrap exp-amount-wrap" style={{ ['--cur-ch' as string]: symbol.length }}>
          <span className="amount-cur">{symbol}</span>
          <input
            ref={amountRef}
            id={`${fieldId}-amount`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            className="exp-amount"
            placeholder={currencyDigits(currency) === 0 ? '0' : '0.00'}
            value={d.amount}
            aria-invalid={showing('amount') !== null}
            aria-describedby={describedBy(showing('amount') && `${fieldId}-amount-err`, reads !== null && `${fieldId}-reads`)}
            onChange={(e) => set({ amount: e.target.value })}
          />
        </div>
        <FieldError id={`${fieldId}-amount-err`} problem={showing('amount')} />
        {reads !== null && (
          <p className="hint exp-amount-reads" id={`${fieldId}-reads`}>
            {t('exp.amountReads', { amount: money.plain(reads) })}
          </p>
        )}
      </div>

      <div className="field exp-kind-field">
        <span className="field-label" id={kindLabelId}>
          {t('exp.kind')}
        </span>
        <div className="scope-toggle exp-kind" role="group" aria-labelledby={kindLabelId}>
          <button type="button" className="scope-btn exp-kind-spent" aria-pressed={!d.refund} onClick={() => set({ refund: false })}>
            {t('exp.spent')}
          </button>
          <button type="button" className="scope-btn exp-kind-refund" aria-pressed={d.refund} onClick={() => set({ refund: true })}>
            {t('exp.refund')}
          </button>
        </div>
        {d.refund && <p className="hint exp-refund-hint">{t('exp.refundHint')}</p>}
      </div>

      <div className="quick-date exp-date-field">
        <div className="quick-date-row">
          <label className="quick-date-field">
            <span className="field-label">{t('quick.date')}</span>
            <input
              ref={dateRef}
              type="date"
              className="quick-date-input exp-date"
              value={d.date}
              required
              aria-invalid={showing('date') !== null}
              aria-describedby={describedBy(showing('date') && `${fieldId}-date-err`)}
              onChange={(e) => set({ date: e.target.value })}
            />
          </label>
          <div className="quick-date-chips" role="group" aria-label={t('quick.dateShortcuts')}>
            <button type="button" className={`chip exp-today-chip ${d.date === today ? 'active' : ''}`} aria-pressed={d.date === today} onClick={() => set({ date: today })}>
              {t('quick.today')}
            </button>
            <button type="button" className={`chip exp-yesterday-chip ${d.date === yesterday ? 'active' : ''}`} aria-pressed={d.date === yesterday} onClick={() => set({ date: yesterday })}>
              {t('quick.yesterday')}
            </button>
          </div>
        </div>
        <FieldError id={`${fieldId}-date-err`} problem={showing('date')} />
      </div>

      <div className="field exp-paycard-field">
        <span className="field-label" id={cardLabelId}>
          {t('exp.card')}
        </span>
        {cardPicker}
      </div>

      <div className="field exp-cat-field">
        <span className="field-label" id={catLabelId}>
          {t('exp.category')}
        </span>
        <div className="cat-chips" role="group" aria-labelledby={catLabelId}>
          {EXPENSE_CATEGORIES.map((c) => (
            <button key={c} type="button" className="chip cat-chip" data-cat={c} aria-pressed={d.category === c} onClick={() => set({ category: c })}>
              {t(categoryKey(c))}
            </button>
          ))}
        </div>
      </div>

      <label className="field">
        <span className="field-label">{t('exp.merchant')}</span>
        <input
          type="text"
          className="exp-merchant"
          maxLength={80}
          list={listId}
          autoComplete="off"
          placeholder={t('exp.merchantPlaceholder')}
          value={d.merchant}
          onChange={(e) => set({ merchant: e.target.value })}
        />
      </label>
      <datalist id={listId}>
        {suggestions.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      <label className="field field-wide">
        <span className="field-label">
          {t('exp.note')} <span className="field-opt">{t('common.optional')}</span>
        </span>
        <input type="text" className="exp-note" maxLength={500} value={d.note} onChange={(e) => set({ note: e.target.value })} />
      </label>

      {refusal && (
        <p className="form-error" role="alert">
          {refusal}
        </p>
      )}

      <footer className="modal-actions exp-form-actions">
        {editing && (
          <button type="button" className={`btn btn-ghost danger exp-sheet-delete ${confirmDelete ? 'confirming' : ''}`} onClick={deleteClick}>
            {confirmDelete ? t('common.sure') : t('common.delete')}
          </button>
        )}
        <span className="hint exp-currency-note">{t('exp.currencyNote', { currency })}</span>
        <span className="spacer" />
        <button type="submit" className="btn btn-primary exp-save" disabled={busy}>
          {editing ? t('exp.saveChanges') : t('exp.save')}
        </button>
      </footer>
    </form>
  )

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        // A reading in progress or one to review is never lost to a stray tap.
        if (e.target === e.currentTarget && stage !== 'review' && scan.phase !== 'reading') p.onClose()
      }}
    >
      <div
        ref={dialogRef}
        className={`modal card expense-modal${stage === 'review' ? ' is-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="modal-head">
          <h2 id={titleId} ref={titleRef} tabIndex={-1}>
            {title}
          </h2>
          <button type="button" className="btn-icon" aria-label={t('common.close')} onClick={requestClose}>
            <CloseIcon />
          </button>
        </header>

        {stage === 'form' && form}
        {stage === 'scan' && (
          <ScanPanel
            scan={scan}
            over={over}
            demo={p.demo}
            blocked={scanBlocked}
            onManual={() => {
              scan.cancel()
              setStage('form')
            }}
          />
        )}
        {stage === 'review' && result && (
          <ScanReview
            result={result}
            rows={rows}
            cards={cards}
            currency={currency}
            today={today}
            onChange={(next) => {
              setDiscardSure(false)
              setRows(next)
            }}
            onAdd={async (inputs) => {
              await p.onAddMany(inputs)
              p.onClose()
            }}
            onAgain={() =>
              guarded(() => {
                setRows([])
                setResult(null)
                setStage('scan')
              })
            }
            discardSure={discardSure}
          />
        )}
      </div>
    </div>
  )
}

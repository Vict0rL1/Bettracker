import { useEffect, useId, useState } from 'react'
import type { ExtractResult } from '../../../../shared/expenseExtraction'
import { EXPENSE_CATEGORIES, type ExpenseCard, type ExpenseInput } from '../../../../shared/types'
import { refusalText } from '../../lib/betForm'
import { categoryKey } from '../../lib/categories'
import { currencyDigits } from '../../lib/currency'
import { humanDate, shortDate } from '../../lib/dates'
import { expenseAmountProblem, expenseDateProblem, merchantLabel, parseAmountText } from '../../lib/expenseForm'
import { applyCardToUnmatched, reviewInputs, reviewRowProblem, setAllIncluded, type ReviewRow } from '../../lib/expenseReview'
import { useLang } from '../../lib/i18n'
import { useMoney } from '../../lib/money'
import FieldError, { describedBy } from '../FieldError'
import { PencilIcon } from '../icons'
import Paged from '../Paged'

interface Props {
  result: ExtractResult
  rows: ReviewRow[]
  /** All the cards: the pickers offer the active ones, a row's own card is named whatever it is. */
  cards: readonly ExpenseCard[]
  currency: string
  today: string
  onChange: (rows: ReviewRow[]) => void
  /** Resolves once added; throws when refused (the review stays, saying why). */
  onAdd: (inputs: ExpenseInput[]) => Promise<void>
  /** "Discard and scan another" (the sheet asks first when anything is ticked). */
  onAgain: () => void
  /** The sheet's "press again to discard" is showing. */
  discardSure: boolean
}

/** Rows shown at first, and added by each "Show more". */
const PAGE = 10

/**
 * What a reading found, before anything is saved: one row per expense, ticked
 * unless it looks like one already saved (shown next to its match). Each row
 * is a summary line; its fields open on the pencil, and rows with something
 * to check start open. Nothing is added until "Add N".
 */
export default function ScanReview({ result, rows, cards, currency, today, onChange, onAdd, onAgain, discardSure }: Props) {
  const { t, tn } = useLang()
  const money = useMoney()
  const baseId = useId()
  const [alert, setAlert] = useState<'none' | 'rows' | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // A new key remounts the list showing at least `first` rows (to bring a problem row into view).
  const [paging, setPaging] = useState({ key: 0, first: PAGE })
  const [focusRow, setFocusRow] = useState<string | null>(null)

  const active = cards.filter((c) => !c.archived)
  const digits = currencyDigits(currency)
  const ticked = rows.filter((r) => r.include).length
  const anyUnmatched = rows.some((r) => r.cardHow === 'none')
  const cardName = (id: string | null): string => (id === null ? t('spend.noCard') : (cards.find((c) => c.id === id)?.name ?? t('spend.noCard')))

  const patch = (key: string, change: Partial<ReviewRow>): void => {
    setAlert(null)
    onChange(rows.map((r) => (r.key === key ? { ...r, ...change } : r)))
  }

  // The first field with a problem takes focus once its row has rendered open.
  useEffect(() => {
    if (focusRow === null) return
    const row = rows.find((r) => r.key === focusRow)
    const field = row && expenseAmountProblem(row.amount, currency) ? 'amount' : 'date'
    document.getElementById(`${baseId}-${focusRow}-${field}`)?.focus()
    setFocusRow(null)
  }, [focusRow, rows, currency, baseId])

  const add = async (): Promise<void> => {
    if (busy) return
    setRefusal(null)
    if (ticked === 0) {
      setAlert('none')
      return
    }
    const bad = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.include && reviewRowProblem(r, currency) !== null)
    if (bad.length > 0) {
      const open = new Set(bad.map(({ r }) => r.key))
      onChange(rows.map((r) => (open.has(r.key) ? { ...r, open: true } : r)))
      const last = bad[bad.length - 1].i
      setPaging((p) => ({ key: p.key + 1, first: Math.max(p.first, Math.ceil((last + 1) / PAGE) * PAGE) }))
      setAlert('rows')
      setFocusRow(bad[0].r.key)
      return
    }
    setBusy(true)
    try {
      await onAdd(reviewInputs(rows, currency))
    } catch (err) {
      setRefusal(refusalText(err, t))
    } finally {
      setBusy(false)
    }
  }

  const amountText = (r: ReviewRow): string => {
    const n = parseAmountText(r.amount, digits)
    return typeof n === 'number' ? money.plain(r.refund ? -n : n) : r.amount || '—'
  }

  const renderRow = (r: ReviewRow) => {
    const id = `${baseId}-${r.key}`
    const merchant = merchantLabel(r.merchant, t)
    const amount = amountText(r)
    const amountProblem = r.open ? expenseAmountProblem(r.amount, currency) : null
    const dateProblem = r.open ? expenseDateProblem(r.date) : null
    const dup = r.duplicateOf
    return (
      <li key={r.key} className={`exp-review-row${dup ? ' is-dup' : ''}${r.include ? '' : ' is-off'}${r.open ? ' is-open' : ''}`} data-key={r.key}>
        <div className="exp-review-sum">
          <label className="exp-review-pick">
            <input
              type="checkbox"
              className="exp-review-include"
              checked={r.include}
              aria-label={t('scan.includeAria', { merchant, amount })}
              onChange={(e) => patch(r.key, { include: e.target.checked })}
            />
          </label>
          <span className="exp-review-main">
            <span className="exp-review-merchant-text" title={merchant}>
              {merchant}
            </span>
            <span className="exp-review-line">
              <span className="exp-review-date-text">{shortDate(r.date)}</span>
              <span className="exp-review-meta">
                <span>{t(categoryKey(r.category))}</span>
                <span>{cardName(r.cardId)}</span>
              </span>
            </span>
          </span>
          <span className={`exp-review-amount-text${r.refund ? ' refund' : ''}`}>{amount}</span>
          <button
            type="button"
            className="btn-icon exp-review-edit"
            aria-expanded={r.open}
            aria-controls={`${id}-fields`}
            aria-label={t('scan.editRow', { merchant })}
            onClick={() => patch(r.key, { open: !r.open })}
          >
            <PencilIcon />
          </button>
        </div>

        {(dup || r.confidence === 'low' || r.dateGuessed || r.pending || r.cardHow === 'last4' || r.cardUnknownLast4) && (
          <div className="exp-review-notes">
            {dup && (
              <div className="exp-review-match">
                {t('scan.dupOf', { merchant: merchantLabel(dup.merchant, t), card: cardName(dup.cardId), amount: money.plain(dup.amount), date: humanDate(dup.date) })}
              </div>
            )}
            {(r.confidence === 'low' || r.dateGuessed) && <p className="exp-review-check">{t(r.confidence === 'low' ? 'scan.check' : 'scan.checkDate')}</p>}
            {r.pending && <span className="exp-review-pending">{t('scan.pending')}</span>}
            {r.cardHow === 'last4' && <span className="hint exp-review-cardhow">{t('scan.cardMatched')}</span>}
            {r.cardUnknownLast4 && r.cardHow !== 'user' && <span className="hint exp-review-cardhow">{t('scan.cardUnknown', { last4: r.cardUnknownLast4 })}</span>}
          </div>
        )}

        {r.open && (
          <div className="exp-review-fields" id={`${id}-fields`}>
            <label className="field exp-review-field-date">
              <span className="field-label">{t('quick.date')}</span>
              <input
                id={`${id}-date`}
                type="date"
                className="exp-review-date"
                value={r.date}
                aria-invalid={dateProblem !== null}
                aria-describedby={describedBy(dateProblem && `${id}-date-err`)}
                onChange={(e) => patch(r.key, { date: e.target.value, dateGuessed: false })}
              />
              <FieldError id={`${id}-date-err`} problem={dateProblem} />
            </label>
            <div className="field exp-review-field-amount">
              <label className="field-label" htmlFor={`${id}-amount`}>
                {t('exp.amount')}
              </label>
              <div className="exp-review-amount-row">
                <input
                  id={`${id}-amount`}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  className="exp-review-amount"
                  value={r.amount}
                  aria-invalid={amountProblem !== null}
                  aria-describedby={describedBy(amountProblem && `${id}-amount-err`)}
                  onChange={(e) => patch(r.key, { amount: e.target.value })}
                />
                <button type="button" className="scope-btn exp-review-refund" aria-pressed={r.refund} onClick={() => patch(r.key, { refund: !r.refund })}>
                  {t('exp.refund')}
                </button>
              </div>
              <FieldError id={`${id}-amount-err`} problem={amountProblem} />
            </div>
            <label className="field field-wide">
              <span className="field-label">{t('exp.merchant')}</span>
              <input type="text" className="exp-review-merchant" maxLength={80} value={r.merchant} onChange={(e) => patch(r.key, { merchant: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">{t('exp.category')}</span>
              <select className="exp-review-cat" value={r.category} onChange={(e) => patch(r.key, { category: e.target.value as ReviewRow['category'] })}>
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(categoryKey(c))}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{t('exp.card')}</span>
              <select
                className="exp-review-card"
                value={r.cardId ?? ''}
                onChange={(e) => patch(r.key, { cardId: e.target.value === '' ? null : e.target.value, cardHow: 'user' })}
              >
                <option value="">{t('spend.noCard')}</option>
                {active.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                {r.cardId !== null && !active.some((c) => c.id === r.cardId) && <option value={r.cardId}>{cardName(r.cardId)}</option>}
              </select>
            </label>
          </div>
        )}
      </li>
    )
  }

  return (
    <div className="exp-review">
      <p className="hint exp-review-kind">
        {t(`scan.kind.${result.kind}`)} · {rows.length === 1 ? t('scan.foundOne') : t('scan.found', { expenses: tn('expense', rows.length) })}
      </p>
      {result.kind === 'wallet' && <p className="hint exp-review-asof">{t('scan.asOf', { date: humanDate(today) })}</p>}
      {result.sample && <p className="draft-note exp-sample">{t('scan.sample')}</p>}
      {result.currency && result.currency !== currency && <p className="draft-note exp-currency-warn">{t('scan.currencyMismatch', { found: result.currency, currency })}</p>}
      {result.warnings.length > 0 && (
        <section className="exp-warnings">
          <h3>{t('scan.warnings')}</h3>
          <ul>
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="exp-review-bulk">
        <button type="button" className="btn btn-ghost exp-review-all" onClick={() => onChange(setAllIncluded(rows, true))}>
          {t('scan.tickAll')}
        </button>
        <button type="button" className="btn btn-ghost exp-review-none" onClick={() => onChange(setAllIncluded(rows, false))}>
          {t('scan.tickNone')}
        </button>
        <span className="hint exp-review-count" aria-live="polite">
          {t('scan.ticked', { k: ticked, n: rows.length })}
        </span>
      </div>

      {active.length > 0 && anyUnmatched && (
        <label className="field exp-review-cardall">
          <span className="field-label">{t('scan.cardAll')}</span>
          <select defaultValue="" onChange={(e) => onChange(applyCardToUnmatched(rows, e.target.value === '' ? null : e.target.value))}>
            <option value="">{t('spend.noCard')}</option>
            {active.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <Paged key={paging.key} items={rows} first={paging.first} step={PAGE} className="exp-review-list" render={renderRow} />

      {alert && (
        <p className="hint exp-review-problem" role="alert">
          {t(alert === 'none' ? 'scan.noneSelected' : 'scan.rowProblem')}
        </p>
      )}
      {discardSure && (
        <p className="hint exp-review-discard" role="alert">
          {t('scan.discardSure')}
        </p>
      )}
      {refusal && (
        <p className="form-error" role="alert">
          {refusal}
        </p>
      )}

      <footer className="modal-actions exp-review-actions">
        <button type="button" className="btn btn-ghost exp-review-again" onClick={onAgain}>
          {t('scan.again')}
        </button>
        <span className="spacer" />
        {/* Never disabled: with nothing ticked, or a ticked row to fix, it says so instead. */}
        <button type="button" className="btn btn-primary exp-review-add" onClick={() => void add()}>
          {t('scan.addN', { expenses: tn('expense', ticked) })}
        </button>
      </footer>
    </div>
  )
}

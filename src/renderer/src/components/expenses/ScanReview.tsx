import { useEffect, useId, useMemo, useState } from 'react'
import type { ExtractResult } from '../../../../shared/expenseExtraction'
import { EXPENSE_CATEGORIES, type Expense, type ExpenseCard, type ExpenseInput } from '../../../../shared/types'
import { refusalText } from '../../lib/betForm'
import { categoryKey } from '../../lib/categories'
import { codeAmount, currencySymbol, payCurrencyOptions } from '../../lib/currency'
import { humanDate, shortDate } from '../../lib/dates'
import { expenseAmountProblem, expenseDateProblem, merchantLabel, paidInAnother } from '../../lib/expenseForm'
import { parseRateText, settledFx } from '../../lib/expenseFx'
import {
  applyCardToUnmatched,
  pictureCurrency,
  refreshDuplicates,
  reviewAdds,
  reviewRowProblem,
  rowLacksRate,
  rowMoney,
  setAllIncluded,
  type ReviewMoney,
  type ReviewRow
} from '../../lib/expenseReview'
import { useLang } from '../../lib/i18n'
import { useMoney } from '../../lib/money'
import FieldError, { describedBy } from '../FieldError'
import { PencilIcon } from '../icons'
import CategoryIcon from './CategoryIcon'
import Paged from '../Paged'
import { originLine } from './fxText'
import { useRates } from './useRates'

interface Props {
  result: ExtractResult
  rows: ReviewRow[]
  /** All the cards: the pickers offer the active ones, a row's own card is named whatever it is. */
  cards: readonly ExpenseCard[]
  /** Every saved expense (queued ones too): a row like one of them is a possible duplicate. */
  existing: readonly Expense[]
  /** The main currency: what every expense is saved in. The picture may be in another. */
  currency: string
  /** The other currency last used on this device, offered first after the main one. */
  lastCurrency: string | null
  today: string
  onChange: (rows: ReviewRow[]) => void
  /** A change worked out from the rows as they are now (their duplicates), not an edit of the person's. */
  onFollow: (follow: (rows: ReviewRow[]) => ReviewRow[]) => void
  /** Resolves once added; throws when refused (the review stays, saying why). `added`: the keys of the rows added. */
  onAdd: (inputs: ExpenseInput[], added: string[]) => Promise<void>
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
 *
 * A picture is in one currency, chosen at the top (what the reading says,
 * else the main one: a bare "$" can be any dollar). In another currency every
 * row shows what was read and what it comes to in the main one, at its day's
 * rate; a row with no rate says so and is not added until it has one (typed
 * on the row, or once for all of them at the top).
 */
export default function ScanReview({ result, rows, cards, existing, currency: main, lastCurrency, today, onChange, onFollow, onAdd, onAgain, discardSure }: Props) {
  const { t, tn } = useLang()
  const money = useMoney()
  const baseId = useId()
  const [alert, setAlert] = useState<'none' | 'rows' | 'norate' | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // A new key remounts the list showing at least `first` rows (to bring a problem row into view).
  const [paging, setPaging] = useState({ key: 0, first: PAGE })
  const [focusRow, setFocusRow] = useState<string | null>(null)
  // The currency of the picture: what the reading says, until the person says otherwise.
  const read = pictureCurrency(result, main)
  const [paidIn, setPaidIn] = useState(read)
  // One rate for every row that has none (the service has none for the pair, or can't be reached).
  const [rateAll, setRateAll] = useState('')

  const active = cards.filter((c) => !c.archived)
  const foreign = paidIn !== main
  // The rates of the rows' days, for the rows whose rate the person has not typed.
  const wantedDates = useMemo(() => rows.filter((r) => r.fx === null || r.fx.text.trim() === '').map((r) => r.date), [rows])
  const rates = useRates({ enabled: foreign, from: paidIn, to: main, dates: wantedDates })
  const all = parseRateText(rateAll)
  const allRate = typeof all === 'number' ? all : null
  const m: ReviewMoney = useMemo(() => ({ currency: paidIn, main, rates: rates.found, all: allRate }), [paidIn, main, rates.found, allRate])

  const ticked = rows.filter((r) => r.include).length
  // Ticked rows with no rate from anywhere: left out of "Add N" until they have one. A row whose rate is still being
  // asked for is not counted out yet (the button doesn't flash "Add 0" each time a review opens).
  const waiting = rows.filter((r) => r.include && rowLacksRate(r, m) && rates.of(r.date) !== 'loading').length
  const adding = ticked - waiting
  // A date whose rate could not be had, and why (the first such row's reason: one pair, so mostly one reason). The box
  // for one rate for all such rows shows then (and stays while it holds text), and the line under the currency says why.
  const failure = ((): 'offline' | 'unsupported' | 'unavailable' | null => {
    if (!foreign) return null
    for (const r of rows) {
      if (r.fx !== null && r.fx.text.trim() !== '') continue
      const state = rates.of(r.date)
      if (state !== undefined && state !== 'loading' && !state.ok) return state.reason
    }
    return null
  })()
  const anyUnmatched = rows.some((r) => r.cardHow === 'none')
  const cardName = (id: string | null): string => (id === null ? t('spend.noCard') : (cards.find((c) => c.id === id)?.name ?? t('spend.noCard')))
  const mainSymbol = currencySymbol(main)
  const currencies = useMemo(() => payCurrencyOptions(main, lastCurrency, read), [main, lastCurrency, read])

  const patch = (key: string, change: Partial<ReviewRow>): void => {
    setAlert(null)
    onChange(rows.map((r) => (r.key === key ? { ...r, ...change } : r)))
  }
  /** Leaving a rate or converted box left empty: nothing is typed on the row any more (its day's rate comes back). */
  const leaveFx = (r: ReviewRow): void => {
    if (settledFx(r.fx) !== r.fx) onChange(rows.map((x) => (x.key === r.key ? { ...x, fx: null } : x)))
  }

  // The duplicates follow the saved expenses while the review is open, and what the rows come to: the currency of the
  // picture, and each rate as it arrives (a row paid in another currency is matched by what was paid, and by its
  // amount in the main currency once that is known).
  useEffect(() => {
    onFollow((current) => refreshDuplicates(current, existing, m) as ReviewRow[])
    // onFollow is the sheet's setRows in a new closure each render: not a reason to look again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing, m])

  // The first field with a problem takes focus once its row has rendered open.
  useEffect(() => {
    if (focusRow === null) return
    const row = rows.find((r) => r.key === focusRow)
    const field = !row ? 'date' : expenseAmountProblem(row.amount, paidIn) ? 'amount' : expenseDateProblem(row.date) ? 'date' : row.fx?.lead === 'converted' ? 'converted' : row.fx ? 'rate' : 'date'
    document.getElementById(`${baseId}-${focusRow}-${field}`)?.focus()
    setFocusRow(null)
  }, [focusRow, rows, paidIn, baseId])

  const add = async (): Promise<void> => {
    if (busy) return
    setRefusal(null)
    if (ticked === 0) {
      setAlert('none')
      return
    }
    const bad = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.include && reviewRowProblem(r, m) !== null)
    if (bad.length > 0) {
      const open = new Set(bad.map(({ r }) => r.key))
      onChange(rows.map((r) => (open.has(r.key) ? { ...r, open: true } : r)))
      const last = bad[bad.length - 1].i
      setPaging((p) => ({ key: p.key + 1, first: Math.max(p.first, Math.ceil((last + 1) / PAGE) * PAGE) }))
      setAlert('rows')
      setFocusRow(bad[0].r.key)
      return
    }
    const { inputs, keys } = reviewAdds(rows, m)
    // Every ticked row still waits for a rate: nothing to add yet.
    if (inputs.length === 0) {
      setAlert('norate')
      return
    }
    setBusy(true)
    try {
      await onAdd(inputs, keys)
    } catch (err) {
      setRefusal(refusalText(err, t))
    } finally {
      setBusy(false)
    }
  }

  const renderRow = (r: ReviewRow) => {
    const id = `${baseId}-${r.key}`
    const merchant = merchantLabel(r.merchant, t)
    const sums = rowMoney(r, m)
    const sign = r.refund ? -1 : 1
    // What was read, written with its code when the picture is in another currency ("USD 12.00").
    const original = sums.foreign && sums.paid !== null ? codeAmount(sign * sums.paid, paidIn) : null
    // The amount in the main currency: what the row is saved as. Unknown without a rate.
    const amount = sums.amount !== null ? money.plain(sums.amount) : sums.foreign ? (original ?? (r.amount || '—')) : r.amount || '—'
    const noRate = rowLacksRate(r, m) && rates.of(r.date) !== 'loading'
    const amountProblem = r.open ? expenseAmountProblem(r.amount, paidIn) : null
    const dateProblem = r.open ? expenseDateProblem(r.date) : null
    const view = sums.view
    const fxTyped = r.fx !== null && r.fx.text.trim() !== ''
    const rateProblem = r.open && fxTyped ? (view?.rateProblem ?? null) : null
    const convertedProblem = r.open && fxTyped ? (view?.convertedProblem ?? null) : null
    const dup = r.duplicateOf
    const dupAmount = dup ? (paidInAnother(dup, main) ? t('scan.dupOriginal', { amount: money.plain(dup.amount), original: codeAmount(dup.originalAmount, dup.originalCurrency) }) : money.plain(dup.amount)) : ''
    return (
      <li key={r.key} className={`exp-review-row${dup ? ' is-dup' : ''}${r.include ? '' : ' is-off'}${r.open ? ' is-open' : ''}${noRate ? ' is-norate' : ''}`} data-key={r.key}>
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
                <span>
                  <CategoryIcon category={r.category} size={12} />
                  {t(categoryKey(r.category))}
                </span>
                <span>{cardName(r.cardId)}</span>
              </span>
            </span>
          </span>
          <span className="exp-review-money">
            <span className={`exp-review-amount-text${r.refund ? ' refund' : ''}${sums.foreign && sums.amount === null ? ' is-unknown' : ''}`}>{amount}</span>
            {original !== null && sums.amount !== null && <span className="exp-review-original">{original}</span>}
          </span>
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

        {(dup || noRate || r.confidence === 'low' || r.dateGuessed || r.pending || r.cardHow === 'last4' || r.cardUnknownLast4) && (
          <div className="exp-review-notes">
            {dup && <div className="exp-review-match">{t('scan.dupOf', { merchant: merchantLabel(dup.merchant, t), card: cardName(dup.cardId), amount: dupAmount, date: humanDate(dup.date) })}</div>}
            {noRate && <p className="exp-review-check exp-review-norate">{t('scan.noRate', { currency: main })}</p>}
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
                {t('exp.amount')} {foreign && <span className="field-opt">{paidIn}</span>}
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
            {foreign && view && (
              <div className="exp-review-fx" role="group" aria-label={t('exp.fxGroup', { currency: main })}>
                <div className="field exp-review-field-rate">
                  <label className="field-label" htmlFor={`${id}-rate`}>
                    {t('exp.fxRate')} <span className="field-opt">{t('exp.fxRateUnit', { from: paidIn, to: main })}</span>
                  </label>
                  <input
                    id={`${id}-rate`}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    className="exp-review-rate"
                    value={view.rateText}
                    aria-invalid={rateProblem !== null}
                    aria-describedby={describedBy(rateProblem && `${id}-rate-err`, `${id}-fx-line`)}
                    onChange={(e) => patch(r.key, { fx: { lead: 'rate', text: e.target.value } })}
                    onBlur={() => leaveFx(r)}
                  />
                </div>
                <div className="field exp-review-field-converted">
                  <label className="field-label" htmlFor={`${id}-converted`}>
                    {t('exp.fxConverted', { currency: main })}
                  </label>
                  <div className="amount-wrap exp-amount-wrap" style={{ ['--cur-ch' as string]: mainSymbol.length }}>
                    <span className="amount-cur">{mainSymbol}</span>
                    <input
                      id={`${id}-converted`}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      className="exp-review-converted"
                      value={view.convertedText}
                      aria-invalid={convertedProblem !== null}
                      aria-describedby={describedBy(convertedProblem && `${id}-converted-err`, `${id}-fx-line`)}
                      onChange={(e) => patch(r.key, { fx: { lead: 'converted', text: e.target.value } })}
                      onBlur={() => leaveFx(r)}
                    />
                  </div>
                </div>
                <FieldError id={`${id}-rate-err`} problem={rateProblem} />
                <FieldError id={`${id}-converted-err`} problem={convertedProblem} />
                <p className="hint exp-review-fx-line" id={`${id}-fx-line`}>
                  {originLine({ origin: view.origin, state: r.fx === null ? rates.of(r.date) : undefined, typedEmpty: r.fx !== null && !fxTyped, from: paidIn, to: main, today, t })}
                </p>
              </div>
            )}
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

      {/* The currency of the picture: the amounts read are in it. Not the main one: each row is converted. */}
      <div className="exp-review-money-bar">
        <label className="field exp-review-currency-field">
          <span className="field-label">{t('scan.currency')}</span>
          <select
            className="exp-review-currency"
            value={paidIn}
            onChange={(e) => {
              setAlert(null)
              setPaidIn(e.target.value)
            }}
          >
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        {foreign && (failure !== null || rateAll !== '') && (
          <div className="field exp-review-rateall-field">
            <label className="field-label" htmlFor={`${baseId}-rateall`}>
              {t('scan.rateAll')} <span className="field-opt">{t('exp.fxRateUnit', { from: paidIn, to: main })}</span>
            </label>
            <input
              id={`${baseId}-rateall`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              className="exp-review-rateall"
              value={rateAll}
              aria-invalid={all === 'invalid'}
              aria-describedby={describedBy(all === 'invalid' && `${baseId}-rateall-err`)}
              onChange={(e) => {
                setAlert(null)
                setRateAll(e.target.value)
              }}
            />
            <FieldError id={`${baseId}-rateall-err`} problem={all === 'invalid' ? { key: 'field.rateInvalid' } : null} />
          </div>
        )}
      </div>
      {foreign ? (
        <p className="hint exp-review-fxinfo" aria-live="polite">
          {rates.loading ? t('scan.fxLoading') : failure ? t(`scan.fxNone.${failure}`, { from: paidIn, to: main }) : t('scan.fxInfo', { to: main, source: t('exp.fxSource') })}
        </p>
      ) : (
        result.currency === null && <p className="hint exp-review-fxinfo">{t('scan.currencyUnread', { currency: main })}</p>
      )}

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

      {waiting > 0 && (
        <p className="hint exp-review-waiting" role="status">
          {t('scan.noRateLeft', { n: waiting })}
        </p>
      )}
      {alert && (
        <p className="hint exp-review-problem" role="alert">
          {t(alert === 'none' ? 'scan.noneSelected' : alert === 'norate' ? 'scan.noRateNone' : 'scan.rowProblem')}
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
        {/* Never disabled: with nothing ticked, a ticked row to fix or none with a rate yet, it says so instead. */}
        <button type="button" className="btn btn-primary exp-review-add" onClick={() => void add()}>
          {t('scan.addN', { expenses: tn('expense', adding) })}
        </button>
      </footer>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { EXPENSE_CATEGORIES, type Expense, type ExpenseCard } from '../../../../shared/types'
import { categoryKey, toCategory } from '../../lib/categories'
import { codeAmount } from '../../lib/currency'
import { humanDate, monthInline, type MonthKey } from '../../lib/dates'
import { merchantLabel, paidInAnother } from '../../lib/expenseForm'
import { rateText } from '../../lib/fx'
import { useLang } from '../../lib/i18n'
import { useMoney } from '../../lib/money'
import { cardFilterChoices, filterExpenses, groupExpensesByDay, listSummary, NO_CARD, type ExpenseFilter } from '../../lib/spend'
import { NARROW, useMedia } from '../../lib/useMedia'
import { CloseIcon, DownloadIcon, PencilIcon, TrashIcon } from '../icons'
import CategoryIcon from './CategoryIcon'

interface Props {
  /** The card itself: ExpensesView scrolls it into view and focuses its heading when a line above shows its expenses. */
  listRef: RefObject<HTMLElement | null>
  ym: MonthKey
  /** The month's expenses. */
  expenses: readonly Expense[]
  cards: readonly ExpenseCard[]
  cardsLoaded: boolean
  /** The main currency: every amount is in it; an expense paid in another also shows what was paid. */
  currency: string
  filter: ExpenseFilter
  onFilter: (f: ExpenseFilter) => void
  loaded: boolean
  offline: boolean
  onEdit: (e: Expense) => void
  onDelete: (e: Expense) => void
  onExport: () => void
  canExport: boolean
}

/** Rows shown at first, and added by each "Show more". */
const PAGE = 60

/**
 * The month's expenses, newest day first, each day with its total: a table
 * on a computer (edit and delete on the row), a list on a phone (the whole
 * row opens the expense, whose sheet has Delete). Amounts are neutral ink; a
 * refund is green, and says so in words. An expense paid in another currency
 * also shows what was paid, small and neutral, written with its code
 * ("USD 12.00"); the rate is in its tooltip and in its sheet.
 *
 * While it is filtered, a quiet line above the rows says by what (a chip
 * per card or category, each with its ×), how many and how much, and has
 * Show all; the heading says it too, for whoever lands on it.
 */
export default function ExpenseList({ listRef, ym, expenses, cards, cardsLoaded, currency, filter, onFilter, loaded, offline, onEdit, onDelete, onExport, canExport }: Props) {
  const { t, tn } = useLang()
  const money = useMoney()
  const narrow = useMedia(NARROW)
  const [shown, setShown] = useState(PAGE)
  // A new filter, from the boxes or from a line above, starts again from the first page.
  const [shownFor, setShownFor] = useState(filter)
  if (shownFor !== filter) {
    setShownFor(filter)
    setShown(PAGE)
  }
  const headingRef = useRef<HTMLHeadingElement>(null)
  const showAllRef = useRef<HTMLButtonElement>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const known = useMemo(() => new Set(cards.map((c) => c.id)), [cards])
  const cardName = (e: Expense): string => {
    if (!cardsLoaded) return t('exp.loadingShort')
    const card = e.cardId === null ? undefined : cards.find((c) => c.id === e.cardId)
    return card ? card.name : t('spend.noCard')
  }
  // The cards the filter offers: the active ones, any that appears this month (archived kept) and the one chosen, then
  // "No card". The list filters by what the box shows.
  const choice = useMemo(() => cardFilterChoices(cards, expenses, filter.card), [cards, expenses, filter.card])
  const filtered = useMemo(() => filterExpenses(expenses, { ...filter, card: choice.value }, known), [expenses, filter, choice.value, known])
  // The page's rows, each day's total from all of the day's rows.
  const days = useMemo(() => groupExpensesByDay(filtered, shown), [filtered, shown])
  const hasFilters = choice.value !== 'all' || filter.category !== 'all' || filter.query.trim() !== ''
  const setFilter = (patch: Partial<ExpenseFilter>): void => onFilter({ ...filter, ...patch })
  const summary = useMemo(() => listSummary(filtered), [filtered])
  // What the list is narrowed to, by name: the card's (or "No card"), the category's.
  const cardLabel = choice.value === 'all' ? null : choice.value === NO_CARD ? t('spend.noCard') : (cards.find((c) => c.id === choice.value)?.name ?? null)
  const categoryLabel = filter.category === 'all' ? null : t(categoryKey(filter.category))
  const query = filter.query.trim()
  /** A chip's ×: that filter goes; the focus moves on to Show all, or to the heading once nothing is left to show all of. */
  const unfilter = (patch: Pick<ExpenseFilter, 'card'> | Pick<ExpenseFilter, 'category'>): void => {
    setFilter(patch)
    const left = ('card' in patch ? categoryLabel !== null : cardLabel !== null) || query !== ''
    ;(left ? showAllRef.current : headingRef.current)?.focus()
  }
  const showAll = (): void => {
    setFilter({ card: 'all', category: 'all', query: '' })
    headingRef.current?.focus()
  }

  const deleteClick = (e: Expense): void => {
    if (timer.current) clearTimeout(timer.current)
    if (confirming === e.id) {
      setConfirming(null)
      onDelete(e)
      return
    }
    setConfirming(e.id)
    timer.current = setTimeout(() => setConfirming(null), 3000)
  }

  const amountCell = (e: Expense) => (
    <>
      {money.plain(e.amount)}
      {e.amount < 0 && <span className="visually-hidden"> ({t('explist.refund')})</span>}
    </>
  )

  /** What was paid, for an expense paid in another currency: "USD 12.00", with the rate in its tooltip. */
  const originalCell = (e: Expense) => {
    if (!paidInAnother(e, currency)) return null
    const original = codeAmount(e.originalAmount, e.originalCurrency)
    return (
      <span className="exp-original" title={t('explist.rateTitle', { original, from: e.originalCurrency, rate: rateText(e.fxRate, 4), to: currency })}>
        <span aria-hidden="true">{original}</span>
        <span className="visually-hidden">{t('explist.paid', { amount: original })}</span>
      </span>
    )
  }

  let body
  if (!loaded) body = <p className="empty-state exp-empty">{t(offline ? 'exp.offlineNotLoaded' : 'exp.loading')}</p>
  else if (expenses.length === 0) body = <p className="empty-state exp-empty">{t('explist.empty', { month: monthInline(ym) })}</p>
  else
    body = (
      <>
        <div className="filters exp-filters">
          <input
            type="search"
            className="filter-search exp-search"
            placeholder={t('explist.search')}
            aria-label={t('explist.search')}
            value={filter.query}
            onChange={(e) => setFilter({ query: e.target.value })}
          />
          <select className="exp-filter-card" aria-label={t('explist.colCard')} value={choice.value} disabled={!cardsLoaded} onChange={(e) => setFilter({ card: e.target.value })}>
            <option value="all">{t('explist.allCards')}</option>
            {choice.cards.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value={NO_CARD}>{t('spend.noCard')}</option>
          </select>
          <select className="exp-filter-cat" aria-label={t('explist.colCategory')} value={filter.category} onChange={(e) => setFilter({ category: e.target.value === 'all' ? 'all' : toCategory(e.target.value) })}>
            <option value="all">{t('explist.allCategories')}</option>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(categoryKey(c))}
              </option>
            ))}
          </select>
        </div>

        {hasFilters && (
          <div className="exp-active">
            {cardLabel !== null && (
              <button type="button" className="chip exp-active-chip exp-active-card" aria-label={t('explist.unfilter', { name: cardLabel })} onClick={() => unfilter({ card: 'all' })}>
                <span className="exp-active-name">{cardLabel}</span>
                <CloseIcon size={12} />
              </button>
            )}
            {categoryLabel !== null && (
              <button type="button" className="chip exp-active-chip exp-active-cat" aria-label={t('explist.unfilter', { name: categoryLabel })} onClick={() => unfilter({ category: 'all' })}>
                <span className="exp-active-name">{categoryLabel}</span>
                <CloseIcon size={12} />
              </button>
            )}
            {summary.count > 0 && (
              <span className="exp-active-sum">
                <span>{tn('expense', summary.count)}</span>
                <span>{money.plain(summary.total)}</span>
              </span>
            )}
            <button type="button" ref={showAllRef} className="exp-show-all" onClick={showAll}>
              {t('explist.showAll')}
            </button>
          </div>
        )}

        {filtered.length === 0 ? (
          <p className="empty-state exp-empty">{t('explist.noMatch')}</p>
        ) : narrow ? (
          <ol className="exp-days">
            {days.map((day) => (
              <li key={day.date} className="exp-day">
                <h3 className="exp-day-head">
                  <span>{humanDate(day.date)}</span>
                  <span className="exp-day-total">{money.plain(day.total)}</span>
                </h3>
                <ul className="exp-items">
                  {day.items.map((e) => {
                    const merchant = merchantLabel(e.merchant, t)
                    return (
                      <li key={e.id} className="exp-item" data-id={e.id}>
                        <button type="button" className="exp-item-open" aria-label={t('explist.edit', { merchant, date: humanDate(e.date) })} onClick={() => onEdit(e)}>
                          <CategoryIcon category={toCategory(e.category)} />
                          <span className="exp-item-top">
                            <span className={`exp-item-merchant${e.merchant.trim() === '' ? ' is-none' : ''}`}>{merchant}</span>
                            {e.source === 'ai' && <span className="tag exp-ai">{t('explist.ai')}</span>}
                            <span className={`exp-item-amount${e.amount < 0 ? ' refund' : ''}`}>{amountCell(e)}</span>
                          </span>
                          <span className="exp-item-sub">
                            <span>{t(categoryKey(toCategory(e.category)))}</span>
                            <span className="exp-item-card">{cardName(e)}</span>
                            {e.note && <span className="exp-item-note">{e.note}</span>}
                            {originalCell(e)}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
          </ol>
        ) : (
          <div className="table-wrap exp-table-wrap">
            <table className="exp-table">
              <thead>
                <tr>
                  <th>{t('explist.colMerchant')}</th>
                  <th>{t('explist.colCategory')}</th>
                  <th>{t('explist.colCard')}</th>
                  <th>{t('explist.colNote')}</th>
                  <th className="th-right">{t('explist.colAmount')}</th>
                  <th className="th-right">
                    <span className="visually-hidden">{t('explist.colActions')}</span>
                  </th>
                </tr>
              </thead>
              {days.map((day) => (
                <tbody key={day.date} className="exp-day">
                  <tr className="exp-day-row">
                    <th colSpan={6} scope="rowgroup">
                      <span>{humanDate(day.date)}</span>
                      <span className="exp-day-total">{money.plain(day.total)}</span>
                    </th>
                  </tr>
                  {day.items.map((e) => {
                    const merchant = merchantLabel(e.merchant, t)
                    const when = humanDate(e.date)
                    return (
                      <tr key={e.id} className="exp-row" data-id={e.id}>
                        <td className="exp-merchant">
                          <span className={`exp-merchant-text${e.merchant.trim() === '' ? ' is-none' : ''}`} title={e.merchant || undefined}>
                            {merchant}
                          </span>
                          {e.source === 'ai' && <span className="tag exp-ai">{t('explist.ai')}</span>}
                        </td>
                        <td className="exp-cat">
                          <CategoryIcon category={toCategory(e.category)} size={14} />
                          {t(categoryKey(toCategory(e.category)))}
                        </td>
                        <td className="exp-col-card" title={cardName(e)}>
                          {cardName(e)}
                        </td>
                        <td className="exp-note" title={e.note || undefined}>
                          {e.note || <span className="td-none">—</span>}
                        </td>
                        <td className={`exp-amount${e.amount < 0 ? ' refund' : ''}`}>
                          {originalCell(e)}
                          <span className="exp-amount-main">{amountCell(e)}</span>
                        </td>
                        <td className="td-actions">
                          <button type="button" className="btn-icon exp-edit" aria-label={t('explist.edit', { merchant, date: when })} title={t('common.edit')} onClick={() => onEdit(e)}>
                            <PencilIcon />
                          </button>
                          <button
                            type="button"
                            className={`btn-icon danger exp-delete ${confirming === e.id ? 'confirming' : ''}`}
                            aria-label={confirming === e.id ? t('common.clickAgain') : t('explist.delete', { merchant, date: when })}
                            title={confirming === e.id ? t('common.clickAgain') : t('common.delete')}
                            onClick={() => deleteClick(e)}
                          >
                            {confirming === e.id ? <span className="confirm-text">{t('common.sure')}</span> : <TrashIcon />}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              ))}
            </table>
          </div>
        )}
        {filtered.length > shown && (
          <button type="button" className="btn btn-ghost exp-more" onClick={() => setShown((n) => n + PAGE)}>
            {t('explist.more', { n: Math.min(PAGE, filtered.length - shown) })}
          </button>
        )}
      </>
    )

  // The heading says what the list is narrowed to: it is where the focus lands when a line above shows its expenses.
  const names = [cardLabel, categoryLabel, query === '' ? null : `“${query}”`].filter((n): n is string => n !== null).join(', ')
  const filteredText = loaded && expenses.length > 0 && hasFilters ? t('explist.filtered', { names, count: tn('expense', summary.count), total: money.plain(summary.total) }) : null

  return (
    <article className="card expense-list-card" ref={listRef}>
      <header className="card-head">
        <h2 className="exp-list-title" ref={headingRef} tabIndex={-1}>
          {t('explist.title')} <span className="scope-tag">{monthInline(ym)}</span>
          {filteredText !== null && <span className="visually-hidden">, {filteredText}</span>}
        </h2>
        <button type="button" className="btn btn-ghost exp-export-btn" disabled={!canExport} onClick={onExport}>
          <DownloadIcon /> {t('explist.export')}
        </button>
      </header>
      {body}
    </article>
  )
}

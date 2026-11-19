import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Expense, ExpenseBudget, ExpenseCard } from '../../../../shared/types'
import { currencyName } from '../../lib/currency'
import { currentMonth, monthLabel, sameMonth, todayStr, type MonthKey } from '../../lib/dates'
import { useLang } from '../../lib/i18n'
import { budgetLines, categoryShares, drillFilter, expensesInMonth, monthSpend, totalBudget, vsLastMonth, type Drill, type ExpenseFilter } from '../../lib/spend'
import { ChevronLeftIcon, ChevronRightIcon } from '../icons'
import BudgetsPanel from './BudgetsPanel'
import CategoryBreakdown from './CategoryBreakdown'
import ExpenseList from './ExpenseList'
import SpendChart from './SpendChart'
import SpendSummary from './SpendSummary'

export type ExpenseSettingsSection = 'cards' | 'budgets' | 'currency'

export interface ExpensesViewProps {
  ym: MonthKey
  onPrevMonth: () => void
  onNextMonth: () => void
  onThisMonth: () => void
  expenses: Expense[]
  cards: ExpenseCard[]
  budgets: ExpenseBudget[]
  expensesLoaded: boolean
  cardsLoaded: boolean
  budgetsLoaded: boolean
  settingsLoaded: boolean
  offline: boolean
  /** Migration 008 is missing: the database has no expense tables yet. */
  needs008: boolean
  /** Migration 009 is missing: an expense added or changed waits for its three columns. */
  needs009: boolean
  currency: string
  /** The first-run card's Add an expense (the same sheet as the + button and `T`). */
  onAdd: () => void
  onEdit: (e: Expense) => void
  onDelete: (e: Expense) => void
  /** Expense settings at a section: the first-run card and the budgets (the menu's Expense settings opens it too). */
  onManage: (section: ExpenseSettingsSection) => void
  onExport: () => void
}

const NO_FILTER: ExpenseFilter = { card: 'all', category: 'all', query: '' }

/** Whether the system asks for less motion: the list then comes into view at once instead of scrolling there. */
const lessMotion = (): boolean => (typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false)

/**
 * The Expenses view: the month (shared with the bets' calendar, and its
 * arrow keys), what it cost, how it went against the budgets, where the
 * money went, and the list. Everything is in the expense currency, through
 * the MoneyContext App gives this subtree. Only one view is mounted. Its bar
 * holds the month alone: adding (and scanning, from the expense sheet) is the
 * + button, and Expense settings is in the menu.
 *
 * Each line that names a card or a category (By card, the budgets, By
 * category) shows its expenses when tapped: the list below is narrowed to
 * exactly that card or that category (lib/spend.ts drillFilter), scrolled to
 * the top of the window and given the focus. The budgets' monthly total
 * shows the whole month.
 */
export default function ExpensesView(p: ExpensesViewProps) {
  const { t, lang } = useLang()
  const today = todayStr()
  const [filter, setFilter] = useState<ExpenseFilter>(NO_FILTER)
  const listRef = useRef<HTMLElement>(null)
  // Bumped by each tap on a line: the list comes into view once it shows that line's expenses.
  const [reveal, setReveal] = useState(0)
  const show = useCallback((d: Drill): void => {
    setFilter(drillFilter(d))
    setReveal((n) => n + 1)
  }, [])
  useEffect(() => {
    const list = listRef.current
    if (reveal === 0 || !list) return
    // Its heading takes the focus (keyboard and screen reader land on the list, which says what it shows), without a
    // jump of its own: the scroll brings the card's top to the window's top, under nothing (scroll-margin-top).
    list.querySelector<HTMLElement>('.exp-list-title')?.focus({ preventScroll: true })
    list.scrollIntoView?.({ behavior: lessMotion() ? 'auto' : 'smooth', block: 'start' })
  }, [reveal])

  const month = useMemo(() => monthSpend(p.expenses, p.ym, p.cards), [p.expenses, p.ym, p.cards])
  const monthList = useMemo(() => expensesInMonth(p.expenses, p.ym), [p.expenses, p.ym])
  const lines = useMemo(() => budgetLines(p.budgets, month, p.cards), [p.budgets, month, p.cards])
  const shares = useMemo(() => categoryShares(month), [month])
  const versus = useMemo(() => vsLastMonth(p.expenses, p.ym, today), [p.expenses, p.ym, today])
  const total = totalBudget(p.budgets)
  const onCurrent = sameMonth(p.ym, currentMonth())
  const first = p.expensesLoaded && p.cardsLoaded && p.budgetsLoaded && p.expenses.length === 0 && p.cards.length === 0 && p.budgets.length === 0
  const name = currencyName(p.currency, lang)

  return (
    <div className="view-panel expenses-view" role="tabpanel" id="view-panel-expenses" aria-labelledby="view-tab-expenses" tabIndex={-1}>
      <div className="exp-bar">
        <h2 className="exp-month-title">{monthLabel(p.ym)}</h2>
        <span className="tag exp-currency-code" title={t('exp.currencyTag', { name })}>
          <span aria-hidden="true">{p.currency}</span>
          <span className="visually-hidden">{t('exp.currencyTag', { name })}</span>
        </span>
        {/* The arrows come last: the Today chip appearing never moves › under the pointer. */}
        <div className="month-nav exp-month-nav">
          {!onCurrent && (
            <button type="button" className="chip exp-today" onClick={p.onThisMonth}>
              {t('common.today')}
            </button>
          )}
          <button type="button" className="nav-btn" aria-label={t('hero.prevMonth')} onClick={p.onPrevMonth}>
            <ChevronLeftIcon />
          </button>
          <button type="button" className="nav-btn" aria-label={t('hero.nextMonth')} onClick={p.onNextMonth}>
            <ChevronRightIcon />
          </button>
        </div>
      </div>

      {p.needs008 && (
        <p className="draft-note exp-migration" role="status">
          {t('exp.migration')}
        </p>
      )}
      {p.needs009 && !p.needs008 && (
        <p className="draft-note exp-migration exp-migration-009" role="status">
          {t('exp.migration009')}
        </p>
      )}

      {first ? (
        <article className="card exp-first">
          <h2>{t('exp.firstTitle')}</h2>
          <p className="hint">{t('exp.first')}</p>
          <div className="exp-first-actions">
            <button type="button" className="btn btn-primary exp-first-add" onClick={p.onAdd}>
              {t('exp.firstAdd')}
            </button>
            <button type="button" className="btn btn-ghost exp-first-cards" onClick={() => p.onManage('cards')}>
              {t('exp.firstCards')}
            </button>
            <button type="button" className="btn btn-ghost exp-first-budget" onClick={() => p.onManage('budgets')}>
              {t('exp.firstBudget')}
            </button>
          </div>
        </article>
      ) : (
        <>
          <SpendSummary
            ym={p.ym}
            month={month}
            versus={versus}
            budgets={p.budgets}
            cards={p.cards}
            cardsLoaded={p.cardsLoaded}
            today={today}
            onManageBudgets={() => p.onManage('budgets')}
            activeCard={filter.card}
            onShow={show}
          />
          <div className="spend-grid">
            <SpendChart expenses={p.expenses} cards={p.cards} cardsLoaded={p.cardsLoaded} ym={p.ym} today={today} budget={total?.monthlyLimit ?? null} />
            <BudgetsPanel lines={lines} loaded={p.budgetsLoaded} onEdit={() => p.onManage('budgets')} filter={filter} onShow={show} />
          </div>
          <CategoryBreakdown shares={shares} active={filter.category} onShow={show} />
          <ExpenseList
            listRef={listRef}
            ym={p.ym}
            expenses={monthList}
            cards={p.cards}
            cardsLoaded={p.cardsLoaded}
            currency={p.currency}
            filter={filter}
            onFilter={setFilter}
            loaded={p.expensesLoaded}
            offline={p.offline}
            onEdit={p.onEdit}
            onDelete={p.onDelete}
            onExport={p.onExport}
            canExport={p.expensesLoaded && p.cardsLoaded && p.settingsLoaded && p.expenses.length > 0}
          />
        </>
      )}
    </div>
  )
}

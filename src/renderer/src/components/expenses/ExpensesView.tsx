import { useId, useMemo, useState } from 'react'
import type { Expense, ExpenseBudget, ExpenseCard } from '../../../../shared/types'
import { currencyName } from '../../lib/currency'
import { currentMonth, monthLabel, sameMonth, todayStr, type MonthKey } from '../../lib/dates'
import { useLang } from '../../lib/i18n'
import { budgetLines, categoryShares, expensesInMonth, monthSpend, totalBudget, type ExpenseFilter } from '../../lib/spend'
import { ChevronLeftIcon, ChevronRightIcon, ReceiptIcon, SlidersIcon } from '../icons'
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
  currency: string
  /** Why the AI reading can't start now, or null. */
  scanBlocked: 'offline' | 'signed_out' | 'loading' | null
  onAdd: () => void
  onScan: () => void
  onEdit: (e: Expense) => void
  onDelete: (e: Expense) => void
  onManage: (section: ExpenseSettingsSection) => void
  onExport: () => void
}

const NO_FILTER: ExpenseFilter = { card: 'all', category: 'all', query: '' }

/**
 * The Expenses view: the month (shared with the bets' calendar, and its
 * arrow keys), what it cost, how it went against the budgets, where the
 * money went, and the list. Everything is in the expense currency, through
 * the MoneyContext App gives this subtree. Only one view is mounted.
 */
export default function ExpensesView(p: ExpensesViewProps) {
  const { t, lang } = useLang()
  const scanOffId = useId()
  const today = todayStr()
  const [filter, setFilter] = useState<ExpenseFilter>(NO_FILTER)

  const month = useMemo(() => monthSpend(p.expenses, p.ym, p.cards), [p.expenses, p.ym, p.cards])
  const monthList = useMemo(() => expensesInMonth(p.expenses, p.ym), [p.expenses, p.ym])
  const lines = useMemo(() => budgetLines(p.budgets, month, p.cards), [p.budgets, month, p.cards])
  const shares = useMemo(() => categoryShares(month), [month])
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
        <div className="exp-bar-actions">
          <button
            type="button"
            className="btn btn-ghost exp-scan-open"
            title={t('scan.openTitle')}
            disabled={p.scanBlocked !== null}
            aria-describedby={p.scanBlocked ? scanOffId : undefined}
            onClick={p.onScan}
          >
            <ReceiptIcon /> {t('scan.open')}
          </button>
          <button type="button" className="btn btn-ghost exp-manage-btn" onClick={() => p.onManage('cards')}>
            <SlidersIcon size={14} /> {t('exp.manage')}
          </button>
        </div>
        {p.scanBlocked && (
          <p className="hint exp-scan-off" id={scanOffId}>
            {t(`scan.err.${p.scanBlocked}`)}
          </p>
        )}
      </div>

      {p.needs008 && (
        <p className="draft-note exp-migration" role="status">
          {t('exp.migration')}
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
          <SpendSummary ym={p.ym} month={month} budgets={p.budgets} cards={p.cards} cardsLoaded={p.cardsLoaded} today={today} onManageBudgets={() => p.onManage('budgets')} />
          <div className="spend-grid">
            <SpendChart expenses={p.expenses} cards={p.cards} cardsLoaded={p.cardsLoaded} ym={p.ym} today={today} budget={total?.monthlyLimit ?? null} />
            <BudgetsPanel lines={lines} loaded={p.budgetsLoaded} onEdit={() => p.onManage('budgets')} />
          </div>
          <CategoryBreakdown shares={shares} active={filter.category} onPick={(category) => setFilter((f) => ({ ...f, category }))} />
          <ExpenseList
            ym={p.ym}
            expenses={monthList}
            cards={p.cards}
            cardsLoaded={p.cardsLoaded}
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

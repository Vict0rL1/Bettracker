import { useEffect, useId, useRef, useState } from 'react'
import { EXPENSE_CATEGORIES, type BudgetScope, type ExpenseBudget, type ExpenseCard } from '../../../../shared/types'
import { categoryKey } from '../../lib/categories'
import { currencySymbol } from '../../lib/currency'
import { monthInline, type MonthKey } from '../../lib/dates'
import { budgetCommit } from '../../lib/expenseForm'
import { useLang } from '../../lib/i18n'
import { useMoney } from '../../lib/money'
import type { MonthSpend } from '../../lib/spend'
import { useBox } from '../../lib/useBox'
import FieldError, { describedBy } from '../FieldError'

/** Each box's commit, by key: Expense settings runs them all on every way out (React fires no blur on unmount). */
export type CommitRegistry = Map<string, () => void>

interface Props {
  cards: ExpenseCard[]
  budgets: ExpenseBudget[]
  month: MonthSpend
  ym: MonthKey
  /** The boxes take typing only once the budgets have loaded and 008 is proven. */
  enabled: boolean
  currency: string
  registry: CommitRegistry
  onSet: (scope: BudgetScope, target: string, limit: number | null) => Promise<void>
}

interface BoxProps {
  scope: BudgetScope
  target: string
  label: string
  /** What the month spent on it. */
  spent: number
  ym: MonthKey
  current: number | null
  enabled: boolean
  currency: string
  registry: CommitRegistry
  onSet: (scope: BudgetScope, target: string, limit: number | null) => Promise<void>
}

function BudgetBox({ scope, target, label, spent, ym, current, enabled, currency, registry, onSet }: BoxProps) {
  const { t } = useLang()
  const money = useMoney()
  const id = useId()
  // Follows the saved limit until typed in: an untouched box never sends back what it shows.
  const box = useBox(current)
  const [refused, setRefused] = useState<string | null>(null)

  const commit = (): void => {
    const pending = box.pending()
    const plan = budgetCommit(pending, current, currency)
    if (plan === null) {
      if (pending !== null) box.settle(current)
      return
    }
    if (plan === 'revert') {
      setRefused((pending ?? '').trim())
      box.settle(current)
      return
    }
    setRefused(null)
    box.settle(plan.limit)
    void onSet(scope, target, plan.limit)
  }
  const commitRef = useRef(commit)
  commitRef.current = commit
  const key = `${scope}|${target}`
  useEffect(() => {
    registry.set(key, () => commitRef.current())
    return () => {
      registry.delete(key)
    }
  }, [registry, key])

  const symbol = currencySymbol(currency)
  return (
    <li className={`budget-box budget-box-${scope}`}>
      <label className="budget-box-label" htmlFor={id} title={label}>
        {label}
      </label>
      <div className="amount-wrap exp-amount-wrap budget-amount" style={{ ['--cur-ch' as string]: symbol.length }}>
        <span className="amount-cur">{symbol}</span>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          className="budget-input"
          data-scope={scope}
          data-target={target}
          placeholder={t('expset.budgetNone')}
          disabled={!enabled}
          value={box.text}
          aria-invalid={refused !== null}
          aria-describedby={describedBy(refused !== null && `${id}-err`, `${id}-spent`)}
          onChange={(e) => {
            setRefused(null)
            box.edit(e.target.value)
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
        />
      </div>
      <span className="hint budget-spent" id={`${id}-spent`}>
        {current === null
          ? t('expset.spentIn', { amount: money.plain(spent), month: monthInline(ym) })
          : t('spend.budgetOf', { spent: money.plain(spent), limit: money.plain(current) })}
      </span>
      <FieldError id={`${id}-err`} problem={refused === null ? null : { key: 'field.boxRefused', vars: { value: refused } }} />
    </li>
  )
}

/**
 * The monthly budgets: the total, one per active card, one per category.
 * All optional; empty (or 0) means none. A box commits on Enter, on leaving
 * it, and on every way the dialog closes; nonsense goes back to the saved
 * value and says so.
 */
export default function BudgetEditor({ cards, budgets, month, ym, enabled, currency, registry, onSet }: Props) {
  const { t } = useLang()
  const limitOf = (scope: BudgetScope, target: string): number | null =>
    budgets.find((b) => b.scope === scope && (scope === 'card' ? b.target.toLowerCase() === target.toLowerCase() : b.target === target))?.monthlyLimit ?? null
  const common = { ym, enabled, currency, registry, onSet }

  return (
    <section className="expset-section expset-budgets" aria-labelledby="expset-budgets-title">
      <h3 id="expset-budgets-title">{t('expset.budgets')}</h3>
      <p className="hint">{t('expset.budgetsHint')}</p>
      <ul className="budget-boxes">
        <BudgetBox scope="total" target="" label={t('budget.total')} spent={month.total} current={limitOf('total', '')} {...common} />
        {cards
          .filter((c) => !c.archived)
          .map((c) => (
            <BudgetBox key={c.id} scope="card" target={c.id} label={c.name} spent={month.byCard.get(c.id) ?? 0} current={limitOf('card', c.id)} {...common} />
          ))}
        {EXPENSE_CATEGORIES.map((c) => (
          <BudgetBox key={c} scope="category" target={c} label={t(categoryKey(c))} spent={month.byCategory.get(c) ?? 0} current={limitOf('category', c)} {...common} />
        ))}
      </ul>
    </section>
  )
}

import type { ExpenseBudget, ExpenseCard } from '../../../../shared/types'
import { monthInline, type MonthKey } from '../../lib/dates'
import { useLang } from '../../lib/i18n'
import { useMoney } from '../../lib/money'
import { budgetState, NO_CARD, pace, totalBudget, type MonthSpend } from '../../lib/spend'
import { inkOf } from './inks'

interface Props {
  ym: MonthKey
  month: MonthSpend
  budgets: readonly ExpenseBudget[]
  cards: readonly ExpenseCard[]
  cardsLoaded: boolean
  today: string
  onManageBudgets: () => void
}

/** Per-card lines shown before "+n more". */
const TOP_CARDS = 3

/**
 * The month in four figures, one strip like the bets' key numbers: what was
 * spent (net of refunds), the budget left (the tile opens the budgets), what
 * each card spent, and the daily average with where the month is heading.
 * Neutral ink throughout; only a budget near or over its limit takes colour.
 */
export default function SpendSummary({ ym, month, budgets, cards, cardsLoaded, today, onManageBudgets }: Props) {
  const { t, tn } = useLang()
  const money = useMoney()

  const totalValue = money.plain(month.total)

  const total = totalBudget(budgets)
  const state = budgetState(month.total, total?.monthlyLimit ?? null)
  const left = state.left
  const budgetValue = left === null ? '—' : left < 0 ? t('spend.budgetOver', { amount: money.plain(-left) }) : money.plain(left)
  const budgetTone = state.level === 'over' ? 'loss' : state.level === 'near' ? 'near' : ''
  const fill = state.level === 'over' ? 'over' : state.level === 'near' ? 'near' : 'ink'

  // Each active card, and any other key that moved money this month (an
  // archived card, an unknown one, none): the largest first.
  const byName = new Map(cards.map((c) => [c.id, c]))
  const keys = new Set<string>(cards.filter((c) => !c.archived).map((c) => c.id))
  for (const [key, amount] of month.byCard) if (amount !== 0) keys.add(key)
  const lines = [...keys].map((key) => ({ key, amount: month.byCard.get(key) ?? 0 })).sort((a, b) => b.amount - a.amount)
  const shown = lines.slice(0, TOP_CARDS)
  const more = lines.length - shown.length

  const p = pace(month.total, ym, today)
  const paceValue = p.dailyAverage === null ? '—' : money.plain(p.dailyAverage)
  const paceSub = p.state === 'current' ? t('spend.projected', { amount: money.plain(p.projected ?? 0) }) : p.state === 'past' ? tn('day', p.daysCounted) : t('spend.futureMonth')

  return (
    <section className="hero spend-strip" aria-label={t('spend.aria')}>
      <article className="card stat-card spend-total-card">
        <div className="stat-head">
          <span className="stat-label">{t('spend.month', { month: monthInline(ym) })}</span>
        </div>
        {/* Keyed by its text: a new figure mounts and settles in (num-in). */}
        <span key={totalValue} className="life-value spend-total">
          {totalValue}
        </span>
        <span className="stat-sub">
          {month.count === 0 ? (
            t('spend.none')
          ) : (
            <>
              <span>{tn('expense', month.count)}</span>
              {month.refunded > 0 && <span className="spend-refunded">{t('spend.refunded', { amount: money.plain(month.refunded) })}</span>}
            </>
          )}
        </span>
      </article>

      <button type="button" className="card stat-card key-card spend-budget-card" onClick={onManageBudgets}>
        <span className="stat-head">
          <span className="stat-label">{t('spend.budgetLeft')}</span>
        </span>
        <span key={budgetValue} className={`life-value key-value ${budgetTone}`}>
          {budgetValue}
        </span>
        {left === null ? (
          <span className="stat-sub key-sub">{t('spend.setBudget')}</span>
        ) : (
          <span className="stat-sub key-sub spend-budget-sub">
            <span>{t('spend.budgetOf', { spent: money.plain(month.total), limit: money.plain(state.limit ?? 0) })}</span>
            <span className="bd-bar spend-budget-bar" aria-hidden="true">
              <span className={`bd-fill ${fill}`} style={{ width: `${Math.min(100, state.ratio * 100)}%` }} />
            </span>
          </span>
        )}
      </button>

      <article className="card stat-card spend-cards-card">
        <div className="stat-head">
          <span className="stat-label">{t('spend.byCard')}</span>
        </div>
        {!cardsLoaded ? (
          <span className="stat-sub">{t('exp.loading')}</span>
        ) : shown.length === 0 ? (
          <span className="stat-sub">{t('spend.noCards')}</span>
        ) : (
          <ul className="spend-card-list">
            {shown.map(({ key, amount }) => {
              const card = key === NO_CARD ? undefined : byName.get(key)
              const name = card ? card.name : t('spend.noCard')
              const ink = inkOf(key, cards)
              return (
                <li key={key} className="spend-card-item">
                  <span className={`legend-swatch${ink.dashed ? ' is-dashed' : ''}`} style={{ ['--swatch' as string]: ink.ink }} aria-hidden="true" />
                  <span className="spend-card-name" title={name}>
                    {name}
                  </span>
                  <span className="spend-card-amount">{money.plain(amount)}</span>
                </li>
              )
            })}
            {more > 0 && <li className="spend-card-more">{t('spend.moreCards', { n: more })}</li>}
          </ul>
        )}
      </article>

      <article className="card stat-card spend-pace-card">
        <div className="stat-head">
          <span className="stat-label">{t('spend.daily')}</span>
        </div>
        <span key={paceValue} className="life-value spend-pace">
          {paceValue}
        </span>
        <span className="stat-sub">{paceSub}</span>
      </article>
    </section>
  )
}

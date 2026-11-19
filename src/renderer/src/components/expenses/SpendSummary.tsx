import { useState } from 'react'
import type { ExpenseBudget, ExpenseCard } from '../../../../shared/types'
import { humanDate, monthInline, type MonthKey } from '../../lib/dates'
import { fmtPct } from '../../lib/format'
import { useLang } from '../../lib/i18n'
import { useMoney } from '../../lib/money'
import { budgetState, cardInk, cardLines, comparisonChange, levelClass, NO_CARD, TOP_CARDS, totalBudget, type Drill, type MonthComparison, type MonthSpend, type Pace } from '../../lib/spend'
import { ArrowDownIcon, ArrowUpIcon } from '../icons'

interface Props {
  ym: MonthKey
  month: MonthSpend
  /** The month against the one before it (lib/spend.ts vsLastMonth), or null when there is nothing to compare with. */
  versus: MonthComparison | null
  /** The daily average and where the month is heading (lib/spend.ts pace). */
  pace: Pace
  budgets: readonly ExpenseBudget[]
  cards: readonly ExpenseCard[]
  /** Whether the expenses have loaded on this device. Until then every figure is "—": a zero would read as real. */
  loaded: boolean
  cardsLoaded: boolean
  /** With `loaded` false: the device is offline (the tiles say so) rather than still loading. */
  offline: boolean
  today: string
  onManageBudgets: () => void
  /** The list's card filter ('all', a card's id or NO_CARD): its line reads as the one the list shows. */
  activeCard: string
  /** A card's line shows that card's expenses in the list below (ExpensesView). */
  onShow: (d: Drill) => void
}

/**
 * The month in four figures, one strip like the bets' key numbers: what was
 * spent (net of refunds) and how that compares with the month before, the
 * budget left (the tile opens the budgets), what each card spent (each line
 * shows its card's expenses; "+n more" lists them all), and the daily average
 * with where the month is heading. Neutral ink throughout; only a budget near
 * or over its limit takes colour: spending more than last month is said with
 * an arrow and in words, never in red. The projection lives in the average's
 * sub line alone, never beside the actual total.
 */
export default function SpendSummary({ ym, month, versus, pace: p, budgets, cards, loaded, cardsLoaded, offline, today, onManageBudgets, activeCard, onShow }: Props) {
  const { t, tn } = useLang()
  const money = useMoney()
  // Every card once "+n more" is pressed (this visit).
  const [allCards, setAllCards] = useState(false)

  // Not loaded yet: a dash in each tile, never $0.00 as if it were real. The reason is said once, under the total.
  const waiting = loaded ? null : t(offline ? 'exp.offlineNotLoaded' : 'exp.loading')

  const totalValue = waiting ? '—' : money.plain(month.total)

  // Against the month before: day for day in the current month, whole months for a past one.
  const change = versus ? comparisonChange(versus) : null
  const toDate = versus?.previousThrough ?? null
  const versusText = ((): string | null => {
    if (!versus || !change) return null
    const lastMonth = monthInline(versus.previousMonth)
    if (change.direction === 'same') return toDate ? t('spend.vsSame') : t('spend.vsSameMonth', { month: lastMonth })
    const by = change.pct === null ? money.plain(Math.abs(versus.diff)) : change.pct === 0 ? '<1%' : fmtPct(change.pct)
    if (toDate) return t(change.direction === 'more' ? 'spend.vsMore' : 'spend.vsLess', { change: by })
    return t(change.direction === 'more' ? 'spend.vsMoreMonth' : 'spend.vsLessMonth', { change: by, month: lastMonth })
  })()
  const versusTitle = !versus
    ? undefined
    : toDate
      ? t('spend.vsTitle', { date: humanDate(toDate), amount: money.plain(versus.previous) })
      : t('spend.vsTitleMonth', { month: monthInline(versus.previousMonth), amount: money.plain(versus.previous) })

  const total = totalBudget(budgets)
  const state = budgetState(month.total, total?.monthlyLimit ?? null)
  const left = state.left
  const budgetValue = waiting || left === null ? '—' : left < 0 ? t('spend.budgetOver', { amount: money.plain(-left) }) : money.plain(left)
  const budgetTone = waiting ? '' : state.level === 'over' ? 'loss' : state.level === 'near' ? 'near' : ''

  // Each active card, and any other key that moved money this month: the largest first, three until "+n more".
  const lines = cardLines(month, cards)
  const shown = allCards ? lines : lines.slice(0, TOP_CARDS)
  const more = lines.length - shown.length
  const inkOf = cardInk(cards)
  const byId = new Map(cards.map((c) => [c.id, c]))
  const cardsWaiting = waiting ? '—' : cardsLoaded ? null : t('exp.loading')

  const paceValue = waiting || p.dailyAverage === null ? '—' : money.plain(p.dailyAverage)
  // What the average is of, for whoever hovers: the net through today, or the whole of a past month.
  const paceTitle =
    waiting || p.state === 'future'
      ? undefined
      : p.state === 'current'
        ? t('spend.vsTitle', { date: humanDate(today), amount: money.plain(p.counted) })
        : t('spend.vsTitleMonth', { month: monthInline(ym), amount: money.plain(p.counted) })

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
          {waiting ??
            (month.count === 0 ? (
              t('spend.none')
            ) : (
              <>
                <span>{tn('expense', month.count)}</span>
                {month.refunded > 0 && <span className="spend-refunded">{t('spend.refunded', { amount: money.plain(month.refunded) })}</span>}
              </>
            ))}
        </span>
        {!waiting && versusText !== null && change && (
          <span className="stat-sub spend-vs" data-direction={change.direction} title={versusTitle}>
            {change.direction === 'more' ? <ArrowUpIcon /> : change.direction === 'less' ? <ArrowDownIcon /> : null}
            <span>{versusText}</span>
          </span>
        )}
      </article>

      <button type="button" className="card stat-card key-card spend-budget-card" onClick={onManageBudgets}>
        <span className="stat-head">
          <span className="stat-label">{t('spend.budgetLeft')}</span>
        </span>
        <span key={budgetValue} className={`life-value key-value ${budgetTone}`}>
          {budgetValue}
        </span>
        {waiting ? null : left === null ? (
          <span className="stat-sub key-sub">{t('spend.setBudget')}</span>
        ) : (
          <span className="stat-sub key-sub spend-budget-sub">
            <span>{t('spend.budgetOf', { spent: money.plain(month.total), limit: money.plain(state.limit ?? 0) })}</span>
            <span className="bd-bar spend-budget-bar" aria-hidden="true">
              <span className={`bd-fill ${levelClass(state.level)}`} style={{ width: `${Math.min(100, state.ratio * 100)}%` }} />
            </span>
          </span>
        )}
      </button>

      <article className="card stat-card spend-cards-card">
        <div className="stat-head">
          <span className="stat-label">{t('spend.byCard')}</span>
        </div>
        {cardsWaiting ? (
          <span className="stat-sub">{cardsWaiting}</span>
        ) : shown.length === 0 ? (
          <span className="stat-sub">{t('spend.noCards')}</span>
        ) : (
          <ul className="spend-card-list">
            {shown.map(({ key, amount }) => {
              const card = key === NO_CARD ? undefined : byId.get(key)
              const name = card ? card.name : t('spend.noCard')
              const ink = inkOf(key)
              // The whole line is the target (.drill-row): its name is the button, its swatch and amount stay plain.
              return (
                <li key={key} className="spend-card-item drill-row" data-card={key}>
                  <span className={`legend-swatch${ink.dashed ? ' is-dashed' : ''}`} style={{ ['--swatch' as string]: ink.ink }} aria-hidden="true" />
                  <button
                    type="button"
                    className="spend-card-name drill"
                    title={name}
                    aria-label={card ? t('spend.showCard', { name }) : t('spend.showNoCard')}
                    aria-current={activeCard === key || undefined}
                    onClick={() => onShow({ card: key })}
                  >
                    {name}
                  </button>
                  <span className="spend-card-amount">{money.plain(amount)}</span>
                </li>
              )
            })}
            {more > 0 && (
              <li className="spend-card-more-item">
                <button type="button" className="spend-card-more" onClick={() => setAllCards(true)}>
                  {t('spend.moreCards', { n: more })}
                </button>
              </li>
            )}
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
        {/* How it is computed, in the line itself: the days it is over and, this month, where that pace ends. */}
        {!waiting && (
          <span className="stat-sub spend-pace-sub" title={paceTitle}>
            {p.state === 'current' ? (
              <>
                <span>{tn('day', p.daysCounted)}</span>
                <span className="spend-pace-proj">{t('spend.onPace', { amount: money.plain(p.projected ?? 0) })}</span>
              </>
            ) : p.state === 'past' ? (
              t('spend.overDays', { days: tn('day', p.daysCounted) })
            ) : (
              t('spend.futureMonth')
            )}
          </span>
        )}
      </article>
    </section>
  )
}

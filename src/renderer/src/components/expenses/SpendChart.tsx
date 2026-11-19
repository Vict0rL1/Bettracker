import { lazy, Suspense, useMemo, useState } from 'react'
import type { Expense, ExpenseCard } from '../../../../shared/types'
import { bankrollAxis } from '../../lib/chartView'
import { daysInMonth, monthInline, type MonthKey } from '../../lib/dates'
import { useLang } from '../../lib/i18n'
import { expensesInMonth, spendChartData, wholeMonthPoints } from '../../lib/spend'
import { loadSpendChartView, saveSpendChartView, type SpendChartView } from '../../lib/view'

// Recharts only loads with the chart (the bets' boot path never pulls it).
const SpendChartInner = lazy(() => import('./SpendChartInner'))

interface Props {
  expenses: readonly Expense[]
  cards: readonly ExpenseCard[]
  cardsLoaded: boolean
  ym: MonthKey
  today: string
  /** The monthly total budget, or null. */
  budget: number | null
}

const VIEWS: readonly SpendChartView[] = ['cumulative', 'daily']

/**
 * The month's spending, every card in one chart: the running total stacked
 * by card against the total budget (dashed), or each day's spending stacked
 * by card. Cards are neutral inks (colour is for money states only); "No
 * card" is an outline.
 */
export default function SpendChart({ expenses, cards, cardsLoaded, ym, today, budget }: Props) {
  const { t } = useLang()
  const [view, setViewState] = useState<SpendChartView>(loadSpendChartView)
  const setView = (next: SpendChartView): void => {
    setViewState(next)
    saveSpendChartView(next)
  }

  const data = useMemo(() => spendChartData(expenses, cards, ym, today), [expenses, cards, ym, today])
  // The running total stops at today, but the hover runs over the whole month (days still to come say nothing).
  const cumulative = useMemo(() => wholeMonthPoints(data.cumulative, ym), [data.cumulative, ym])
  const days = daysInMonth(ym)
  const any = useMemo(() => expensesInMonth(expenses, ym).length > 0, [expenses, ym])
  const showBudget = view === 'cumulative' && budget !== null

  // Round ticks from 0 (or the lowest refund dip) to the top of the stack;
  // the budget line is in range in the running-total view.
  // The low end is this view's own: a refund day dips the daily bars below 0, a running total only when refunds outweigh it.
  const axis = useMemo(() => {
    const points = view === 'daily' ? data.daily : data.cumulative
    let low = 0
    for (const p of points) {
      let level = 0
      let down = 0
      for (const s of data.series) {
        const v = Number(p[s.key] ?? 0)
        level += v
        if (v < 0) down += v
      }
      low = Math.min(low, view === 'daily' ? down : level)
    }
    const top = view === 'daily' ? data.maxDaily : Math.max(data.max, showBudget ? (budget ?? 0) : 0)
    return bankrollAxis(low, Math.max(0, top), false)
  }, [view, data, showBudget, budget])

  let body
  if (!cardsLoaded) body = <p className="chart-empty">{t('exp.loading')}</p>
  else if (!any) body = <p className="chart-empty">{t('spend.chartEmpty', { month: monthInline(ym) })}</p>
  else
    body = (
      <>
        <div className="chart-wrap spend-chart-wrap">
          <Suspense fallback={<div className="chart-empty chart-loading" />}>
            <SpendChartInner
              view={view}
              series={data.series}
              points={view === 'daily' ? data.daily : cumulative}
              lo={axis.lo}
              hi={axis.hi}
              ticks={axis.ticks}
              budget={showBudget ? budget : null}
              daysInMonth={days}
              today={today}
            />
          </Suspense>
        </div>
        <ul className="chart-legend spend-legend">
          {data.series.map((s) => (
            <li key={s.key}>
              <span className={`legend-swatch${s.dashed ? ' is-dashed' : ''}`} style={{ ['--swatch' as string]: s.ink }} aria-hidden="true" />
              <span className="spend-legend-name">{s.name ?? t('spend.noCard')}</span>
            </li>
          ))}
          {showBudget && (
            <li>
              <i className="legend-line legend-dashed" aria-hidden="true" /> {t('spend.budgetLine')}
            </li>
          )}
        </ul>
      </>
    )

  return (
    <article className="card spend-chart-card">
      <header className="card-head">
        <h2>{t('spend.chartTitle')}</h2>
        <div className="scope-toggle spend-chart-view" role="group" aria-label={t('spend.chartAria')}>
          {VIEWS.map((v) => (
            <button key={v} type="button" className={`scope-btn ${view === v ? 'active' : ''}`} aria-pressed={view === v} onClick={() => setView(v)}>
              {t(v === 'daily' ? 'spend.viewDaily' : 'spend.viewCumulative')}
            </button>
          ))}
        </div>
      </header>
      {body}
    </article>
  )
}

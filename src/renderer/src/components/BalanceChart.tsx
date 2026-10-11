import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react'
import type { BankrollMove, Bet } from '../../../shared/types'
import { bankrollSeries, type Bankroll } from '../lib/bankroll'
import { loadChartView, saveChartView, type ChartView } from '../lib/chartView'
import { currentMonth, daysInMonth, monthLabel, monthPrefix, pad2, sameMonth, todayStr, type MonthKey } from '../lib/dates'
import { useLang } from '../lib/i18n'
import { useMoney } from '../lib/money'
import { rangeBounds, type DateRange } from '../lib/range'
import { cumulativeSeries, forMonth, groupByDay, type Summary } from '../lib/stats'

// Recharts is most of the bundle and only the chart needs it. Loading it here,
// not at startup, lets the dashboard paint before the library is downloaded;
// the card shows its empty state in the meantime.
const BalanceChartInner = lazy(() => import('./BalanceChartInner'))

interface Props {
  bets: Bet[]
  /** Summary over the chosen date range, already computed by the app — reused as the range series. */
  lifetime: Summary
  /** The range's name when one is chosen, null for all time. */
  rangeName: string | null
  range: DateRange
  ym: MonthKey
  bankroll: Bankroll
  /** Every deposit and withdrawal, queued ones included. */
  moves: readonly BankrollMove[]
  onSetUpBankroll: () => void
}

type Scope = 'all' | 'month'

export default function BalanceChart({ bets, lifetime, rangeName, range, ym, bankroll, moves, onSetUpBankroll }: Props) {
  const { t } = useLang()
  const money = useMoney()
  const [scope, setScope] = useState<Scope>('all')
  const [view, setViewState] = useState<ChartView>(loadChartView)
  const setView = (next: ChartView): void => {
    setViewState(next)
    saveChartView(next)
  }

  // The second button is the calendar month being viewed. When the range is
  // already this month it would draw the same curve twice, so it steps aside.
  const onCurrent = sameMonth(ym, currentMonth())
  const monthScope = !(range.kind === 'month' && onCurrent)
  const effective: Scope = monthScope ? scope : 'all'

  // In month scope the P/L curve restarts at zero, answering "how did this
  // month go" rather than "where does this month sit in my all-time balance".
  const monthSeries = useMemo(
    () => (view === 'pl' && effective === 'month' ? cumulativeSeries(groupByDay(forMonth(bets, ym))) : []),
    [view, effective, bets, ym]
  )

  // The bankroll is a level, not a period: it never restarts at zero. A range
  // or a month only chooses which stretch of it to draw.
  const bankrollPoints = useMemo(() => {
    if (view !== 'bankroll' || !bankroll.known) return []
    const bounds =
      effective === 'month'
        ? { from: `${monthPrefix(ym)}-01`, to: `${monthPrefix(ym)}-${pad2(daysInMonth(ym))}` }
        : rangeBounds(range, todayStr())
    return bankrollSeries(bets, moves, bankroll.start, bounds)
  }, [view, bankroll, effective, ym, range, bets, moves])

  // Units are drawn as units, so the axis ticks land on whole units.
  const data = useMemo(() => {
    const k = money.scale
    if (view === 'bankroll') return bankrollPoints.map((p) => ({ ...p, balance: k(p.balance), dayTotal: k(p.dayTotal), moved: k(p.moved), funded: k(p.funded) }))
    const points = effective === 'all' ? lifetime.series : monthSeries
    return points.map((p) => ({ ...p, balance: k(p.balance), dayTotal: k(p.dayTotal) }))
  }, [money, view, bankrollPoints, effective, lifetime.series, monthSeries])

  let empty: ReactNode = null
  if (view === 'bankroll' && !bankroll.known) {
    empty =
      bankroll.reason === 'unset' ? (
        <div className="chart-empty chart-setup">
          <span>{t('chart.emptyBankroll')}</span>
          <button type="button" className="btn btn-ghost" onClick={onSetUpBankroll}>
            {t('chart.setUp')}
          </button>
        </div>
      ) : (
        <div className="chart-empty">{t('chart.loadingBankroll')}</div>
      )
  } else if (data.length < 2) {
    const text = view === 'bankroll' ? t('chart.shortBankroll') : effective === 'month' ? t('chart.emptyMonth', { month: monthLabel(ym) }) : t('chart.emptyAll')
    empty = <div className="chart-empty">{text}</div>
  }

  return (
    <article className="card chart-card">
      <header className="card-head">
        <h2>{view === 'bankroll' ? t('chart.bankroll') : t('chart.title')}</h2>
        <div className="chart-controls">
          <div className="scope-toggle" role="group" aria-label={t('chart.range')}>
            <button type="button" className={`scope-btn ${effective === 'all' ? 'active' : ''}`} aria-pressed={effective === 'all'} onClick={() => setScope('all')}>
              {rangeName ?? t('chart.all')}
            </button>
            {monthScope && (
              <button
                type="button"
                className={`scope-btn ${effective === 'month' ? 'active' : ''}`}
                aria-pressed={effective === 'month'}
                onClick={() => setScope('month')}
              >
                {onCurrent ? t('chart.month') : monthLabel(ym)}
              </button>
            )}
          </div>
          <div className="scope-toggle chart-view" role="group" aria-label={t('chart.view')}>
            {(['pl', 'bankroll'] as const).map((v) => (
              <button key={v} type="button" className={`scope-btn ${view === v ? 'active' : ''}`} aria-pressed={view === v} onClick={() => setView(v)}>
                {t(`chart.${v}`)}
              </button>
            ))}
          </div>
        </div>
      </header>

      {empty ?? (
        <>
          <div className="chart-wrap">
            <Suspense fallback={<div className="chart-empty chart-loading">{t('chart.loading')}</div>}>
              <BalanceChartInner mode={view} data={data} />
            </Suspense>
          </div>
          {view === 'bankroll' && (
            <ul className="chart-legend">
              <li>
                <i className="legend-line" /> {t('chart.bankroll')}
              </li>
              <li>
                <i className="legend-line legend-dashed" /> {t('chart.funded')}
              </li>
            </ul>
          )}
        </>
      )}
    </article>
  )
}

import { lazy, Suspense, useMemo, useState } from 'react'
import type { Bet } from '../../../shared/types'
import { currentMonth, monthLabel, sameMonth, type MonthKey } from '../lib/dates'
import { useLang } from '../lib/i18n'
import type { RangeKind } from '../lib/range'
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
  rangeKind: RangeKind
  ym: MonthKey
}

type Scope = 'all' | 'month'

export default function BalanceChart({ bets, lifetime, rangeName, rangeKind, ym }: Props) {
  const { t } = useLang()
  const [scope, setScope] = useState<Scope>('all')

  // The second button is the calendar month being viewed. When the range is
  // already this month it would draw the same curve twice, so it steps aside.
  const onCurrent = sameMonth(ym, currentMonth())
  const monthScope = !(rangeKind === 'month' && onCurrent)
  const effective: Scope = monthScope ? scope : 'all'

  // In month scope the curve restarts at zero, answering "how did this month
  // go" rather than "where does this month sit in my all-time balance".
  const monthSeries = useMemo(
    () => (effective === 'month' ? cumulativeSeries(groupByDay(forMonth(bets, ym))) : []),
    [effective, bets, ym]
  )
  const data = effective === 'all' ? lifetime.series : monthSeries

  const emptyText = effective === 'month' ? t('chart.emptyMonth', { month: monthLabel(ym) }) : t('chart.emptyAll')

  return (
    <article className="card chart-card">
      <header className="card-head">
        <h2>{t('chart.title')}</h2>
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
      </header>

      {data.length < 2 ? (
        <div className="chart-empty">{emptyText}</div>
      ) : (
        <div className="chart-wrap">
          <Suspense fallback={<div className="chart-empty chart-loading">{t('chart.loading')}</div>}>
            <BalanceChartInner data={data} pushLabel={t('chart.push')} dayLabel={t('chart.day')} />
          </Suspense>
        </div>
      )}
    </article>
  )
}

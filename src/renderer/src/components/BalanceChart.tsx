import { lazy, Suspense, useMemo, useState } from 'react'
import type { Bet } from '../../../shared/types'
import { monthLabel, type MonthKey } from '../lib/dates'
import { useLang } from '../lib/i18n'
import { cumulativeSeries, forMonth, groupByDay, type Summary } from '../lib/stats'

// Recharts is most of the bundle and only the chart needs it. Loading it here,
// not at startup, lets the dashboard paint before the library is downloaded;
// the card shows its empty state in the meantime.
const BalanceChartInner = lazy(() => import('./BalanceChartInner'))

interface Props {
  bets: Bet[]
  /** All-time summary, already computed by the app — reused as the "all" series. */
  lifetime: Summary
  ym: MonthKey
}

type Scope = 'all' | 'month'

export default function BalanceChart({ bets, lifetime, ym }: Props) {
  const { t } = useLang()
  const [scope, setScope] = useState<Scope>('all')

  // In month scope the curve restarts at zero, answering "how did this month
  // go" rather than "where does this month sit in my all-time balance".
  const monthSeries = useMemo(
    () => (scope === 'month' ? cumulativeSeries(groupByDay(forMonth(bets, ym))) : []),
    [scope, bets, ym]
  )
  const data = scope === 'all' ? lifetime.series : monthSeries

  const emptyText = scope === 'month' ? t('chart.emptyMonth', { month: monthLabel(ym) }) : t('chart.emptyAll')

  return (
    <article className="card chart-card">
      <header className="card-head">
        <h2>{t('chart.title')}</h2>
        <div className="scope-toggle" role="group" aria-label={t('chart.range')}>
          <button type="button" className={`scope-btn ${scope === 'all' ? 'active' : ''}`} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            {t('chart.all')}
          </button>
          <button
            type="button"
            className={`scope-btn ${scope === 'month' ? 'active' : ''}`}
            aria-pressed={scope === 'month'}
            onClick={() => setScope('month')}
          >
            {t('chart.month')}
          </button>
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

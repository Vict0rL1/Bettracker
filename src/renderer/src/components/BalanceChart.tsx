import { useMemo, useState } from 'react'
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { BetEntry } from '../../../shared/types'
import { humanDate, monthLabel, monthYearShort, shortDate, type MonthKey } from '../lib/dates'
import { axisMoney, fmtMoney, fmtMoneyPlain } from '../lib/format'
import { cumulativeSeries, forMonth, groupByDay, type BalancePoint, type Summary } from '../lib/stats'

interface Props {
  entries: BetEntry[]
  /** All-time summary, already computed by the app — reused as the "all" series. */
  lifetime: Summary
  ym: MonthKey
}

type Scope = 'all' | 'month'

export default function BalanceChart({ entries, lifetime, ym }: Props) {
  const [scope, setScope] = useState<Scope>('all')

  // In month scope the curve restarts at zero, answering "how did this month
  // go" rather than "where does this month sit in my all-time balance".
  const monthSeries = useMemo(
    () => (scope === 'month' ? cumulativeSeries(groupByDay(forMonth(entries, ym))) : []),
    [scope, entries, ym]
  )
  const data = scope === 'all' ? lifetime.series : monthSeries

  const ticks = useMemo(() => {
    if (data.length < 2) return []
    const count = Math.min(5, data.length)
    const idx = new Set<number>()
    for (let i = 0; i < count; i++) idx.add(Math.round((i * (data.length - 1)) / (count - 1)))
    return [...idx].map((i) => data[i].date)
  }, [data])

  const spansYears = data.length > 1 && data[0].date.slice(0, 4) !== data[data.length - 1].date.slice(0, 4)
  const lastBalance = data.length > 0 ? data[data.length - 1].balance : 0
  const lineColor = lastBalance >= 0 ? 'var(--green)' : 'var(--red)'

  const emptyText =
    scope === 'month'
      ? `Log at least two days in ${monthLabel(ym)} to draw a curve.`
      : 'Log at least two days to draw your balance curve.'

  return (
    <article className="card chart-card">
      <header className="card-head">
        <h2>Balance</h2>
        <div className="scope-toggle" role="group" aria-label="Chart range">
          <button
            type="button"
            className={`scope-btn ${scope === 'all' ? 'active' : ''}`}
            aria-pressed={scope === 'all'}
            onClick={() => setScope('all')}
          >
            All time
          </button>
          <button
            type="button"
            className={`scope-btn ${scope === 'month' ? 'active' : ''}`}
            aria-pressed={scope === 'month'}
            onClick={() => setScope('month')}
          >
            This month
          </button>
        </div>
      </header>

      {data.length < 2 ? (
        <div className="chart-empty">{emptyText}</div>
      ) : (
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height={272}>
            <AreaChart data={data} margin={{ top: 8, right: 10, left: 0, bottom: 2 }}>
              <defs>
                <linearGradient id="balanceFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={lineColor} stopOpacity={0.16} />
                  <stop offset="100%" stopColor={lineColor} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
              <XAxis
                dataKey="date"
                ticks={ticks}
                tickFormatter={(v) => (spansYears ? monthYearShort(String(v)) : shortDate(String(v)))}
                tick={{ fill: 'var(--text-3)', fontSize: 11 }}
                tickMargin={8}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(v) => axisMoney(Number(v))}
                tick={{ fill: 'var(--text-3)', fontSize: 11 }}
                width={54}
                axisLine={false}
                tickLine={false}
                domain={[(dataMin: number) => Math.min(0, dataMin), (dataMax: number) => Math.max(0, dataMax)]}
              />
              <ReferenceLine y={0} stroke="var(--grid-strong)" strokeWidth={1} />
              <Tooltip
                cursor={{ stroke: 'var(--grid-strong)', strokeWidth: 1 }}
                isAnimationActive={false}
                content={({ active, payload }) => {
                  const point =
                    active && payload && payload.length > 0
                      ? ((payload[0] as { payload?: unknown }).payload as BalancePoint | undefined)
                      : undefined
                  if (!point) return null
                  return (
                    <div className="chart-tip">
                      <div className="tip-value">{fmtMoneyPlain(point.balance)}</div>
                      <div className="tip-sub">
                        {humanDate(point.date)} · day {point.dayTotal === 0 ? 'push' : fmtMoney(point.dayTotal)}
                      </div>
                    </div>
                  )
                }}
              />
              <Area
                type="monotone"
                dataKey="balance"
                stroke={lineColor}
                strokeWidth={2}
                strokeLinecap="round"
                fill="url(#balanceFill)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card-solid)', fill: lineColor }}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </article>
  )
}

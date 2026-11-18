import { Area, Bar, CartesianGrid, ComposedChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { shortDate } from '../../lib/dates'
import { useLang } from '../../lib/i18n'
import { useMoney } from '../../lib/money'
import type { SpendPoint, SpendSeries } from '../../lib/spend'
import type { SpendChartView } from '../../lib/view'

interface Props {
  view: SpendChartView
  series: SpendSeries[]
  /** Daily: every day of the month. Cumulative: up to today (all of a past month). */
  points: SpendPoint[]
  lo: number
  hi: number
  ticks: number[]
  /** The total budget line (running-total view only), or null. */
  budget: number | null
  daysInMonth: number
}

/** About five days labelled along the month: the 1st, the last, and evenly between. */
const dayTicks = (days: number): number[] => [...new Set(Array.from({ length: 5 }, (_, i) => Math.round(1 + (i * (days - 1)) / 4)))]

/**
 * The drawing (lazy: Recharts loads with it). The x axis is numeric over the
 * whole month, so the running total can stop at today while the budget line
 * still spans the month. Every mark is still: nothing animates in or at rest.
 */
export default function SpendChartInner({ view, series, points, lo, hi, ticks, budget, daysInMonth }: Props) {
  const { t } = useLang()
  const money = useMoney()
  const daily = view === 'daily'
  const month = points[0]?.date.slice(0, 8) ?? ''
  const dayDate = (day: number): string => `${month}${String(day).padStart(2, '0')}`
  // Half a day either side, so the first and last days' bars aren't cut in half.
  const domain: [number, number] = daily ? [0.5, daysInMonth + 0.5] : [1, daysInMonth]

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={points} margin={{ top: 8, right: 10, left: 0, bottom: 2 }} stackOffset={daily ? 'sign' : 'none'} barCategoryGap="20%">
        <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
        <XAxis
          type="number"
          dataKey="day"
          domain={domain}
          ticks={dayTicks(daysInMonth)}
          allowDecimals={false}
          tickFormatter={(v) => (month ? shortDate(dayDate(Number(v))) : String(v))}
          tick={{ fill: 'var(--text-3)', fontSize: 11 }}
          tickMargin={8}
          minTickGap={12}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tickFormatter={(v) => money.axis(Number(v))}
          tick={{ fill: 'var(--text-3)', fontSize: 11 }}
          width={58}
          axisLine={false}
          tickLine={false}
          domain={[lo, hi]}
          ticks={ticks}
          allowDataOverflow
        />
        {lo < 0 && <ReferenceLine y={0} stroke="var(--grid-strong)" strokeWidth={1} />}
        <Tooltip
          cursor={daily ? { fill: 'var(--tint-2)' } : { stroke: 'var(--grid-strong)', strokeWidth: 1 }}
          isAnimationActive={false}
          content={({ active, payload }) => {
            const point = active && payload && payload.length > 0 ? ((payload[0] as { payload?: unknown }).payload as SpendPoint | undefined) : undefined
            if (!point) return null
            const lines = series.filter((s) => typeof point[s.key] === 'number' && point[s.key] !== 0)
            const totalValue = daily ? point.total : (point.cumulative ?? point.total)
            return (
              <div className="chart-tip spend-tip">
                <div className="tip-value">{t('spend.tipTotal', { amount: money.plain(totalValue) })}</div>
                <div className="tip-sub">{shortDate(point.date)}</div>
                {lines.length > 0 && (
                  <ul className="spend-tip-list">
                    {lines.map((s) => (
                      <li key={s.key}>
                        <span className={`legend-swatch${s.dashed ? ' is-dashed' : ''}`} style={{ ['--swatch' as string]: s.ink }} aria-hidden="true" />
                        <span className="spend-tip-name">{s.name ?? t('spend.noCard')}</span>
                        <span className="spend-tip-amount">{money.plain(Number(point[s.key]))}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          }}
        />
        {daily
          ? series.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                stackId="spend"
                fill={s.ink}
                stroke={s.dashed ? 'var(--text-3)' : 'var(--series-gap)'}
                strokeDasharray={s.dashed ? '2 2' : undefined}
                strokeWidth={1}
                maxBarSize={18}
                isAnimationActive={false}
              />
            ))
          : series.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stackId="spend"
                fill={s.ink}
                fillOpacity={1}
                stroke={s.dashed ? 'var(--text-3)' : 'var(--series-gap)'}
                strokeDasharray={s.dashed ? '2 2' : undefined}
                strokeWidth={1}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
            ))}
        {!daily && budget !== null && (
          <ReferenceLine y={budget} className="spend-budget-line" stroke="var(--text-3)" strokeWidth={1.5} strokeDasharray="4 4" ifOverflow="extendDomain" />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  )
}

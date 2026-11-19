import { Area, Bar, CartesianGrid, ComposedChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { shortDate } from '../../lib/dates'
import { useLang } from '../../lib/i18n'
import { useMoney } from '../../lib/money'
import { chartDayHasTip, type SpendPoint, type SpendSeries } from '../../lib/spend'
import type { SpendChartView } from '../../lib/view'

interface Props {
  view: SpendChartView
  series: SpendSeries[]
  /** Every day of the month. Cumulative: the running total up to today (all of a past month), then bare days (lib/spend.ts wholeMonthPoints). */
  points: SpendPoint[]
  lo: number
  hi: number
  ticks: number[]
  /** The total budget line (running-total view only), or null. */
  budget: number | null
  daysInMonth: number
  /** Days after it with nothing on them have no tooltip and no cursor (lib/spend.ts chartDayHasTip). */
  today: string
}

/** About five days labelled along the month: the 1st, the last, and evenly between. */
const dayTicks = (days: number): number[] => [...new Set(Array.from({ length: 5 }, (_, i) => Math.round(1 + (i * (days - 1)) / 4)))]

/** What the cursor needs from the chart, under a name Recharts' own cursor props never use. */
interface DayCursorSpec {
  daily: boolean
  days: number
  /** Whether the day at this index of the points has anything to say. */
  shown: (index: number) => boolean
}

/**
 * The props Recharts gives a cursor element it clones (Cursor.tsx): the
 * pointer's day as two points of a vertical line, the plot's box, the index
 * of the active point and its class.
 */
interface DayCursorProps {
  spend: DayCursorSpec
  points?: readonly { x: number; y: number }[]
  top?: number
  width?: number
  height?: number
  payloadIndex?: string | number | null
  className?: string
}

/**
 * The tooltip's cursor, drawn here because a ComposedChart only ever draws
 * Recharts' line cursor, in its default #ccc (a bright white line in the
 * dark), whatever `cursor` asks for: a `fill` meant for a band went nowhere.
 * Per day: a faint band over the day's slot; running total: a hairline. A
 * day still to come with nothing on it gets none.
 */
function DayCursor({ spend, points, top = 0, width = 0, height = 0, payloadIndex, className }: DayCursorProps) {
  const x = points?.[0]?.x
  const index = payloadIndex === null || payloadIndex === undefined ? NaN : Number(payloadIndex)
  if (x === undefined || !Number.isInteger(index) || !spend.shown(index)) return null
  if (spend.daily) {
    const slot = width / spend.days
    return <rect className={className} x={x - slot / 2} y={top} width={slot} height={height} fill="var(--tint-2)" pointerEvents="none" />
  }
  return <line className={className} x1={x} x2={x} y1={top} y2={top + height} stroke="var(--grid-strong)" strokeWidth={1} pointerEvents="none" />
}

/**
 * The drawing (lazy: Recharts loads with it). The x axis is numeric over the
 * whole month, so the running total can stop at today while the budget line
 * still spans the month. Every mark is still: nothing animates in or at rest.
 * Hovering (or tapping) a day shows its tooltip and a quiet cursor; a day
 * after today with nothing on it shows neither.
 */
export default function SpendChartInner({ view, series, points, lo, hi, ticks, budget, daysInMonth, today }: Props) {
  const { t } = useLang()
  const money = useMoney()
  const daily = view === 'daily'
  const hasTip = (point: SpendPoint | undefined): point is SpendPoint => point !== undefined && chartDayHasTip(point, series, today)
  const month = points[0]?.date.slice(0, 8) ?? ''
  const dayDate = (day: number): string => `${month}${String(day).padStart(2, '0')}`
  // Half a day either side, so the first and last days' bars aren't cut in half.
  const domain: [number, number] = daily ? [0.5, daysInMonth + 0.5] : [1, daysInMonth]

  return (
    <ResponsiveContainer width="100%" height="100%">
      {/* 24px at the right: the last day's label ("Nov 30") is centred on the plot's edge and needs the room. */}
      <ComposedChart data={points} margin={{ top: 8, right: 24, left: 0, bottom: 2 }} stackOffset={daily ? 'sign' : 'none'} barCategoryGap="20%">
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
          cursor={<DayCursor spend={{ daily, days: daysInMonth, shown: (i) => hasTip(points[i]) }} />}
          isAnimationActive={false}
          content={({ active, payload }) => {
            const point = active && payload && payload.length > 0 ? ((payload[0] as { payload?: unknown }).payload as SpendPoint | undefined) : undefined
            if (!hasTip(point)) return null
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
              // Straight segments: a curve would bend before a day's spending and read as money spent the day before.
              <Area
                key={s.key}
                type="linear"
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

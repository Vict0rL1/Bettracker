import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { humanDate, monthYearShort, shortDate } from '../lib/dates'
import { axisMoney, fmtMoney, fmtMoneyPlain } from '../lib/format'
import type { BalancePoint } from '../lib/stats'

interface Props {
  data: BalancePoint[]
  /** Tooltip caption for a break-even day, in the user's language. */
  pushLabel: string
  dayLabel: string
}

/**
 * The drawing itself. Recharts is the largest thing in the bundle and only
 * this component needs it, so BalanceChart loads this lazily: the dashboard
 * paints and is usable before the chart library has even been downloaded.
 */
export default function BalanceChartInner({ data, pushLabel, dayLabel }: Props) {
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

  return (
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
              active && payload && payload.length > 0 ? ((payload[0] as { payload?: unknown }).payload as BalancePoint | undefined) : undefined
            if (!point) return null
            return (
              <div className="chart-tip">
                <div className="tip-value">{fmtMoneyPlain(point.balance)}</div>
                <div className="tip-sub">
                  {humanDate(point.date)} · {dayLabel} {point.dayTotal === 0 ? pushLabel : fmtMoney(point.dayTotal)}
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
  )
}

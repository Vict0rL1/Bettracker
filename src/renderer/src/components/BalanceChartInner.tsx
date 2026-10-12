import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { bankrollAxis, type ChartView } from '../lib/chartView'
import { humanDate, monthYearShort, shortDate } from '../lib/dates'
import { scaledFormat } from '../lib/format'
import { useLang } from '../lib/i18n'
import { useMoney } from '../lib/money'

/** A point as drawn: values already in the unit shown (dollars, or units). */
export interface ChartPoint {
  date: string
  balance: number
  dayTotal: number
  /** Bankroll view only: that day's deposits less withdrawals, and the money put in so far. */
  moved?: number
  funded?: number
  /** Bankroll view only: the balance carried in from before the period. */
  opening?: true
}

interface Props {
  mode: ChartView
  data: ChartPoint[]
}

/**
 * The drawing itself. Recharts is the largest thing in the bundle and only
 * this component needs it, so BalanceChart loads this lazily: the dashboard
 * paints and is usable before the chart library has even been downloaded.
 *
 * P/L view: the running result, from 0. Bankroll view: the bankroll as a
 * level on one axis (never a second scale), with a dashed step line for the
 * money put in — the gap between the two is the P/L, and a deposit lifts both
 * — and a dot on each day money moved in or out.
 */
export default function BalanceChartInner({ mode, data }: Props) {
  const { t } = useLang()
  const money = useMoney()
  const fmt = scaledFormat(money.unit !== null)
  const bankroll = mode === 'bankroll'

  const ticks = useMemo(() => {
    if (data.length < 2) return []
    const count = Math.min(5, data.length)
    const idx = new Set<number>()
    for (let i = 0; i < count; i++) idx.add(Math.round((i * (data.length - 1)) / (count - 1)))
    return [...idx].map((i) => data[i].date)
  }, [data])

  // P/L always shows its zero line. A bankroll is fitted to its own range, on
  // round ticks, and shows zero only when it gets there.
  const yAxis = useMemo(() => {
    if (!bankroll) return { domain: [(dataMin: number) => Math.min(0, dataMin), (dataMax: number) => Math.max(0, dataMax)] as [(n: number) => number, (n: number) => number], ticks: undefined, zero: true }
    const values = data.flatMap((p) => [p.balance, p.funded ?? p.balance])
    const { lo, hi, ticks } = bankrollAxis(Math.min(...values), Math.max(...values), money.unit !== null)
    return { domain: [lo, hi] as [number, number], ticks, zero: lo <= 0 && hi >= 0 }
  }, [bankroll, data, money.unit])

  const spansYears = data.length > 1 && data[0].date.slice(0, 4) !== data[data.length - 1].date.slice(0, 4)
  const last = data.length > 0 ? data[data.length - 1] : null
  // Green while the bets are ahead: of zero for P/L, of the money put in for a bankroll.
  const ahead = last === null || last.balance >= (bankroll ? (last.funded ?? 0) : 0)
  const lineColor = ahead ? 'var(--green)' : 'var(--red)'

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
          tickFormatter={(v) => fmt.axis(Number(v))}
          tick={{ fill: 'var(--text-3)', fontSize: 11 }}
          width={54}
          axisLine={false}
          tickLine={false}
          domain={yAxis.domain}
          ticks={yAxis.ticks}
        />
        {yAxis.zero && <ReferenceLine y={0} stroke="var(--grid-strong)" strokeWidth={1} />}
        <Tooltip
          cursor={{ stroke: 'var(--grid-strong)', strokeWidth: 1 }}
          isAnimationActive={false}
          content={({ active, payload }) => {
            const point =
              active && payload && payload.length > 0 ? ((payload[0] as { payload?: unknown }).payload as ChartPoint | undefined) : undefined
            if (!point) return null
            let sub: string
            if (point.opening) sub = `${humanDate(point.date)} · ${t('chart.opening')}`
            else {
              const parts: string[] = []
              if (point.dayTotal !== 0) parts.push(bankroll ? t('chart.betsDay', { amount: fmt.signed(point.dayTotal) }) : `${t('chart.day')} ${fmt.signed(point.dayTotal)}`)
              if (point.moved) parts.push(t(point.moved > 0 ? 'chart.depositDay' : 'chart.withdrawalDay', { amount: fmt.signed(point.moved) }))
              sub = `${humanDate(point.date)} · ${parts.length > 0 ? parts.join(' · ') : `${t('chart.day')} ${t('chart.push')}`}`
            }
            return (
              <div className="chart-tip">
                <div className="tip-value">{fmt.plain(point.balance)}</div>
                <div className="tip-sub">{sub}</div>
              </div>
            )
          }}
        />
        {bankroll && (
          <Area
            type="stepAfter"
            dataKey="funded"
            stroke="var(--text-3)"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            fill="none"
            dot={false}
            activeDot={false}
            isAnimationActive={false}
          />
        )}
        <Area
          // A bankroll moves in steps (a deposit is not a slope), so its points
          // are joined straight; the running P/L keeps its smooth curve.
          type={bankroll ? 'linear' : 'monotone'}
          dataKey="balance"
          stroke={lineColor}
          strokeWidth={2}
          strokeLinecap="round"
          fill="url(#balanceFill)"
          baseValue={bankroll ? 'dataMin' : undefined}
          dot={
            bankroll
              ? (props: { cx?: number; cy?: number; index?: number; payload?: ChartPoint }) =>
                  props.payload?.moved ? (
                    <circle key={props.index} cx={props.cx} cy={props.cy} r={4} fill="var(--text-2)" stroke="var(--card-solid)" strokeWidth={2} />
                  ) : (
                    <g key={props.index} />
                  )
              : false
          }
          activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card-solid)', fill: lineColor }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { xTicks, yAxisFor, type ChartPoint, type ChartView } from '../lib/chartView'
import { humanDate, monthYearShort, shortDate } from '../lib/dates'
import { scaledFormat } from '../lib/format'
import { useLang } from '../lib/i18n'
import { useMoney } from '../lib/money'

export type { ChartPoint } from '../lib/chartView'

interface Props {
  mode: ChartView
  data: ChartPoint[]
}

/**
 * The drawing itself. Recharts is the largest thing in the bundle and only
 * this component needs it, so BalanceChart loads this lazily: the dashboard
 * paints and is usable before the chart library has even been downloaded.
 *
 * P/L view: the running result, from an opening point at 0. Bankroll view:
 * the bankroll as a level on one axis (never a second scale), with a dashed
 * step line for the money put in — at each point the gap between the two is
 * the P/L to that day — and a dot on each day money moved in or out. Points
 * are joined straight in both views: a curve between two days would suggest
 * money moving on days nothing was settled. The arithmetic (which dates get
 * a label, the axis) is in lib/chartView.ts.
 */
export default function BalanceChartInner({ mode, data }: Props) {
  const { t } = useLang()
  const money = useMoney()
  const fmt = scaledFormat(money.unit !== null)
  const bankroll = mode === 'bankroll'

  const ticks = useMemo(() => xTicks(data), [data])
  const yAxis = useMemo(() => yAxisFor(mode, data, money.unit !== null), [mode, data, money.unit])

  const spansYears = data.length > 1 && data[0].date.slice(0, 4) !== data[data.length - 1].date.slice(0, 4)
  const last = data.length > 0 ? data[data.length - 1] : null
  // Green while the bets are ahead: of zero for P/L, of the money put in for a bankroll.
  const ahead = last === null || last.balance >= (bankroll ? (last.funded ?? 0) : 0)
  const lineColor = ahead ? 'var(--green)' : 'var(--red)'

  return (
    <ResponsiveContainer width="100%" height="100%">
      {/* Room on the right for the last date's label, which is centred on the last point. */}
      <AreaChart data={data} margin={{ top: 8, right: 24, left: 0, bottom: 2 }}>
        <defs>
          <linearGradient id="balanceFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity={0.14} />
            <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
        <XAxis
          dataKey="date"
          ticks={ticks}
          tickFormatter={(v) => (spansYears ? monthYearShort(String(v)) : shortDate(String(v)))}
          tick={{ fill: 'var(--text-3)', fontSize: 11 }}
          tickMargin={8}
          minTickGap={12}
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
        {yAxis.zero && <ReferenceLine y={0} stroke="var(--grid-strong)" strokeWidth={1} strokeDasharray="3 3" />}
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
                {/* A bankroll is a level (its natural sign); a running P/L is a result, so it carries its sign. */}
                <div className="tip-value">{bankroll ? fmt.plain(point.balance) : fmt.signed(point.balance)}</div>
                <div className="tip-sub">{sub}</div>
              </div>
            )
          }}
        />
        {bankroll && (
          <Area
            // Deposits and withdrawals are instantaneous: the money put in is a step, never a slope.
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
          type="linear"
          dataKey="balance"
          stroke={lineColor}
          strokeWidth={1.75}
          strokeLinecap="round"
          fill="url(#balanceFill)"
          baseValue={bankroll ? 'dataMin' : undefined}
          dot={
            bankroll
              ? (props: { cx?: number; cy?: number; index?: number; payload?: ChartPoint }) =>
                  props.payload?.moved ? (
                    <circle key={props.index} cx={props.cx} cy={props.cy} r={3} fill="var(--text-3)" stroke="var(--card-solid)" strokeWidth={1.5} />
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

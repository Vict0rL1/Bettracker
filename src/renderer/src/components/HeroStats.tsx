import { useMemo } from 'react'
import type { BetEntry } from '../../../shared/types'
import { monthLabel, monthYearShort, sameMonth, shortDate, currentMonth, type MonthKey } from '../lib/dates'
import { fmtMoney, fmtMoneyCompact, fmtPct, fmtPctSigned, fmtStake } from '../lib/format'
import { forMonth, summarize, type Summary } from '../lib/stats'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'

interface Props {
  entries: BetEntry[]
  /** All-time summary, computed once by the app and shared with the chart. */
  lifetime: Summary
  ym: MonthKey
  onPrev: () => void
  onNext: () => void
  onResetMonth: () => void
}

const tone = (n: number): string => (n > 0 ? 'win' : n < 0 ? 'loss' : 'flat')

interface MiniProps {
  label: string
  value: string
  sub: string
  toneClass?: string
  title?: string
}

function Mini({ label, value, sub, toneClass = '', title }: MiniProps) {
  return (
    <div className="mini" title={title}>
      <span className="stat-label">{label}</span>
      <span className={`mini-value ${toneClass}`}>{value}</span>
      <span className="mini-sub">{sub}</span>
    </div>
  )
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

export default function HeroStats({ entries, lifetime, ym, onPrev, onNext, onResetMonth }: Props) {
  const month = useMemo(() => summarize(forMonth(entries, ym)), [entries, ym])

  const onCurrentMonth = sameMonth(ym, currentMonth())
  const monthSub =
    month.bets === 0
      ? 'No bets logged this month'
      : `${plural(month.dayCount, 'day')} · ${plural(month.bets, 'bet')} · ${month.dayWl.wins}W–${month.dayWl.losses}L` +
        (month.dayWl.pushes > 0 ? `–${month.dayWl.pushes}P` : '')

  const { roi } = lifetime

  // ROI only speaks for the bets that recorded a stake. When that's a subset,
  // its profit differs from lifetime P/L above — "63 of 79 bets" is what stops
  // the two numbers from looking like they contradict each other.
  const roiSub = roi
    ? `${fmtMoney(roi.profit)} on ${fmtStake(roi.staked)} staked · ` +
      (roi.missing > 0 ? `${roi.counted} of ${plural(lifetime.bets, 'bet')} with a stake` : plural(roi.counted, 'bet'))
    : lifetime.bets === 0
      ? 'Log a bet with its stake to see ROI'
      : `No stakes recorded yet — add one to ${plural(lifetime.bets, 'bet')} to see ROI`

  return (
    <section className="hero">
      <article className="card stat-card">
        <div className="stat-head">
          <span className="stat-label">{monthLabel(ym)} P/L</span>
          <div className="month-nav">
            {!onCurrentMonth && (
              <button type="button" className="chip" onClick={onResetMonth}>
                today
              </button>
            )}
            <button type="button" className="nav-btn" aria-label="Previous month" onClick={onPrev}>
              <ChevronLeftIcon />
            </button>
            <button type="button" className="nav-btn" aria-label="Next month" onClick={onNext}>
              <ChevronRightIcon />
            </button>
          </div>
        </div>
        <div className={`hero-value ${tone(month.total)}`}>{fmtMoney(month.total)}</div>
        <div className="stat-sub">{monthSub}</div>
      </article>

      <article className="card stat-card">
        <div className="stat-head">
          <span className="stat-label">Lifetime P/L</span>
        </div>
        <div className={`life-value ${tone(lifetime.total)}`}>{fmtMoney(lifetime.total)}</div>
        <div className="stat-sub">
          {lifetime.bets === 0
            ? 'Log your first bet to get started'
            : `${plural(lifetime.bets, 'bet')} over ${plural(lifetime.dayCount, 'day')} since ${monthYearShort(lifetime.first ?? '')}`}
        </div>
      </article>

      <article className="card stat-card roi-card">
        <div className="stat-head">
          <span className="stat-label">ROI</span>
          {lifetime.avgStake !== null && (
            <span className="chip chip-static" title="Average stake across bets that recorded one">
              avg {fmtStake(lifetime.avgStake)}
            </span>
          )}
        </div>
        <div className={`life-value ${roi ? tone(roi.pct) : 'flat'}`}>{roi ? fmtPctSigned(roi.pct) : '—'}</div>
        <div className="stat-sub">{roiSub}</div>
      </article>

      <article className="card mini-card">
        <Mini
          label="Strike rate"
          value={lifetime.strike === null ? '—' : fmtPct(lifetime.strike)}
          sub={
            lifetime.strike === null
              ? 'no decisive bets yet'
              : `${lifetime.betWl.wins}W–${lifetime.betWl.losses}L by bet`
          }
          title="Share of individual bets that won, ignoring pushes"
        />
        <Mini
          label="Green days"
          value={lifetime.dayRate === null ? '—' : fmtPct(lifetime.dayRate)}
          sub={lifetime.dayRate === null ? 'no decisive days yet' : `${lifetime.dayWl.wins}W–${lifetime.dayWl.losses}L by day`}
          title="Share of days that ended net positive"
        />
        <Mini
          label="Streak"
          value={lifetime.streak ? `${lifetime.streak.kind}${lifetime.streak.count}` : '—'}
          toneClass={lifetime.streak ? (lifetime.streak.kind === 'W' ? 'win' : 'loss') : ''}
          sub={
            lifetime.streak
              ? `${plural(lifetime.streak.count, 'day')} ${lifetime.streak.kind === 'W' ? 'green' : 'red'} running`
              : 'no decisive days yet'
          }
        />
        <Mini
          label="Best day"
          value={lifetime.best ? fmtMoneyCompact(lifetime.best.total) : '—'}
          toneClass={lifetime.best ? 'win' : ''}
          sub={lifetime.best ? shortDate(lifetime.best.date) : 'nothing yet'}
        />
        <Mini
          label="Worst day"
          value={lifetime.worst ? fmtMoneyCompact(lifetime.worst.total) : '—'}
          toneClass={lifetime.worst ? 'loss' : ''}
          sub={lifetime.worst ? shortDate(lifetime.worst.date) : 'nothing yet'}
        />
        <Mini
          label="Max drawdown"
          value={lifetime.drawdown > 0 ? `-${fmtStake(lifetime.drawdown)}` : '—'}
          toneClass={lifetime.drawdown > 0 ? 'loss' : ''}
          sub={lifetime.drawdown > 0 ? 'largest peak-to-trough fall' : 'never below a previous peak'}
          title="The deepest your balance has fallen from its highest point"
        />
      </article>
    </section>
  )
}

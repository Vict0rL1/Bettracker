import { useMemo } from 'react'
import type { BetEntry } from '../../../shared/types'
import { monthLabel, monthYearShort, sameMonth, shortDate, currentMonth, type MonthKey } from '../lib/dates'
import { fmtMoney, fmtMoneyCompact, fmtPct } from '../lib/format'
import { bestDay, currentStreak, dayWinLoss, forMonth, groupByDay, total, winRate, worstDay } from '../lib/stats'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'

interface Props {
  entries: BetEntry[]
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
}

function Mini({ label, value, sub, toneClass = '' }: MiniProps) {
  return (
    <div className="mini">
      <span className="stat-label">{label}</span>
      <span className={`mini-value ${toneClass}`}>{value}</span>
      <span className="mini-sub">{sub}</span>
    </div>
  )
}

export default function HeroStats({ entries, ym, onPrev, onNext, onResetMonth }: Props) {
  const stats = useMemo(() => {
    const month = forMonth(entries, ym)
    return {
      monthTotal: total(month),
      monthSessions: month.length,
      monthDays: groupByDay(month).length,
      monthWl: dayWinLoss(month),
      lifetime: total(entries),
      sessions: entries.length,
      lifeDays: groupByDay(entries).length,
      first: entries.length > 0 ? entries[0].date : null,
      rate: winRate(entries),
      wl: dayWinLoss(entries),
      streak: currentStreak(entries),
      best: bestDay(entries),
      worst: worstDay(entries)
    }
  }, [entries, ym])

  const onCurrentMonth = sameMonth(ym, currentMonth())
  const monthSub =
    stats.monthSessions === 0
      ? 'No bets logged this month'
      : `${stats.monthDays} ${stats.monthDays === 1 ? 'day' : 'days'} · ${stats.monthSessions} ${stats.monthSessions === 1 ? 'bet' : 'bets'} · ${stats.monthWl.wins}W–${stats.monthWl.losses}L` +
        (stats.monthWl.pushes > 0 ? `–${stats.monthWl.pushes}P` : '')

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
        <div className={`hero-value ${tone(stats.monthTotal)}`}>{fmtMoney(stats.monthTotal)}</div>
        <div className="stat-sub">{monthSub}</div>
      </article>

      <article className="card stat-card">
        <div className="stat-head">
          <span className="stat-label">Lifetime P/L</span>
        </div>
        <div className={`life-value ${tone(stats.lifetime)}`}>{fmtMoney(stats.lifetime)}</div>
        <div className="stat-sub">
          {stats.sessions === 0
            ? 'Log your first bet to get started'
            : `${stats.sessions} ${stats.sessions === 1 ? 'bet' : 'bets'} over ${stats.lifeDays} ${stats.lifeDays === 1 ? 'day' : 'days'} since ${monthYearShort(stats.first ?? '')}`}
        </div>
      </article>

      <article className="card mini-card">
        <Mini
          label="Win rate"
          value={stats.rate === null ? '—' : fmtPct(stats.rate)}
          sub={stats.rate === null ? 'no decisive days yet' : `${stats.wl.wins}W–${stats.wl.losses}L by day`}
        />
        <Mini
          label="Streak"
          value={stats.streak ? `${stats.streak.kind}${stats.streak.count}` : '—'}
          toneClass={stats.streak ? (stats.streak.kind === 'W' ? 'win' : 'loss') : ''}
          sub={
            stats.streak
              ? `${stats.streak.count} ${stats.streak.kind === 'W' ? 'green' : 'red'} ${stats.streak.count === 1 ? 'day' : 'days'} running`
              : 'no decisive days yet'
          }
        />
        <Mini
          label="Best day"
          value={stats.best ? fmtMoneyCompact(stats.best.total) : '—'}
          toneClass={stats.best ? 'win' : ''}
          sub={stats.best ? shortDate(stats.best.date) : 'nothing yet'}
        />
        <Mini
          label="Worst day"
          value={stats.worst ? fmtMoneyCompact(stats.worst.total) : '—'}
          toneClass={stats.worst ? 'loss' : ''}
          sub={stats.worst ? shortDate(stats.worst.date) : 'nothing yet'}
        />
      </article>
    </section>
  )
}

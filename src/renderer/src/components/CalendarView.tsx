import { useMemo } from 'react'
import { daysInMonth, firstWeekday, humanDate, monthLabel, toDateStr, todayStr, type MonthKey } from '../lib/dates'
import { fmtMoney, fmtMoneyCompact } from '../lib/format'
import type { DaySummary } from '../lib/stats'

interface Props {
  ym: MonthKey
  dayMap: Map<string, DaySummary>
  onDayClick: (date: string) => void
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** How a day reads at a glance: by its settled result, or as open when nothing has settled yet. */
function kindOf(day: DaySummary | undefined): 'win' | 'loss' | 'push' | 'pending' | 'none' {
  if (!day) return 'none'
  if (day.scored === 0) return day.pending > 0 ? 'pending' : 'none'
  return day.total > 0 ? 'win' : day.total < 0 ? 'loss' : 'push'
}

export default function CalendarView({ ym, dayMap, onDayClick }: Props) {
  const cells = useMemo<(number | null)[]>(() => {
    const blanks: (number | null)[] = Array.from({ length: firstWeekday(ym) }, () => null)
    const days = Array.from({ length: daysInMonth(ym) }, (_, i) => i + 1)
    return [...blanks, ...days]
  }, [ym])

  const today = todayStr()

  return (
    <article className="card calendar-card">
      <header className="card-head">
        <h2>Calendar</h2>
        <span className="card-note">{monthLabel(ym)}</span>
      </header>

      <div className="cal-grid cal-weekdays">
        {WEEKDAYS.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>

      <div className="cal-grid">
        {cells.map((day, i) => {
          if (day === null) return <span key={`blank-${i}`} className="cal-blank" />
          const date = toDateStr(ym.year, ym.month, day)
          const summary = dayMap.get(date)
          const kind = kindOf(summary)
          const parts: string[] = [humanDate(date)]
          if (summary) {
            if (summary.scored > 0) parts.push(summary.total === 0 ? 'Push' : fmtMoney(summary.total))
            if (summary.count > 1) parts.push(`${summary.count} bets`)
            if (summary.pending > 0) parts.push(`${summary.pending} pending`)
          } else {
            parts.push('no bets — click to log')
          }
          const classes = ['cal-cell', kind, date === today ? 'is-today' : '', date > today ? 'is-future' : ''].filter(Boolean).join(' ')
          return (
            <button type="button" key={date} className={classes} title={parts.join(' · ')} onClick={() => onDayClick(date)}>
              <span className="cal-top">
                <span className="cal-day">{day}</span>
                {summary && summary.count > 1 && (
                  <span className="cal-count" title={`${summary.count} bets`}>
                    {summary.count}
                  </span>
                )}
              </span>
              {summary && summary.scored > 0 && (
                <span className="cal-amt">{summary.total === 0 ? 'PUSH' : fmtMoneyCompact(summary.total)}</span>
              )}
              {summary && summary.scored === 0 && summary.pending > 0 && <span className="cal-amt">OPEN</span>}
              {summary && summary.scored > 0 && summary.pending > 0 && <i className="cal-dot" aria-hidden="true" />}
            </button>
          )
        })}
      </div>

      <footer className="cal-legend">
        <span className="lg">
          <i className="lg-swatch win" /> Win
        </span>
        <span className="lg">
          <i className="lg-swatch loss" /> Loss
        </span>
        <span className="lg">
          <i className="lg-swatch push" /> Push
        </span>
        <span className="lg">
          <i className="lg-swatch pending" /> Pending
        </span>
        <span className="lg">
          <i className="lg-swatch none" /> No bets
        </span>
      </footer>
    </article>
  )
}

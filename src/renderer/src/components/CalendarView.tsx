import { useMemo } from 'react'
import type { BetEntry } from '../../../shared/types'
import { daysInMonth, firstWeekday, humanDate, monthLabel, toDateStr, todayStr, type MonthKey } from '../lib/dates'
import { fmtMoney, fmtMoneyCompact } from '../lib/format'

interface Props {
  ym: MonthKey
  entryMap: Map<string, BetEntry>
  onDayClick: (date: string) => void
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function CalendarView({ ym, entryMap, onDayClick }: Props) {
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
          const entry = entryMap.get(date)
          const kind = entry ? (entry.amount > 0 ? 'win' : entry.amount < 0 ? 'loss' : 'push') : 'none'
          const title = entry
            ? `${humanDate(date)} · ${entry.amount === 0 ? 'Push' : fmtMoney(entry.amount)}${entry.note ? ` · ${entry.note}` : ''}`
            : `${humanDate(date)} · no entry — click to log`
          const classes = [
            'cal-cell',
            kind,
            date === today ? 'is-today' : '',
            date > today ? 'is-future' : ''
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <button type="button" key={date} className={classes} title={title} onClick={() => onDayClick(date)}>
              <span className="cal-day">{day}</span>
              {entry && <span className="cal-amt">{entry.amount === 0 ? 'PUSH' : fmtMoneyCompact(entry.amount)}</span>}
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
          <i className="lg-swatch none" /> No entry
        </span>
      </footer>
    </article>
  )
}

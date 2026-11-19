import { useMemo } from 'react'
import { daysInMonth, firstWeekday, humanDate, monthLabel, toDateStr, todayStr, type MonthKey } from '../lib/dates'
import { fmtMoneyCell } from '../lib/format'
import { useLang } from '../lib/i18n'
import { useMoney } from '../lib/money'
import { heatOf, heatSizes, type DaySummary } from '../lib/stats'

interface Props {
  ym: MonthKey
  dayMap: Map<string, DaySummary>
  onDayClick: (date: string) => void
}

/** How a day reads at a glance: by its settled result, or as open when nothing has settled yet. */
function kindOf(day: DaySummary | undefined): 'win' | 'loss' | 'push' | 'pending' | 'none' {
  if (!day) return 'none'
  if (day.scored === 0) return day.pending > 0 ? 'pending' : 'none'
  return day.total > 0 ? 'win' : day.total < 0 ? 'loss' : 'push'
}

export default function CalendarView({ ym, dayMap, onDayClick }: Props) {
  const { t, tn } = useLang()
  const money = useMoney()
  const cells = useMemo<(number | null)[]>(() => {
    const blanks: (number | null)[] = Array.from({ length: firstWeekday(ym) }, () => null)
    const days = Array.from({ length: daysInMonth(ym) }, (_, i) => i + 1)
    return [...blanks, ...days]
  }, [ym])

  const today = todayStr()

  // The month's decided days so far, for the tint by size (heatOf).
  const sizes = useMemo(() => heatSizes(dayMap, ym, today), [dayMap, ym, today])
  const weekdays = t('cal.weekdays').split(',')

  // A cell is about 32px wide on a 320px phone: in dollars, $1,000 and up
  // read in whole thousands (-$1k), where -$1.2k was clipped to "-$1…". The
  // exact figure is in the cell's title and in the day dialog. Units keep
  // their own compact form (a unit amount rarely reaches 1,000).
  const cell = (n: number): string => (money.unit === null ? fmtMoneyCell(n) : money.compact(n))

  return (
    <article className="card calendar-card">
      <header className="card-head">
        <h2>{t('cal.title')}</h2>
        <span className="card-note">{monthLabel(ym)}</span>
      </header>

      <div className="cal-grid cal-weekdays">
        {weekdays.map((d) => (
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
            if (summary.scored > 0) parts.push(summary.total === 0 ? t('cal.pushTip') : money.signed(summary.total))
            if (summary.count > 1) parts.push(tn('bet', summary.count))
            if (summary.pending > 0) parts.push(tn('pending', summary.pending))
          } else {
            parts.push(t('cal.emptyTip'))
          }
          const classes = ['cal-cell', kind, date === today ? 'is-today' : '', date > today ? 'is-future' : ''].filter(Boolean).join(' ')
          const heat = summary && date <= today && (kind === 'win' || kind === 'loss') ? heatOf(sizes, summary.total) : undefined
          return (
            <button type="button" key={date} className={classes} data-heat={heat} title={parts.join(' · ')} onClick={() => onDayClick(date)}>
              {/* The bet count stays in the title: a badge on every busy day would crowd a 46px cell. */}
              <span className="cal-top">
                <span className="cal-day">{day}</span>
              </span>
              {summary && summary.scored > 0 && <span className="cal-amt">{summary.total === 0 ? t('cal.pushCell') : cell(summary.total)}</span>}
              {summary && summary.scored === 0 && summary.pending > 0 && <span className="cal-amt">{t('cal.openCell')}</span>}
              {summary && summary.scored > 0 && summary.pending > 0 && <i className="cal-dot" aria-hidden="true" />}
            </button>
          )
        })}
      </div>

      <footer className="cal-legend">
        <span className="lg">
          <i className="lg-swatch win" /> {t('cal.win')}
        </span>
        <span className="lg">
          <i className="lg-swatch loss" /> {t('cal.loss')}
        </span>
        <span className="lg">
          <i className="lg-swatch push" /> {t('cal.push')}
        </span>
        <span className="lg">
          <i className="lg-swatch pending" /> {t('cal.pending')}
        </span>
        <span className="lg">
          <i className="lg-swatch none" /> {t('cal.none')}
        </span>
      </footer>
    </article>
  )
}

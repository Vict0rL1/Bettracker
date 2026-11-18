import { useMemo } from 'react'
import { daysInMonth, firstWeekday, humanDate, monthLabel, toDateStr, todayStr, type MonthKey } from '../lib/dates'
import { useLang } from '../lib/i18n'
import { useMoney } from '../lib/money'
import type { DaySummary } from '../lib/stats'

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

/**
 * How big a day's P/L is next to the month's other decided days, by thirds:
 * 1 the smallest third, 3 the largest. The tint deepens with it, so the big
 * days stand out at a glance. `sizes` is every decided day's |P/L| up to
 * today. Ties share a bucket by their middle rank, so a month of one decided
 * day, or of equal days, sits in the middle rather than reading as all big.
 */
function heatOf(sizes: readonly number[], total: number): 1 | 2 | 3 {
  const size = Math.abs(total)
  let below = 0
  let upTo = 0
  for (const s of sizes) {
    if (s < size) below++
    if (s <= size) upTo++
  }
  const p = (below + upTo) / 2 / sizes.length
  return p <= 1 / 3 ? 1 : p <= 2 / 3 ? 2 : 3
}

export default function CalendarView({ ym, dayMap, onDayClick }: Props) {
  const { t } = useLang()
  const money = useMoney()
  const cells = useMemo<(number | null)[]>(() => {
    const blanks: (number | null)[] = Array.from({ length: firstWeekday(ym) }, () => null)
    const days = Array.from({ length: daysInMonth(ym) }, (_, i) => i + 1)
    return [...blanks, ...days]
  }, [ym])

  const today = todayStr()

  // The month's decided days so far (a result, not even), for heatOf. Days
  // still to come are never tinted, so they don't count.
  const sizes = useMemo(() => {
    const out: number[] = []
    for (let d = 1; d <= daysInMonth(ym); d++) {
      const date = toDateStr(ym.year, ym.month, d)
      if (date > today) break
      const s = dayMap.get(date)
      if (s && s.scored > 0 && s.total !== 0) out.push(Math.abs(s.total))
    }
    return out
  }, [dayMap, ym, today])
  const weekdays = t('cal.weekdays').split(',')

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
            if (summary.count > 1) parts.push(t('cal.betsTip', { n: summary.count }))
            if (summary.pending > 0) parts.push(t('cal.pendingTip', { n: summary.pending }))
          } else {
            parts.push(t('cal.emptyTip'))
          }
          const classes = ['cal-cell', kind, date === today ? 'is-today' : '', date > today ? 'is-future' : ''].filter(Boolean).join(' ')
          const heat = summary && date <= today && (kind === 'win' || kind === 'loss') ? heatOf(sizes, summary.total) : undefined
          return (
            <button type="button" key={date} className={classes} data-heat={heat} title={parts.join(' · ')} onClick={() => onDayClick(date)}>
              <span className="cal-top">
                <span className="cal-day">{day}</span>
                {summary && summary.count > 1 && (
                  <span className="cal-count" title={t('cal.betsTip', { n: summary.count })}>
                    {summary.count}
                  </span>
                )}
              </span>
              {summary && summary.scored > 0 && (
                <span className="cal-amt">{summary.total === 0 ? t('cal.pushCell') : money.compact(summary.total)}</span>
              )}
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

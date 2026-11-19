import { getLang, LOCALE } from './i18n'

export interface MonthKey {
  year: number
  /** 0-11, matching Date#getMonth. */
  month: number
}

export const pad2 = (n: number): string => String(n).padStart(2, '0')

export const toDateStr = (year: number, month: number, day: number): string =>
  `${year}-${pad2(month + 1)}-${pad2(day)}`

// All date strings are built from local time, never toISOString (which is UTC
// and rolls "today" forward in evening timezones).
export function todayStr(): string {
  const d = new Date()
  return toDateStr(d.getFullYear(), d.getMonth(), d.getDate())
}

export function currentMonth(): MonthKey {
  const d = new Date()
  return { year: d.getFullYear(), month: d.getMonth() }
}

export function addMonths(ym: MonthKey, delta: number): MonthKey {
  const t = ym.year * 12 + ym.month + delta
  return { year: Math.floor(t / 12), month: ((t % 12) + 12) % 12 }
}

export const sameMonth = (a: MonthKey, b: MonthKey): boolean =>
  a.year === b.year && a.month === b.month

export const monthPrefix = (ym: MonthKey): string => `${ym.year}-${pad2(ym.month + 1)}`

/**
 * Where a month stands against today's (a local date string): 0 for the
 * current month, below 0 for a past one (−1 is last month), above 0 for one
 * still to come. The one place the comparison is made (lib/spend.ts).
 */
export function monthOrder(ym: MonthKey, today: string): number {
  const [ty, tm] = today.split('-').map(Number)
  return ym.year * 12 + ym.month - (ty * 12 + (tm - 1))
}

// Human-readable dates follow the interface language. Spanish month names are
// lowercase by convention ("agosto 2026"); the first letter is raised where a
// label starts with one, so headings read the same in both languages.
const locale = (): string => LOCALE[getLang()]
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

export const monthLabel = (ym: MonthKey): string => cap(monthInline(ym))

/**
 * The month as words inside a sentence ("Spent in {month}"): monthLabel
 * without the raised first letter, so Spanish keeps its lowercase month
 * ("noviembre de 2026"); English reads the same as monthLabel.
 */
export const monthInline = (ym: MonthKey): string =>
  new Date(ym.year, ym.month, 1).toLocaleDateString(locale(), { month: 'long', year: 'numeric' })

export const daysInMonth = (ym: MonthKey): number => new Date(ym.year, ym.month + 1, 0).getDate()

/** Weekday of the 1st, 0 = Sunday. */
export const firstWeekday = (ym: MonthKey): number => new Date(ym.year, ym.month, 1).getDay()

function parseParts(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** The date `n` days after `dateStr` (before, for a negative `n`), on the local calendar: DST days have 23 or 25 hours. */
export function addDays(dateStr: string, n: number): string {
  const d = parseParts(dateStr)
  d.setDate(d.getDate() + n)
  return toDateStr(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Weekday of a date string, 0 = Sunday. */
export const weekdayOf = (dateStr: string): number => parseParts(dateStr).getDay()

export const humanDate = (dateStr: string): string =>
  parseParts(dateStr).toLocaleDateString(locale(), { month: 'short', day: 'numeric', year: 'numeric' })

export const shortDate = (dateStr: string): string =>
  parseParts(dateStr).toLocaleDateString(locale(), { month: 'short', day: 'numeric' })

export const monthYearShort = (dateStr: string): string =>
  cap(parseParts(dateStr).toLocaleDateString(locale(), { month: 'short', year: 'numeric' }))

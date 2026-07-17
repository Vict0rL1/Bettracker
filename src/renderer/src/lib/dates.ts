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

export const monthLabel = (ym: MonthKey): string =>
  new Date(ym.year, ym.month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

export const daysInMonth = (ym: MonthKey): number => new Date(ym.year, ym.month + 1, 0).getDate()

/** Weekday of the 1st, 0 = Sunday. */
export const firstWeekday = (ym: MonthKey): number => new Date(ym.year, ym.month, 1).getDay()

function parseParts(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export const humanDate = (dateStr: string): string =>
  parseParts(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export const shortDate = (dateStr: string): string =>
  parseParts(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

export const monthYearShort = (dateStr: string): string =>
  parseParts(dateStr).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })

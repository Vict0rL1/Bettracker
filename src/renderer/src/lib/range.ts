import type { Bet } from '../../../shared/types'
import { isValidDate } from './validate'
import { pad2, toDateStr } from './dates'

/**
 * The date range the stats, chart and breakdown are computed over. The
 * calendar, the month card and the history always see everything — a range
 * is a lens on the numbers, not a filter on the data.
 */
export type RangeKind = 'all' | 'week' | 'month' | '30d' | 'year' | 'custom'

export const RANGE_KINDS: readonly RangeKind[] = ['all', 'week', 'month', '30d', 'year', 'custom']

export interface DateRange {
  kind: RangeKind
  /** Custom only: inclusive ends, YYYY-MM-DD; a missing end is open. */
  from?: string
  to?: string
}

export const ALL_TIME: DateRange = { kind: 'all' }

export interface Bounds {
  from: string | null
  to: string | null
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number)
  return [y, m - 1, d]
}

/** `date` shifted by `days`, in local calendar terms (no DST surprises: dates only). */
export function shiftDays(date: string, days: number): string {
  const [y, m, d] = parts(date)
  const t = new Date(y, m, d + days)
  return toDateStr(t.getFullYear(), t.getMonth(), t.getDate())
}

/** The inclusive bounds of a range as of `today` (YYYY-MM-DD). Weeks start on Sunday, as the calendar does. */
export function rangeBounds(range: DateRange, today: string): Bounds {
  const [y, m, d] = parts(today)
  switch (range.kind) {
    case 'all':
      return { from: null, to: null }
    case 'week': {
      const weekday = new Date(y, m, d).getDay()
      const from = shiftDays(today, -weekday)
      return { from, to: shiftDays(from, 6) }
    }
    case 'month':
      return { from: `${y}-${pad2(m + 1)}-01`, to: toDateStr(y, m, new Date(y, m + 1, 0).getDate()) }
    case '30d':
      return { from: shiftDays(today, -29), to: today }
    case 'year':
      return { from: `${y}-01-01`, to: `${y}-12-31` }
    case 'custom':
      return { from: range.from ?? null, to: range.to ?? null }
  }
}

export const inBounds = (date: string, b: Bounds): boolean => (b.from === null || date >= b.from) && (b.to === null || date <= b.to)

export function filterRange(bets: readonly Bet[], range: DateRange, today: string): Bet[] {
  if (range.kind === 'all') return [...bets]
  const b = rangeBounds(range, today)
  return bets.filter((bet) => inBounds(bet.date, b))
}

const KEY = 'bettracker:range'

const isKind = (v: unknown): v is RangeKind => RANGE_KINDS.includes(v as RangeKind)

/** The range chosen on this device, or all time when none (or nonsense) is stored. */
export function loadRange(): DateRange {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return ALL_TIME
    const v = JSON.parse(raw) as Partial<DateRange>
    if (!isKind(v.kind)) return ALL_TIME
    if (v.kind !== 'custom') return { kind: v.kind }
    const from = typeof v.from === 'string' && isValidDate(v.from) ? v.from : undefined
    const to = typeof v.to === 'string' && isValidDate(v.to) ? v.to : undefined
    return { kind: 'custom', from, to }
  } catch {
    return ALL_TIME
  }
}

export function saveRange(range: DateRange): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(range))
  } catch {
    // Storage unavailable — the choice just won't survive a reload.
  }
}

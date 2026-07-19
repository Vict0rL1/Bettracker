import type { BetEntry } from '../../../shared/types'
import { monthPrefix, type MonthKey } from './dates'

export const round2 = (n: number): number => Math.round(n * 100) / 100

/** Sum of every session's amount (works the same whether one or many per day). */
export const total = (entries: readonly BetEntry[]): number =>
  round2(entries.reduce((sum, e) => sum + e.amount, 0))

export const forMonth = (entries: readonly BetEntry[], ym: MonthKey): BetEntry[] => {
  const prefix = monthPrefix(ym)
  return entries.filter((e) => e.date.startsWith(prefix))
}

/** All sessions logged on one calendar day, plus their net total. */
export interface DaySummary {
  date: string
  total: number
  count: number
  entries: BetEntry[]
}

/** Collapse sessions into one summary per day, ascending by date. */
export function groupByDay(entries: readonly BetEntry[]): DaySummary[] {
  const byDate = new Map<string, BetEntry[]>()
  for (const e of entries) {
    const list = byDate.get(e.date)
    if (list) list.push(e)
    else byDate.set(e.date, [e])
  }
  return [...byDate.entries()]
    .map(([date, list]) => ({
      date,
      total: total(list),
      count: list.length,
      entries: [...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
}

export interface WinLoss {
  wins: number
  losses: number
  pushes: number
}

/** Win/loss/push counts by DAY total (a day is a win if its sessions net positive). */
export function dayWinLoss(entries: readonly BetEntry[]): WinLoss {
  const counts: WinLoss = { wins: 0, losses: 0, pushes: 0 }
  for (const day of groupByDay(entries)) {
    if (day.total > 0) counts.wins++
    else if (day.total < 0) counts.losses++
    else counts.pushes++
  }
  return counts
}

/** Percentage of decisive days that were green; null when nothing decisive yet. */
export function winRate(entries: readonly BetEntry[]): number | null {
  const { wins, losses } = dayWinLoss(entries)
  const decisive = wins + losses
  return decisive === 0 ? null : (wins / decisive) * 100
}

export interface Streak {
  kind: 'W' | 'L'
  count: number
}

/** Run of same-sign DAY totals, newest first. Break-even days are skipped. */
export function currentStreak(entries: readonly BetEntry[]): Streak | null {
  const desc = groupByDay(entries).reverse()
  let kind: 'W' | 'L' | null = null
  let count = 0
  for (const day of desc) {
    if (day.total === 0) continue
    const k: 'W' | 'L' = day.total > 0 ? 'W' : 'L'
    if (kind === null) {
      kind = k
      count = 1
    } else if (k === kind) {
      count++
    } else {
      break
    }
  }
  return kind === null ? null : { kind, count }
}

export interface BalancePoint {
  date: string
  dayTotal: number
  balance: number
}

/** Cumulative balance, one point per day (each day's sessions summed first). */
export function cumulativeSeries(entries: readonly BetEntry[]): BalancePoint[] {
  let balance = 0
  return groupByDay(entries).map((day) => {
    balance = round2(balance + day.total)
    return { date: day.date, dayTotal: day.total, balance }
  })
}

/** Best net day (by day total). Null when no green day exists. */
export function bestDay(entries: readonly BetEntry[]): DaySummary | null {
  let best: DaySummary | null = null
  for (const day of groupByDay(entries)) {
    if (day.total > 0 && (best === null || day.total > best.total)) best = day
  }
  return best
}

/** Worst net day (by day total). Null when no red day exists. */
export function worstDay(entries: readonly BetEntry[]): DaySummary | null {
  let worst: DaySummary | null = null
  for (const day of groupByDay(entries)) {
    if (day.total < 0 && (worst === null || day.total < worst.total)) worst = day
  }
  return worst
}

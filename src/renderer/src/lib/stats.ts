import type { BetEntry } from '../../../shared/types'
import { monthPrefix, type MonthKey } from './dates'

export const round2 = (n: number): number => Math.round(n * 100) / 100

export const total = (entries: readonly BetEntry[]): number =>
  round2(entries.reduce((sum, e) => sum + e.amount, 0))

export const forMonth = (entries: readonly BetEntry[], ym: MonthKey): BetEntry[] => {
  const prefix = monthPrefix(ym)
  return entries.filter((e) => e.date.startsWith(prefix))
}

export interface WinLoss {
  wins: number
  losses: number
  pushes: number
}

export function winLoss(entries: readonly BetEntry[]): WinLoss {
  const counts: WinLoss = { wins: 0, losses: 0, pushes: 0 }
  for (const e of entries) {
    if (e.amount > 0) counts.wins++
    else if (e.amount < 0) counts.losses++
    else counts.pushes++
  }
  return counts
}

/** Percentage of decisive days that were green; null when nothing decisive yet. */
export function winRate(entries: readonly BetEntry[]): number | null {
  const { wins, losses } = winLoss(entries)
  const decisive = wins + losses
  return decisive === 0 ? null : (wins / decisive) * 100
}

export interface Streak {
  kind: 'W' | 'L'
  count: number
}

/** Run of same-sign results over logged days, newest first. Pushes are skipped. */
export function currentStreak(entries: readonly BetEntry[]): Streak | null {
  const desc = [...entries].sort((a, b) => (a.date < b.date ? 1 : -1))
  let kind: 'W' | 'L' | null = null
  let count = 0
  for (const e of desc) {
    if (e.amount === 0) continue
    const k: 'W' | 'L' = e.amount > 0 ? 'W' : 'L'
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
  amount: number
  balance: number
}

export function cumulativeSeries(entries: readonly BetEntry[]): BalancePoint[] {
  const asc = [...entries].sort((a, b) => (a.date < b.date ? -1 : 1))
  let balance = 0
  return asc.map((e) => {
    balance = round2(balance + e.amount)
    return { date: e.date, amount: e.amount, balance }
  })
}

export function bestDay(entries: readonly BetEntry[]): BetEntry | null {
  let best: BetEntry | null = null
  for (const e of entries) if (e.amount > 0 && (best === null || e.amount > best.amount)) best = e
  return best
}

export function worstDay(entries: readonly BetEntry[]): BetEntry | null {
  let worst: BetEntry | null = null
  for (const e of entries) if (e.amount < 0 && (worst === null || e.amount < worst.amount)) worst = e
  return worst
}

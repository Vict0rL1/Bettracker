import type { BetEntry } from '../../../shared/types'
import { monthPrefix, type MonthKey } from './dates'
import { round2 } from './validate'

export { round2 }

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

const emptyWinLoss = (): WinLoss => ({ wins: 0, losses: 0, pushes: 0 })

function tally(counts: WinLoss, value: number): void {
  if (value > 0) counts.wins++
  else if (value < 0) counts.losses++
  else counts.pushes++
}

/** Win/loss/push counts by DAY total (a day is a win if its sessions net positive). */
export function dayWinLoss(days: readonly DaySummary[]): WinLoss {
  const counts = emptyWinLoss()
  for (const day of days) tally(counts, day.total)
  return counts
}

/** Win/loss/push counts by individual BET — the honest denominator for strike rate. */
export function betWinLoss(entries: readonly BetEntry[]): WinLoss {
  const counts = emptyWinLoss()
  for (const e of entries) tally(counts, e.amount)
  return counts
}

/** Percentage of decisive units that were green; null when nothing decisive yet. */
export function strikeRate({ wins, losses }: WinLoss): number | null {
  const decisive = wins + losses
  return decisive === 0 ? null : (wins / decisive) * 100
}

export interface Roi {
  /** Return on investment as a percentage: profit / staked * 100. */
  pct: number
  /** Total risked across the bets that have a recorded stake. */
  staked: number
  /** Net profit over those same bets (not the all-time P/L). */
  profit: number
  /** How many bets went into the calculation. */
  counted: number
  /** Bets skipped because no stake was recorded — the honesty caveat. */
  missing: number
}

/**
 * ROI over the bets that recorded a stake.
 *
 * Bets without a stake are excluded rather than counted as 0: treating an
 * unknown stake as zero would inflate ROI toward infinity, and treating it as
 * the profit would fabricate data. `missing` reports how much history is left
 * out so the number can be read with the right amount of trust.
 *
 * Returns null when nothing has been staked yet (including the all-free-bet
 * case, where the ratio is undefined rather than infinite).
 */
export function roi(entries: readonly BetEntry[]): Roi | null {
  let staked = 0
  let profit = 0
  let counted = 0
  let missing = 0
  for (const e of entries) {
    if (e.stake === null) {
      missing++
      continue
    }
    staked += e.stake
    profit += e.amount
    counted++
  }
  if (counted === 0 || staked <= 0) return null
  return {
    pct: (profit / staked) * 100,
    staked: round2(staked),
    profit: round2(profit),
    counted,
    missing
  }
}

/** Average stake across the bets that recorded one; null when there are none. */
export function averageStake(entries: readonly BetEntry[]): number | null {
  let sum = 0
  let n = 0
  for (const e of entries) {
    if (e.stake === null) continue
    sum += e.stake
    n++
  }
  return n === 0 ? null : round2(sum / n)
}

export interface Streak {
  kind: 'W' | 'L'
  count: number
}

/** Run of same-sign DAY totals, newest first. Break-even days are skipped. */
export function currentStreak(days: readonly DaySummary[]): Streak | null {
  let kind: 'W' | 'L' | null = null
  let count = 0
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i]
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
export function cumulativeSeries(days: readonly DaySummary[]): BalancePoint[] {
  let balance = 0
  return days.map((day) => {
    balance = round2(balance + day.total)
    return { date: day.date, dayTotal: day.total, balance }
  })
}

/** Largest peak-to-trough fall in the balance curve, as a positive number. */
export function maxDrawdown(points: readonly BalancePoint[]): number {
  let peak = 0
  let worst = 0
  for (const p of points) {
    if (p.balance > peak) peak = p.balance
    const fall = peak - p.balance
    if (fall > worst) worst = fall
  }
  return round2(worst)
}

/** Best and worst net day in one pass. Either side is null when no such day exists. */
export function extremeDays(days: readonly DaySummary[]): { best: DaySummary | null; worst: DaySummary | null } {
  let best: DaySummary | null = null
  let worst: DaySummary | null = null
  for (const day of days) {
    if (day.total > 0 && (best === null || day.total > best.total)) best = day
    if (day.total < 0 && (worst === null || day.total < worst.total)) worst = day
  }
  return { best, worst }
}

/** Which tag a breakdown groups by. */
export type TagKey = 'sport' | 'book' | 'betType'

export interface BreakdownRow {
  /** The tag value, e.g. "NBA" or "DraftKings". */
  label: string
  bets: number
  profit: number
  wl: WinLoss
  /** ROI for this slice, or null when none of its bets recorded a stake. */
  roi: number | null
  staked: number
  /**
   * How many of `bets` the ROI covers. When it's below `bets` the two figures
   * describe different sets — profit is all-in, ROI only the staked ones — so
   * the UI has to say so rather than let them look contradictory.
   */
  roiBets: number
}

/**
 * Performance grouped by one tag, best profit first. Untagged bets are left out
 * — an empty tag is missing data, not a category, and bundling them under
 * "(none)" would invite comparing a real book against a bucket of leftovers.
 */
export function breakdown(entries: readonly BetEntry[], key: TagKey): BreakdownRow[] {
  const groups = new Map<string, BetEntry[]>()
  for (const e of entries) {
    const label = e[key]
    if (!label) continue
    const list = groups.get(label)
    if (list) list.push(e)
    else groups.set(label, [e])
  }
  return [...groups.entries()]
    .map(([label, list]) => {
      const r = roi(list)
      return {
        label,
        bets: list.length,
        profit: total(list),
        wl: betWinLoss(list),
        roi: r ? r.pct : null,
        staked: r ? r.staked : 0,
        roiBets: r ? r.counted : 0
      }
    })
    .sort((a, b) => b.profit - a.profit || a.label.localeCompare(b.label))
}

/** Every distinct value a tag takes, sorted — used to populate filter menus. */
export function tagValues(entries: readonly BetEntry[], key: TagKey): string[] {
  const seen = new Set<string>()
  for (const e of entries) {
    if (e[key]) seen.add(e[key])
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

export interface Summary {
  days: DaySummary[]
  total: number
  bets: number
  dayCount: number
  dayWl: WinLoss
  betWl: WinLoss
  /** Strike rate by bet. */
  strike: number | null
  /** Win rate by day — how the calendar reads. */
  dayRate: number | null
  streak: Streak | null
  roi: Roi | null
  avgStake: number | null
  best: DaySummary | null
  worst: DaySummary | null
  series: BalancePoint[]
  drawdown: number
  first: string | null
}

/**
 * Everything the dashboard needs, from a single grouping pass.
 *
 * The individual helpers above used to each re-group the entries, so rendering
 * the stat cards walked the whole history about seven times over.
 */
export function summarize(entries: readonly BetEntry[]): Summary {
  const days = groupByDay(entries)
  const { best, worst } = extremeDays(days)
  const series = cumulativeSeries(days)
  const betWl = betWinLoss(entries)
  const dayWl = dayWinLoss(days)
  return {
    days,
    total: total(entries),
    bets: entries.length,
    dayCount: days.length,
    dayWl,
    betWl,
    strike: strikeRate(betWl),
    dayRate: strikeRate(dayWl),
    streak: currentStreak(days),
    roi: roi(entries),
    avgStake: averageStake(entries),
    best,
    worst,
    series,
    drawdown: maxDrawdown(series),
    first: days.length > 0 ? days[0].date : null
  }
}

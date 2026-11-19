import type { Bet } from '../../../shared/types'
import { bandIndex, bandOf } from './bands'
import { CASINO_SPORT, isCasino } from './casino'
import { daysInMonth, monthPrefix, toDateStr, weekdayOf, type MonthKey } from './dates'
import { impliedProbability } from './odds'
import { round2 } from './validate'

export { round2 }

/** A bet with a known outcome that counts toward the record: won, lost or push. */
const scored = (b: Bet): boolean => b.status === 'won' || b.status === 'lost' || b.status === 'push'

/** Net result over the settled bets (a pending bet contributes nothing). */
export const total = (bets: readonly Bet[]): number => round2(bets.reduce((sum, b) => sum + (b.amount ?? 0), 0))

/** What the pending bets have on the table. */
export interface Riding {
  /** Their stakes summed, to the cent. A pending bet with no stake adds nothing. */
  staked: number
  /** How many bets are pending, whatever their stake. */
  count: number
  /** Of those, how many recorded no stake, so `staked` leaves them out. */
  unstaked: number
}

/**
 * The money riding on the pending bets — the one place it is added up, for
 * the pending card, the pending panel, the summary and the bankroll alike.
 */
export function riding(bets: readonly Bet[]): Riding {
  let staked = 0
  let count = 0
  let unstaked = 0
  for (const b of bets) {
    if (b.status !== 'pending') continue
    count++
    if (b.stake === null) unstaked++
    else staked += b.stake
  }
  return { staked: round2(staked), count, unstaked }
}

/**
 * One bet's return on its stake, as a percentage: +50 on 100 is +50%. Only a
 * won or lost bet with a stake above 0 has one; a free bet, a push, a void, a
 * pending bet or a bet with no stake recorded reads null.
 */
export function returnPct(b: Bet): number | null {
  if ((b.status !== 'won' && b.status !== 'lost') || b.amount === null || b.stake === null || b.stake <= 0) return null
  return (b.amount / b.stake) * 100
}

export const forMonth = (bets: readonly Bet[], ym: MonthKey): Bet[] => {
  const prefix = monthPrefix(ym)
  return bets.filter((b) => b.date.startsWith(prefix))
}

/** All bets logged on one calendar day, plus their net total. */
export interface DaySummary {
  date: string
  /** Net result of the day's settled bets. */
  total: number
  /** Every bet on the day, pending included. */
  count: number
  /** Bets that count toward the day's result: won, lost or push. */
  scored: number
  pending: number
  bets: Bet[]
}

/** Collapse bets into one summary per day, ascending by date. */
export function groupByDay(bets: readonly Bet[]): DaySummary[] {
  const byDate = new Map<string, Bet[]>()
  for (const b of bets) {
    const list = byDate.get(b.date)
    if (list) list.push(b)
    else byDate.set(b.date, [b])
  }
  return [...byDate.entries()]
    .map(([date, list]) => ({
      date,
      total: total(list),
      count: list.length,
      scored: list.filter(scored).length,
      pending: list.filter((b) => b.status === 'pending').length,
      bets: [...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
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

/**
 * Win/loss/push counts by DAY total (a day is a win if its settled bets net
 * positive). A day with nothing scored yet — only pending or void bets — is
 * not a push, it is simply not in the record.
 */
export function dayWinLoss(days: readonly DaySummary[]): WinLoss {
  const counts = emptyWinLoss()
  for (const day of days) if (day.scored > 0) tally(counts, day.total)
  return counts
}

/** Win/loss/push counts by individual BET — the honest denominator for strike rate. */
export function betWinLoss(bets: readonly Bet[]): WinLoss {
  const counts = emptyWinLoss()
  for (const b of bets) {
    if (b.status === 'won') counts.wins++
    else if (b.status === 'lost') counts.losses++
    else if (b.status === 'push') counts.pushes++
  }
  return counts
}

/** Percentage of decisive units that were green; null when nothing decisive yet. */
export function strikeRate({ wins, losses }: WinLoss): number | null {
  const decisive = wins + losses
  return decisive === 0 ? null : (wins / decisive) * 100
}

/**
 * Below this many settled, staked bets the ROI and strike rate are mostly
 * noise: at 50 bets a true 52% hitter still lands anywhere from 38% to 66%.
 */
export const SMALL_SAMPLE = 50
export const isSmallSample = (n: number): boolean => n < SMALL_SAMPLE

export interface Roi {
  /** Return on investment as a percentage: profit / staked * 100. */
  pct: number
  /** Total risked across the bets that went into the calculation. */
  staked: number
  /** Net profit over those same bets (not the all-time P/L). */
  profit: number
  /** How many bets went into the calculation — the sample size. */
  counted: number
  /** Won/lost bets skipped because no stake was recorded — the honesty caveat. */
  missing: number
}

/**
 * ROI over the won and lost bets that recorded a real stake.
 *
 * Left out, each for its own reason: bets without a stake (an unknown stake
 * treated as 0 would send ROI toward infinity, treated as the profit would
 * invent data — `missing` reports how many); free bets with a stake of 0 (no
 * money was risked, so they can't have a return — see `bonusProfit`); pushes
 * and voids (the stake came back, so nothing was risked for ROI purposes:
 * counting them in the denominator would drag ROI toward zero on every tie);
 * and pending bets.
 *
 * The percentage is computed from the profit and the stake rounded to the
 * cent, as they are shown: 45.45 − 50 + 30 − 25.45 adds up to 1.8e-15 in
 * floating point, which would read "+0.0%" in green beside a P/L of $0.00.
 *
 * Returns null when nothing qualifies.
 */
export function roi(bets: readonly Bet[]): Roi | null {
  let staked = 0
  let profit = 0
  let counted = 0
  let missing = 0
  for (const b of bets) {
    if (b.status !== 'won' && b.status !== 'lost') continue
    if (b.stake === null) {
      missing++
      continue
    }
    if (b.stake === 0) continue
    staked += b.stake
    profit += b.amount ?? 0
    counted++
  }
  if (counted === 0 || staked <= 0) return null
  const stakedR = round2(staked)
  const profitR = round2(profit)
  return { pct: (profitR / stakedR) * 100, staked: stakedR, profit: profitR, counted, missing }
}

export interface Bonus {
  profit: number
  count: number
}

/**
 * What free bets (stake 0) returned. They're real money but not a return on
 * anything, so they're reported beside ROI rather than folded into it.
 */
export function bonusProfit(bets: readonly Bet[]): Bonus {
  let profit = 0
  let count = 0
  for (const b of bets) {
    if (b.stake !== 0 || (b.status !== 'won' && b.status !== 'lost')) continue
    profit += b.amount ?? 0
    count++
  }
  return { profit: round2(profit), count }
}

/** Average stake across the bets that recorded one; null when there are none. */
export function averageStake(bets: readonly Bet[]): number | null {
  let sum = 0
  let n = 0
  for (const b of bets) {
    if (b.stake === null) continue
    sum += b.stake
    n++
  }
  return n === 0 ? null : round2(sum / n)
}

export interface Implied {
  /** Mean implied probability, as a percentage. */
  avg: number
  /** How many won/lost bets had odds recorded. */
  n: number
}

/**
 * The average implied probability of the won and lost bets that recorded
 * odds — the strike rate a bettor has to beat to come out ahead at those
 * prices. Null when no decided bet carries odds.
 */
export function averageImplied(bets: readonly Bet[]): Implied | null {
  let sum = 0
  let n = 0
  for (const b of bets) {
    if ((b.status !== 'won' && b.status !== 'lost') || b.odds === null) continue
    sum += impliedProbability(b.odds)
    n++
  }
  return n === 0 ? null : { avg: (sum / n) * 100, n }
}

/**
 * Closing line value, as a percentage: how much better the price taken was
 * than where the market closed. 2.50 taken, 2.20 at close → +13.6%.
 */
export const clvOf = (odds: number, closing: number): number => (odds / closing - 1) * 100

export interface Clv {
  /** Mean CLV, as a percentage. */
  avg: number
  /** Bets with both a price and a closing price — whatever their result. */
  n: number
  /** How many of those beat the close. */
  beat: number
}

/**
 * Average CLV over every bet that recorded both prices. The result of the bet
 * is irrelevant: beating the close is the signal, winning is the noise.
 */
export function averageClv(bets: readonly Bet[]): Clv | null {
  let sum = 0
  let n = 0
  let beat = 0
  for (const b of bets) {
    if (b.odds === null || b.closingOdds === null) continue
    const c = clvOf(b.odds, b.closingOdds)
    sum += c
    n++
    if (c > 0) beat++
  }
  return n === 0 ? null : { avg: sum / n, n, beat }
}

export interface Streak {
  kind: 'W' | 'L'
  count: number
}

/** Run of same-sign DAY totals, newest first. Break-even and unscored days are skipped. */
export function currentStreak(days: readonly DaySummary[]): Streak | null {
  let kind: 'W' | 'L' | null = null
  let count = 0
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i]
    if (day.scored === 0 || day.total === 0) continue
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

/** Cumulative balance, one point per scored day (each day's bets summed first). */
export function cumulativeSeries(days: readonly DaySummary[]): BalancePoint[] {
  let balance = 0
  const points: BalancePoint[] = []
  for (const day of days) {
    if (day.scored === 0) continue
    balance = round2(balance + day.total)
    points.push({ date: day.date, dayTotal: day.total, balance })
  }
  return points
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

/**
 * The |P/L| of each decided day of a month up to `today` (YYYY-MM-DD), for
 * heatOf: a day with a result other than break-even. Days still to come are
 * never tinted, so they don't count.
 */
export function heatSizes(dayMap: ReadonlyMap<string, DaySummary>, ym: MonthKey, today: string): number[] {
  const out: number[] = []
  for (let d = 1; d <= daysInMonth(ym); d++) {
    const date = toDateStr(ym.year, ym.month, d)
    if (date > today) break
    const s = dayMap.get(date)
    if (s && s.scored > 0 && s.total !== 0) out.push(Math.abs(s.total))
  }
  return out
}

/**
 * How big a day's P/L is next to the month's other decided days, by thirds:
 * 1 the smallest third, 3 the largest. The calendar's tint deepens with it,
 * so the big days stand out at a glance. `sizes` is every decided day's |P/L|
 * up to today (heatSizes). Ties share a bucket by their middle rank, so a
 * month of one decided day, or of equal days, sits in the middle rather than
 * reading as all big.
 */
export function heatOf(sizes: readonly number[], total: number): 1 | 2 | 3 {
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

/** Best and worst net day in one pass. Either side is null when no such day exists. */
export function extremeDays(days: readonly DaySummary[]): { best: DaySummary | null; worst: DaySummary | null } {
  let best: DaySummary | null = null
  let worst: DaySummary | null = null
  for (const day of days) {
    if (day.scored === 0) continue
    if (day.total > 0 && (best === null || day.total > best.total)) best = day
    if (day.total < 0 && (worst === null || day.total < worst.total)) worst = day
  }
  return { best, worst }
}

/** Which tag a breakdown groups by. */
export type TagKey = 'sport' | 'book' | 'betType'

/** Everything the breakdown can group by: a tag, the odds band, the weekday or the month. */
export type Grouping = TagKey | 'odds' | 'weekday' | 'month'

export const GROUPINGS: readonly Grouping[] = ['sport', 'book', 'betType', 'odds', 'weekday', 'month']

export interface BreakdownRow {
  /**
   * The group's key: the tag value ("NBA"), the band ("dog"), the weekday
   * ("0" = Sunday) or the month ("2026-08"). The UI turns it into words.
   */
  label: string
  /** Settled bets in this slice. */
  bets: number
  pending: number
  profit: number
  wl: WinLoss
  /** ROI for this slice, or null when none of its bets qualifies. */
  roi: number | null
  staked: number
  /**
   * How many of `bets` the ROI covers. When it's below `bets` the two figures
   * describe different sets — profit is all-in, ROI only the staked ones — so
   * the UI has to say so rather than let them look contradictory.
   */
  roiBets: number
  /** Average closing line value over the bets here with both prices, and how many that is. */
  clv: number | null
  clvBets: number
}

/**
 * The group a bet belongs to, or null when it can't be placed (no tag, no
 * odds). The casino plays are one sport however they were tagged ("casino",
 * "Casino"): see lib/casino.ts.
 */
export function groupKeyOf(b: Bet, grouping: Grouping): string | null {
  switch (grouping) {
    case 'odds':
      return bandOf(b.odds)
    case 'weekday':
      return String(weekdayOf(b.date))
    case 'month':
      return b.date.slice(0, 7)
    case 'sport':
      return isCasino(b.sport) ? CASINO_SPORT : b.sport || null
    default:
      return b[grouping] || null
  }
}

type RowOrder = (a: BreakdownRow, b: BreakdownRow) => number

/** Tags read best-first; bands, weekdays and months read in their natural order. */
const byProfit: RowOrder = (a, b) => b.profit - a.profit || a.label.localeCompare(b.label)
const ORDER: Record<Grouping, RowOrder> = {
  sport: byProfit,
  book: byProfit,
  betType: byProfit,
  odds: (a, b) => bandIndex(a.label) - bandIndex(b.label),
  weekday: (a, b) => Number(a.label) - Number(b.label),
  month: (a, b) => a.label.localeCompare(b.label)
}

/**
 * Performance grouped by a tag, odds band, weekday or month. Bets that can't
 * be placed are left out — an empty tag or a missing price is missing data,
 * not a category, and bundling them under "(none)" would invite comparing a
 * real book against a bucket of leftovers.
 */
export function breakdown(bets: readonly Bet[], grouping: Grouping): BreakdownRow[] {
  const groups = new Map<string, Bet[]>()
  for (const b of bets) {
    const label = groupKeyOf(b, grouping)
    if (label === null) continue
    const list = groups.get(label)
    if (list) list.push(b)
    else groups.set(label, [b])
  }
  return [...groups.entries()]
    .map(([label, list]) => {
      const r = roi(list)
      const c = averageClv(list)
      const pending = list.filter((b) => b.status === 'pending').length
      return {
        label,
        bets: list.length - pending,
        pending,
        profit: total(list),
        wl: betWinLoss(list),
        roi: r ? r.pct : null,
        staked: r ? r.staked : 0,
        roiBets: r ? r.counted : 0,
        clv: c ? c.avg : null,
        clvBets: c ? c.n : 0
      }
    })
    .sort(ORDER[grouping])
}

/** Every distinct value a tag takes, sorted — used to populate filter menus. */
export function tagValues(bets: readonly Bet[], key: TagKey): string[] {
  const seen = new Set<string>()
  for (const b of bets) {
    if (b[key]) seen.add(b[key])
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

export interface Summary {
  days: DaySummary[]
  total: number
  /** Every bet, pending included. */
  bets: number
  /** Bets still waiting on a result, and how much is riding on them. */
  pendingCount: number
  pendingStaked: number
  dayCount: number
  dayWl: WinLoss
  betWl: WinLoss
  /** Strike rate by bet, and the sample it rests on (wins + losses). */
  strike: number | null
  strikeN: number
  /** Win rate by day — how the calendar reads. */
  dayRate: number | null
  streak: Streak | null
  roi: Roi | null
  bonus: Bonus
  implied: Implied | null
  clv: Clv | null
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
 * The individual helpers above used to each re-group the bets, so rendering
 * the stat cards walked the whole history about seven times over.
 */
export function summarize(bets: readonly Bet[]): Summary {
  const days = groupByDay(bets)
  const { best, worst } = extremeDays(days)
  const series = cumulativeSeries(days)
  const betWl = betWinLoss(bets)
  const dayWl = dayWinLoss(days)
  const open = riding(bets)
  return {
    days,
    total: total(bets),
    bets: bets.length,
    pendingCount: open.count,
    pendingStaked: open.staked,
    dayCount: days.length,
    dayWl,
    betWl,
    strike: strikeRate(betWl),
    strikeN: betWl.wins + betWl.losses,
    dayRate: strikeRate(dayWl),
    streak: currentStreak(days),
    roi: roi(bets),
    bonus: bonusProfit(bets),
    implied: averageImplied(bets),
    clv: averageClv(bets),
    avgStake: averageStake(bets),
    best,
    worst,
    series,
    drawdown: maxDrawdown(series),
    first: days.length > 0 ? days[0].date : null
  }
}

import type { BankrollMove, Bet, BetStatus } from '../../../shared/types'
import { inBounds, shiftDays, type Bounds } from './range'
import { roundCents } from './validate'

/**
 * The bankroll: the starting bankroll, plus every deposit and withdrawal,
 * plus every settled result. Worked in whole cents so a long history of
 * $0.10 bets never drifts, and never clamped: a bankroll below zero is shown
 * as it is, because it usually means a deposit was never logged.
 */

/** A stake above this share of the bankroll gets the stronger hint. */
export const STAKE_WARN_RATIO = 0.05

/** STAKE_WARN_RATIO as a whole divisor, so the check stays in integers: 5% is 1/20. */
const WARN_DIVISOR = Math.round(1 / STAKE_WARN_RATIO)

const toCents = (n: number): number => Math.round(roundCents(n) * 100)
const toDollars = (cents: number): number => cents / 100

export type Bankroll =
  | { known: false; reason: 'loading' | 'unset' }
  | {
      known: true
      /** The starting bankroll, 0 when only moves were logged. */
      start: number
      startSet: boolean
      deposits: { count: number; sum: number }
      /** `sum` is negative: the withdrawals as stored. */
      withdrawals: { count: number; sum: number }
      /** start + every move: the money put in, net. The chart's "Deposited" line ends here. */
      funded: number
      settledPL: number
      current: number
      /** Stakes of the pending bets: money on the table, still part of `current`. */
      inPlay: number
      inPlayCount: number
      /** Pending bets with no stake recorded, so `inPlay` leaves them out. */
      unstakedPending: number
      firstBetDate: string | null
    }

/**
 * Where the bankroll stands now. Pass ALL bets, never the range-filtered
 * list: the bankroll is money in the account today, whatever the chart shows.
 *
 * `moves` is null until the moves were loaded once on this device and
 * `start` undefined until the settings were; either reads 'loading' rather
 * than a number that would jump once they arrive. With no starting bankroll
 * and no moves there is nothing to count from: 'unset'. Moves without a
 * starting bankroll count from 0.
 *
 * Moves dated in the future count already: the date is the user's label, the
 * money is logged as moved. A pending bet adds nothing until it settles.
 */
export function bankrollNow(bets: readonly Bet[], moves: readonly BankrollMove[] | null, start: number | null | undefined): Bankroll {
  if (moves === null || start === undefined) return { known: false, reason: 'loading' }
  if (start === null && moves.length === 0) return { known: false, reason: 'unset' }

  const startC = toCents(start ?? 0)
  let depositC = 0
  let depositN = 0
  let withdrawC = 0
  let withdrawN = 0
  for (const m of moves) {
    const c = toCents(m.amount)
    if (c > 0) {
      depositC += c
      depositN++
    } else if (c < 0) {
      withdrawC += c
      withdrawN++
    }
  }

  let plC = 0
  let inPlayC = 0
  let inPlayCount = 0
  let unstakedPending = 0
  let firstBetDate: string | null = null
  for (const b of bets) {
    if (firstBetDate === null || b.date < firstBetDate) firstBetDate = b.date
    if (b.status === 'pending') {
      inPlayCount++
      if (b.stake === null) unstakedPending++
      else inPlayC += toCents(b.stake)
    } else {
      plC += toCents(b.amount ?? 0)
    }
  }

  const fundedC = startC + depositC + withdrawC
  return {
    known: true,
    start: toDollars(startC),
    startSet: start !== null,
    deposits: { count: depositN, sum: toDollars(depositC) },
    withdrawals: { count: withdrawN, sum: toDollars(withdrawC) },
    funded: toDollars(fundedC),
    settledPL: toDollars(plC),
    current: toDollars(fundedC + plC),
    inPlay: toDollars(inPlayC),
    inPlayCount,
    unstakedPending,
    firstBetDate
  }
}

export interface BankrollPoint {
  date: string
  /** The bankroll at the end of the day. */
  balance: number
  /** The day's settled result. */
  dayTotal: number
  /** The day's deposits less withdrawals. */
  moved: number
  /** start + moves to date: the "Deposited" line. */
  funded: number
  /** The point before the first day shown, carrying everything earlier. */
  opening?: true
}

/**
 * The bankroll day by day: one end-of-day point per date with a settled bet
 * or a move (a day with only pending bets moves nothing), ascending.
 *
 * It starts with an opening point the day before the first one shown (the
 * day before `bounds.from` when set) that carries everything earlier, so the
 * line starts where the money stood rather than at 0, and a range shows the
 * real balance, not a fresh start. Points outside the bounds are left out at
 * both ends. Nothing in the bounds: no points.
 *
 * The last point with no bounds is bankrollNow's `current` and `funded`.
 */
export function bankrollSeries(bets: readonly Bet[], moves: readonly BankrollMove[], start: number, bounds?: Bounds): BankrollPoint[] {
  const days = new Map<string, { plC: number; movedC: number }>()
  const day = (date: string): { plC: number; movedC: number } => {
    let d = days.get(date)
    if (!d) {
      d = { plC: 0, movedC: 0 }
      days.set(date, d)
    }
    return d
  }
  for (const b of bets) if (b.status !== 'pending') day(b.date).plC += toCents(b.amount ?? 0)
  for (const m of moves) day(m.date).movedC += toCents(m.amount)

  const from = bounds?.from ?? null
  const to = bounds?.to ?? null
  let fundedC = toCents(start)
  let plC = 0
  let opening: BankrollPoint | null = null
  const points: BankrollPoint[] = []
  for (const [date, d] of [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (from !== null && date < from) {
      // Before the range: folds into the opening point.
      fundedC += d.movedC
      plC += d.plC
      continue
    }
    if (!inBounds(date, { from, to })) break
    if (opening === null) {
      const balance = toDollars(fundedC + plC)
      opening = { date: shiftDays(from ?? date, -1), balance, dayTotal: 0, moved: 0, funded: toDollars(fundedC), opening: true }
      points.push(opening)
    }
    fundedC += d.movedC
    plC += d.plC
    points.push({ date, balance: toDollars(fundedC + plC), dayTotal: toDollars(d.plC), moved: toDollars(d.movedC), funded: toDollars(fundedC) })
  }
  return points
}

/** The hint under the stake box. */
export type StakeNote =
  /** Bankroll unknown: nothing to compare with. */
  | { kind: 'none' }
  /** No stake typed yet: just the bankroll. */
  | { kind: 'bankroll'; current: number }
  /** The stake as a share of the bankroll; 'over' past STAKE_WARN_RATIO. */
  | { kind: 'share' | 'over'; pct: number; current: number }
  /** Nothing left to stake from. */
  | { kind: 'empty'; current: number }

/**
 * How a stake compares with the bankroll. Only a hint: the form never blocks.
 *
 * The line is judged in cents, so exactly 5% is still a share. The shown
 * percentage rounds away from the line: an 'over' rounds up and a share
 * down, so 59.01 of 1,180 reads 5.1% over, never "5.0% over", and 59 reads
 * 5.0%.
 */
export function stakeNote(stake: number | null, current: number | null): StakeNote {
  if (current === null) return { kind: 'none' }
  const stakeC = stake === null || !Number.isFinite(stake) ? 0 : toCents(stake)
  if (stakeC <= 0) return { kind: 'bankroll', current }
  const currentC = toCents(current)
  if (currentC <= 0) return { kind: 'empty', current }
  // Tenths of a percent, from integers: 1.40 of 100.00 is 14 exactly, where
  // 1.4 / 100 * 1000 in floating point is 13.99…, which would floor to 1.3%.
  const tenths = (stakeC * 1000) / currentC
  if (stakeC * WARN_DIVISOR > currentC) return { kind: 'over', pct: Math.ceil(tenths) / 10, current }
  return { kind: 'share', pct: Math.floor(tenths) / 10, current }
}

/**
 * The stake hint is for a bet being placed: one dated today or later, or
 * still pending. A bet settled in the past was staked from a bankroll that
 * is not today's, so comparing it with today's would mislead.
 */
export const stakeNoteApplies = (date: string, status: BetStatus, today: string): boolean => date >= today || status === 'pending'

/** The date of the earliest bet, whatever its status, or null with no bets. */
export function firstBetDate(bets: readonly Bet[]): string | null {
  let first: string | null = null
  for (const b of bets) if (first === null || b.date < first) first = b.date
  return first
}

/**
 * Soft checks on a deposit or withdrawal being saved; they never block.
 * - duplicate: another move on the same date for the same amount, the shape
 *   of a double tap or of logging one transfer twice;
 * - belowZero: saving it leaves the bankroll below zero and lower than it is
 *   now (a deposit into a bankroll that is already negative is no mistake);
 * - beforeStart: a deposit on or before the first bet, when a starting
 *   bankroll above zero is set — the starting bankroll is usually that money
 *   already (a start of $0 covers nothing).
 */
export type MoveHint = 'duplicate' | 'belowZero' | 'beforeStart'

export function moveHints(draft: { date: string; amount: number }, moves: readonly BankrollMove[], b: Bankroll, editingId?: string): MoveHint[] {
  const hints: MoveHint[] = []
  const draftC = toCents(draft.amount)
  if (moves.some((m) => m.id !== editingId && m.date === draft.date && toCents(m.amount) === draftC)) hints.push('duplicate')
  if (b.known) {
    // An edit replaces the move's old amount, so an unchanged edit changes nothing.
    const old = editingId === undefined ? undefined : moves.find((m) => m.id === editingId)
    const changeC = draftC - (old ? toCents(old.amount) : 0)
    if (changeC < 0 && toCents(b.current) + changeC < 0) hints.push('belowZero')
    if (draftC > 0 && b.startSet && b.start > 0 && b.firstBetDate !== null && draft.date <= b.firstBetDate) hints.push('beforeStart')
  }
  return hints
}

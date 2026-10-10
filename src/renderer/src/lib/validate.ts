import { isBetStatus, statusForAmount, type BetInput, type BetStatus } from '../../../shared/types'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Single source of truth for the money ceiling — the form and the writer agree. */
export const MAX_AMOUNT = 100_000_000
/** Decimal odds above this are a typo, not a price. */
export const MAX_ODDS = 1000
export const MAX_NOTE_LENGTH = 500
export const MAX_TAG_LENGTH = 40

export function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false
  const [y, m, d] = date.split('-').map(Number)
  const parsed = new Date(y, m - 1, d)
  return parsed.getFullYear() === y && parsed.getMonth() === m - 1 && parsed.getDate() === d
}

export const round2 = (n: number): number => Math.round(n * 100) / 100

/** Tags are free text: collapse whitespace, cap the length, keep the user's casing. */
function cleanTag(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH)
}

function cleanMoney(value: number | null | undefined, what: string, min: number): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${what} must be a finite number`)
  if (value < min) throw new Error(`${what} cannot be ${min === 0 ? 'negative' : `below ${min}`}`)
  if (value > MAX_AMOUNT) throw new Error(`${what} is out of range`)
  return round2(value)
}

function cleanOdds(value: number | null | undefined, what: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${what} must be a finite number`)
  if (value <= 1) throw new Error(`${what} must be greater than 1 (decimal)`)
  if (value > MAX_ODDS) throw new Error(`${what} are out of range`)
  return Math.round(value * 1000) / 1000
}

export interface CleanBet {
  date: string
  amount: number | null
  stake: number | null
  odds: number | null
  closingOdds: number | null
  status: BetStatus
  note: string
  sport: string
  book: string
  betType: string
}

/**
 * Validate and clean a raw bet before it is written anywhere. Throws on bad
 * input, so nothing half-valid reaches the outbox or the backend.
 *
 * Status and amount are checked against each other: a pending bet has no
 * amount, a won bet nets positive, a lost one negative, and a push or void is
 * exactly 0. The same rule the 003 migration used to backfill status.
 */
export function normalizeInput(input: BetInput): CleanBet {
  if (!isValidDate(input.date)) {
    throw new Error(`"${input.date}" is not a valid calendar date`)
  }

  if (input.status !== undefined && !isBetStatus(input.status)) {
    throw new Error(`"${String(input.status)}" is not a bet status`)
  }

  const rawAmount = input.amount === undefined ? null : input.amount
  if (rawAmount !== null && (typeof rawAmount !== 'number' || !Number.isFinite(rawAmount))) {
    throw new Error('Amount must be a finite number')
  }
  if (rawAmount !== null && Math.abs(rawAmount) > MAX_AMOUNT) {
    throw new Error('Amount is out of range')
  }
  // The sign is read off what gets stored, in cents: a 0.004 result is 0.00,
  // a push, not a win. Checking before rounding would store a "won" 0.00,
  // which the database's status trigger would later read as a push.
  const cents = rawAmount === null ? null : round2(rawAmount)

  // No status given: it is whatever the result says, which is what every bet
  // logged before statuses existed relies on.
  let status: BetStatus
  if (input.status !== undefined) status = input.status
  else if (cents === null) status = 'pending'
  else status = statusForAmount(cents)

  let amount: number | null
  switch (status) {
    case 'pending':
      amount = null
      break
    case 'won':
      if (cents === null) throw new Error('A won bet needs its result')
      if (cents <= 0) throw new Error('A won bet nets a positive amount')
      amount = cents
      break
    case 'lost':
      if (cents === null) throw new Error('A lost bet needs its result')
      if (cents >= 0) throw new Error('A lost bet nets a negative amount')
      amount = cents
      break
    case 'push':
    case 'void':
      if (cents !== null && cents !== 0) throw new Error(`A ${status} returns the stake — its result is 0`)
      amount = 0
      break
  }

  // Undefined/null both mean "not recorded" and stay null — only a real number
  // becomes a stake, so ROI is never computed against a value nobody entered.
  const stake = cleanMoney(input.stake, 'Stake', 0)

  const odds = cleanOdds(input.odds, 'Odds')
  const closingOdds = cleanOdds(input.closingOdds, 'Closing odds')

  return {
    date: input.date,
    amount,
    stake,
    odds,
    closingOdds,
    status,
    note: (input.note ?? '').trim().slice(0, MAX_NOTE_LENGTH),
    sport: cleanTag(input.sport),
    book: cleanTag(input.book),
    betType: cleanTag(input.betType)
  }
}

/**
 * The result a settlement implies when stake and odds are known: a win pays
 * stake × (odds − 1), a loss costs the stake, a push or void returns it. Null
 * when it can't be worked out, so the form leaves the field for the user.
 */
export function suggestedAmount(status: BetStatus, stake: number | null, odds: number | null): number | null {
  switch (status) {
    case 'push':
    case 'void':
      return 0
    case 'lost':
      return stake === null ? null : -stake
    case 'won':
      return stake === null || odds === null ? null : round2(stake * (odds - 1))
    case 'pending':
      return null
  }
}

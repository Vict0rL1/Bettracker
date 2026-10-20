import { isBetStatus, statusForAmount, type BetInput, type BetStatus, type MoveInput, type Settings, type SettingsPatch } from '../../../shared/types'

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

/** Why a bet or a deposit was refused, as a code the forms put in the user's language. */
export type InputCode =
  | 'date'
  | 'status'
  | 'amountNumber'
  | 'amountRange'
  | 'wonNeedsResult'
  | 'wonPositive'
  | 'lostNeedsResult'
  | 'lostNegative'
  | 'zeroResult'
  | 'stakeNumber'
  | 'stakeNegative'
  | 'stakeRange'
  | 'oddsNumber'
  | 'oddsLow'
  | 'oddsRange'
  | 'closingNumber'
  | 'closingLow'
  | 'closingRange'
  | 'moveZero'

/**
 * Bad input, refused before anything is queued. The message stays English
 * (the CSV import quotes it per line); `code` and `vars` are for the forms.
 */
export class InputError extends Error {
  readonly code: InputCode
  readonly vars: Record<string, string | number>
  constructor(code: InputCode, message: string, vars: Record<string, string | number> = {}) {
    super(message)
    this.name = 'InputError'
    this.code = code
    this.vars = vars
  }
}

/** Tags are free text: collapse whitespace, cap the length, keep the user's casing. */
function cleanTag(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH)
}

function cleanStake(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new InputError('stakeNumber', 'Stake must be a finite number')
  if (value < 0) throw new InputError('stakeNegative', 'Stake cannot be negative')
  if (value > MAX_AMOUNT) throw new InputError('stakeRange', 'Stake is out of range')
  return round2(value)
}

/** A price as the database stores it: 3 decimals. */
const roundOdds = (value: number): number => Math.round(value * 1000) / 1000

/**
 * True when a decimal price survives being stored: above 1 and within range
 * once rounded to the 3 decimals the database keeps. The forms and the CSV
 * import use it so they never offer the writer a price it would refuse.
 */
export const storableOdds = (value: number): boolean => {
  const rounded = roundOdds(value)
  return rounded > 1 && rounded <= MAX_ODDS
}

function cleanOdds(value: number | null | undefined, which: 'odds' | 'closing'): number | null {
  if (value === undefined || value === null) return null
  const what = which === 'odds' ? 'Odds' : 'Closing odds'
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new InputError(`${which}Number`, `${what} must be a finite number`)
  // Checked after rounding to what the database stores: 1.0004 would
  // otherwise pass here and be refused there as 1.000.
  const rounded = roundOdds(value)
  if (rounded <= 1) throw new InputError(`${which}Low`, `${what} must be greater than 1 (decimal)`)
  if (rounded > MAX_ODDS) throw new InputError(`${which}Range`, `${what} are out of range`)
  return rounded
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
 * Validate and clean a raw bet before it is written anywhere. Throws an
 * InputError on bad input, so nothing half-valid reaches the outbox or the
 * backend.
 *
 * Status and amount are checked against each other: a pending bet has no
 * amount, a won bet nets positive, a lost one negative, and a push or void is
 * exactly 0. The same rule the 003 migration used to backfill status. One
 * exception: a free bet (a stake of 0) that loses costs nothing, so its
 * result is 0 (migration 006 keeps the database from reading it as a push).
 */
export function normalizeInput(input: BetInput): CleanBet {
  if (!isValidDate(input.date)) {
    throw new InputError('date', `"${input.date}" is not a valid calendar date`)
  }

  if (input.status !== undefined && !isBetStatus(input.status)) {
    throw new InputError('status', `"${String(input.status)}" is not a bet status`)
  }

  const rawAmount = input.amount === undefined ? null : input.amount
  if (rawAmount !== null && (typeof rawAmount !== 'number' || !Number.isFinite(rawAmount))) {
    throw new InputError('amountNumber', 'Amount must be a finite number')
  }
  if (rawAmount !== null && Math.abs(rawAmount) > MAX_AMOUNT) {
    throw new InputError('amountRange', 'Amount is out of range')
  }
  // The sign is read off what gets stored, in cents: a 0.004 result is 0.00,
  // a push, not a win. Checking before rounding would store a "won" 0.00,
  // which the database's status trigger would later read as a push.
  const cents = rawAmount === null ? null : round2(rawAmount)

  // Undefined/null both mean "not recorded" and stay null — only a real number
  // becomes a stake, so ROI is never computed against a value nobody entered.
  const stake = cleanStake(input.stake)

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
      if (cents === null) throw new InputError('wonNeedsResult', 'A won bet needs its result')
      if (cents <= 0) throw new InputError('wonPositive', 'A won bet nets a positive amount')
      amount = cents
      break
    case 'lost':
      if (cents === null) throw new InputError('lostNeedsResult', 'A lost bet needs its result')
      if (cents > 0 || (cents === 0 && stake !== 0)) throw new InputError('lostNegative', 'A lost bet nets a negative amount')
      // 0, never -0 (a free bet's stake, negated): it would show as "-$0.00".
      amount = cents === 0 ? 0 : cents
      break
    case 'push':
    case 'void':
      if (cents !== null && cents !== 0) throw new InputError('zeroResult', `A ${status} returns the stake — its result is 0`, { status })
      amount = 0
      break
  }

  const odds = cleanOdds(input.odds, 'odds')
  const closingOdds = cleanOdds(input.closingOdds, 'closing')

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

/**
 * Round a signed amount to cents the way the database does: by its size, then
 * the sign. round2 rounds halves up (-12.345 → -12.34), so a withdrawal and a
 * deposit of the same typed amount would otherwise store different sizes.
 */
export const roundCents = (n: number): number => (n < 0 ? -round2(-n) : round2(n))

export interface CleanMove {
  date: string
  amount: number
  note: string
}

/**
 * Validate and clean a deposit or withdrawal before it is queued. Throws on
 * bad input. The amount is checked once rounded to cents, as stored: 0.004
 * is 0, which the database refuses.
 */
export function normalizeMove(input: MoveInput): CleanMove {
  if (!isValidDate(input.date)) throw new InputError('date', `"${input.date}" is not a valid calendar date`)
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount)) throw new InputError('amountNumber', 'Amount must be a finite number')
  const amount = roundCents(input.amount)
  if (amount === 0) throw new InputError('moveZero', 'Amount cannot be zero')
  if (Math.abs(amount) > MAX_AMOUNT) throw new InputError('amountRange', 'Amount is out of range')
  return { date: input.date, amount, note: (input.note ?? '').trim().slice(0, MAX_NOTE_LENGTH) }
}

/**
 * A money box in the settings (unit size, starting bankroll, default stake):
 * null when cleared, the amount rounded to cents, or 'invalid' for anything the
 * database would refuse. Zero is judged once rounded, as stored: 0.004 is 0,
 * and a unit size of 0 would be refused, taking every other change merged
 * into the same settings patch down with it.
 */
export function parseMoneyBox(text: string, opts: { allowZero: boolean }): number | null | 'invalid' {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const n = parseFloat(trimmed)
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) return 'invalid'
  const rounded = round2(n)
  if (rounded === 0) return opts.allowZero ? 0 : 'invalid'
  return rounded
}

/** Dollars per unit when amounts show in units; null shows dollars. */
export const effectiveUnit = (s: Pick<Settings, 'showUnits' | 'unitSize'>): number | null =>
  s.showUnits && s.unitSize !== null && s.unitSize > 0 ? s.unitSize : null

/**
 * What committing the unit size box sends: a patch, null when nothing
 * changed, or 'revert' to put the saved value back in a box holding nonsense.
 * Clearing the unit also turns units off, since there is nothing left to
 * count them in.
 */
export function unitSizePatch(text: string, s: Pick<Settings, 'unitSize' | 'showUnits'>): SettingsPatch | null | 'revert' {
  const value = parseMoneyBox(text, { allowZero: false })
  if (value === 'invalid') return 'revert'
  if (value === null) return s.unitSize === null && !s.showUnits ? null : { unitSize: null, showUnits: false }
  return value === s.unitSize ? null : { unitSize: value }
}

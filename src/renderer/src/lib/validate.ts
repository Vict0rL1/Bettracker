import {
  BUDGET_SCOPES,
  isBetStatus,
  isCurrencyCode,
  statusForAmount,
  type BetInput,
  type BetStatus,
  type BudgetScope,
  type CardKind,
  type ExpenseBudgetInput,
  type ExpenseCardInput,
  type ExpenseCategory,
  type ExpenseInput,
  type ExpenseSource,
  type MoveInput,
  type Settings,
  type SettingsPatch
} from '../../../shared/types'
import { isExpenseCategory, toCategory } from './categories'
import { MAX_RATE, roundRate } from './fx'

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
  | 'expenseCard'
  | 'expenseOriginal'
  | 'expenseRate'
  | 'cardName'
  | 'cardLast4'
  | 'cardKind'
  | 'budgetScope'
  | 'budgetLimit'

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

export const MAX_MERCHANT_LENGTH = 80
export const MAX_CARD_NAME_LENGTH = 40

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Free text typed or read from a picture: control characters out (as spaces,
 * so "Café\nCentral" keeps its two words), whitespace collapsed, trimmed,
 * capped. The cap never splits an emoji in half (the database would refuse
 * the broken character).
 */
function cleanText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : ''
  if (text.length <= max) return text
  let cut = text.slice(0, max)
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1)
  return cut.trimEnd()
}

/** The most a rate can be: numeric(18, 8) has ten digits before the point, and no real rate comes near. */
export const MAX_FX_RATE = MAX_RATE

/** A rate as stored: 8 decimals (lib/fx.ts, which the live rates check compiles on its own). */
export { roundRate }

export interface CleanExpense {
  date: string
  amount: number
  /** Paid in another currency: all three set; else all three null. */
  originalAmount: number | null
  originalCurrency: string | null
  fxRate: number | null
  cardId: string | null
  merchant: string
  category: ExpenseCategory
  note: string
  source: ExpenseSource
}

export interface CleanCard {
  name: string
  last4: string
  kind: CardKind
  archived: boolean
}

export interface CleanBudget {
  scope: BudgetScope
  target: string
  monthlyLimit: number
}

/**
 * Validate and clean an expense before it is queued (table `expenses`,
 * migration 008). Throws on bad input. The amount is signed (− a refund or a
 * credit) and judged once rounded to cents, as stored: 0.004 is 0, which the
 * database refuses. A category the app doesn't know is filed as 'other'.
 *
 * Paid in another currency (migration 009): originalAmount, originalCurrency
 * and fxRate come together or not at all (each missing one is null). The
 * original is rounded to cents, never 0, within the same bound and with the
 * same sign as the amount; the code is an ISO code as stored (capitals); the
 * rate is rounded to 8 decimals and more than 0 once rounded. The amount is
 * NOT required to be original × rate: the user may type what the bank charged.
 */
export function normalizeExpense(input: ExpenseInput): CleanExpense {
  if (typeof input.date !== 'string' || !isValidDate(input.date)) throw new InputError('date', `"${String(input.date)}" is not a valid calendar date`)
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount)) throw new InputError('amountNumber', 'Amount must be a finite number')
  const amount = roundCents(input.amount)
  if (amount === 0) throw new InputError('moveZero', 'Amount cannot be zero')
  if (Math.abs(amount) > MAX_AMOUNT) throw new InputError('amountRange', 'Amount is out of range')
  const given = [input.originalAmount, input.originalCurrency, input.fxRate].filter((v) => v !== undefined && v !== null).length
  let originalAmount: number | null = null
  let originalCurrency: string | null = null
  let fxRate: number | null = null
  if (given !== 0) {
    if (given !== 3) throw new InputError('expenseOriginal', 'The original amount, its currency and the rate come together')
    if (typeof input.originalAmount !== 'number' || !Number.isFinite(input.originalAmount)) throw new InputError('expenseOriginal', 'The original amount must be a finite number')
    originalAmount = roundCents(input.originalAmount)
    if (originalAmount === 0) throw new InputError('expenseOriginal', 'The original amount cannot be zero')
    if (Math.abs(originalAmount) > MAX_AMOUNT) throw new InputError('amountRange', 'The original amount is out of range')
    if (Math.sign(originalAmount) !== Math.sign(amount)) throw new InputError('expenseOriginal', 'The original amount and the amount have the same sign')
    if (!isCurrencyCode(input.originalCurrency)) throw new InputError('expenseOriginal', 'Not a currency code')
    originalCurrency = input.originalCurrency
    if (typeof input.fxRate !== 'number' || !Number.isFinite(input.fxRate)) throw new InputError('expenseRate', 'The rate must be a finite number')
    fxRate = roundRate(input.fxRate)
    if (fxRate <= 0 || fxRate > MAX_FX_RATE) throw new InputError('expenseRate', 'The rate must be more than 0')
  }
  let cardId: string | null = null
  if (input.cardId !== undefined && input.cardId !== null && input.cardId !== '') {
    if (typeof input.cardId !== 'string' || !UUID_RE.test(input.cardId)) throw new InputError('expenseCard', 'Not a card id')
    cardId = input.cardId.toLowerCase()
  }
  return {
    date: input.date,
    amount,
    originalAmount,
    originalCurrency,
    fxRate,
    cardId,
    merchant: cleanText(input.merchant, MAX_MERCHANT_LENGTH),
    category: toCategory(input.category),
    note: cleanText(input.note, MAX_NOTE_LENGTH),
    source: input.source === 'ai' ? 'ai' : 'manual'
  }
}

/** Validate and clean a card (table `expense_cards`). Throws on bad input. */
export function normalizeCard(input: ExpenseCardInput): CleanCard {
  const name = cleanText(input.name, Number.POSITIVE_INFINITY)
  if (name.length < 1 || name.length > MAX_CARD_NAME_LENGTH) throw new InputError('cardName', `A card name has 1 to ${MAX_CARD_NAME_LENGTH} characters`)
  const last4 = input.last4 === undefined || input.last4 === null ? '' : input.last4
  if (typeof last4 !== 'string' || (last4 !== '' && !/^\d{4}$/.test(last4))) throw new InputError('cardLast4', 'The last digits are 4 numbers or nothing')
  const kind = input.kind === undefined ? 'credit' : input.kind
  if (kind !== 'credit' && kind !== 'debit') throw new InputError('cardKind', 'A card is credit or debit')
  return { name, last4, kind, archived: input.archived === true }
}

/**
 * Validate and clean a monthly budget (table `expense_budgets`): the whole
 * month (target ''), a card (target = its id, lowercased) or a category
 * (target = its key). Throws on bad input.
 */
export function normalizeBudget(input: ExpenseBudgetInput): CleanBudget {
  const scope = input.scope
  if (!BUDGET_SCOPES.includes(scope)) throw new InputError('budgetScope', `"${String(scope)}" is not a budget scope`)
  const raw = typeof input.target === 'string' ? input.target : null
  let target: string
  if (scope === 'total') {
    if (raw !== '') throw new InputError('budgetScope', 'A total budget has no target')
    target = ''
  } else if (scope === 'card') {
    if (raw === null || !UUID_RE.test(raw)) throw new InputError('budgetScope', 'A card budget names a card id')
    target = raw.toLowerCase()
  } else {
    if (!isExpenseCategory(raw)) throw new InputError('budgetScope', 'A category budget names a category')
    target = raw
  }
  const limit = input.monthlyLimit
  if (typeof limit !== 'number' || !Number.isFinite(limit)) throw new InputError('budgetLimit', 'A budget must be a number')
  const monthlyLimit = round2(limit)
  if (monthlyLimit <= 0 || monthlyLimit > MAX_AMOUNT) throw new InputError('budgetLimit', 'A budget must be more than 0')
  return { scope, target, monthlyLimit }
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

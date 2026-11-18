import type { ExpenseCategory } from './expenseExtraction'

/**
 * One row = one bet. (The Supabase table is still called `entries`; renaming a
 * table is not an additive migration, and every policy and index hangs off
 * that name. The code calls them bets everywhere else.)
 */

/**
 * Where a bet stands. `push` is a tie: the stake comes back, which is
 * financially the same as `void` but a different thing happened.
 */
export type BetStatus = 'pending' | 'won' | 'lost' | 'push' | 'void'

export const BET_STATUSES: readonly BetStatus[] = ['pending', 'won', 'lost', 'push', 'void']

export const isBetStatus = (v: unknown): v is BetStatus => BET_STATUSES.includes(v as BetStatus)

export interface Bet {
  id: string
  /** Local calendar date, YYYY-MM-DD. Several bets may share a date. */
  date: string
  /**
   * Net result in dollars: > 0 won, < 0 lost, 0 push/void. Null ONLY while the
   * bet is pending — an unsettled bet has no result yet, and 0 would make an
   * open week read as break-even.
   */
  amount: number | null
  /**
   * Amount risked, or null when it wasn't recorded (bets logged before stake
   * tracking). Null is excluded from ROI rather than treated as 0. A stake of 0
   * is a free bet: real, but excluded from ROI and counted as bonus profit.
   */
  stake: number | null
  /** Decimal odds (1.91, 2.50 …), > 1, or null when not recorded. */
  odds: number | null
  /** The price when the market closed, for closing line value. Optional. */
  closingOdds: number | null
  status: BetStatus
  note: string
  /** Free-text tags; empty string means "not tagged". */
  sport: string
  book: string
  betType: string
  createdAt: string
  /**
   * When this bet was last edited, as set by the editing device. It doubles as
   * the conflict key between devices: see data/bets.ts.
   */
  updatedAt: string
}

export interface BetInput {
  date: string
  /** Omit or null for a pending bet. */
  amount?: number | null
  stake?: number | null
  odds?: number | null
  closingOdds?: number | null
  /** Derived from the sign of `amount` when omitted. */
  status?: BetStatus
  note?: string
  sport?: string
  book?: string
  betType?: string
}

/** A settled bet: its result is known. */
export type SettledBet = Bet & { amount: number; status: Exclude<BetStatus, 'pending'> }

export const isSettled = (b: Bet): b is SettledBet => b.status !== 'pending'

/** A bet whose stake is known — the subset ROI can be computed over. */
export type StakedBet = Bet & { stake: number }

export const hasStake = (b: Bet): b is StakedBet => b.stake !== null

/** The status a result implies: the rule the 003 migration backfilled with. */
export const statusForAmount = (amount: number): Exclude<BetStatus, 'pending' | 'void'> =>
  amount > 0 ? 'won' : amount < 0 ? 'lost' : 'push'

/** How odds are entered and shown. They are always stored as decimal. */
export type OddsFormat = 'american' | 'decimal' | 'fractional'

export const ODDS_FORMATS: readonly OddsFormat[] = ['american', 'decimal', 'fractional']

export const isOddsFormat = (v: unknown): v is OddsFormat => ODDS_FORMATS.includes(v as OddsFormat)

/** An ISO 4217 currency code as stored: three capital letters ("USD", "EUR"). */
export const isCurrencyCode = (v: unknown): v is string => typeof v === 'string' && /^[A-Z]{3}$/.test(v)

/**
 * Per-user preferences, one row per user (`user_settings`). Every field is
 * optional in the database; the app fills in these defaults when a row is
 * missing or a field is null, so code never has to.
 */
export interface Settings {
  oddsFormat: OddsFormat
  /** Dollars per unit; null until the user sets one. */
  unitSize: number | null
  showUnits: boolean
  startingBankroll: number | null
  defaultStake: number | null
  /** Monthly net loss at which the app warns. Never blocks. */
  lossLimit: number | null
  /** ISO 4217 code expenses are shown in (expenses only; bets stay in dollars). Never converts. */
  expenseCurrency: string
  /** Set by the editing device; the conflict key, as with bets. */
  updatedAt: string
}

export const DEFAULT_SETTINGS: Settings = {
  oddsFormat: 'american',
  unitSize: null,
  showUnits: false,
  startingBankroll: null,
  defaultStake: null,
  lossLimit: null,
  expenseCurrency: 'USD',
  updatedAt: ''
}

export type SettingsPatch = Partial<Omit<Settings, 'updatedAt'>>

/**
 * Money put into or taken out of the bankroll (table `bankroll_moves`): a
 * deposit is positive, a withdrawal negative, never 0. It is not a bet and
 * never counts in P/L, ROI or the loss limit.
 */
export interface BankrollMove {
  id: string
  /** Local calendar date, YYYY-MM-DD. */
  date: string
  amount: number
  note: string
  createdAt: string
  /** Set by the editing device; the conflict key, as with bets. */
  updatedAt: string
}

export interface MoveInput {
  date: string
  /** Signed: + deposit, − withdrawal. */
  amount: number
  note?: string
}

// Everyday expenses (migration 008). The categories live in the module the
// AI reading shares with the app; re-exported here for the app's code.
export { EXPENSE_CATEGORIES } from './expenseExtraction'
export type { ExpenseCategory } from './expenseExtraction'

export type ExpenseSource = 'manual' | 'ai'
export type CardKind = 'credit' | 'debit'
export type BudgetScope = 'total' | 'card' | 'category'
export const BUDGET_SCOPES: readonly BudgetScope[] = ['total', 'card', 'category']

/** One expense (table `expenses`, migration 008). amount: + spent, − refund or credit, never 0. */
export interface Expense {
  id: string
  /** Local calendar date, YYYY-MM-DD. */
  date: string
  amount: number
  /** A card's id, or null. May name a card this device doesn't have (no FK): shown as "No card". */
  cardId: string | null
  merchant: string
  category: ExpenseCategory
  note: string
  source: ExpenseSource
  createdAt: string
  /** Set by the editing device; the conflict key, as with bets. */
  updatedAt: string
}

export interface ExpenseInput {
  date: string
  /** Signed: + spent, − refund or credit. */
  amount: number
  cardId?: string | null
  merchant?: string
  /** A category key; one the app doesn't know is stored as 'other'. */
  category?: string
  note?: string
  source?: ExpenseSource
}

/** One of the user's cards (table `expense_cards`). Archived cards are hidden from pickers but still name old expenses. */
export interface ExpenseCard {
  id: string
  name: string
  /** The last 4 digits, or '' when not given. */
  last4: string
  kind: CardKind
  archived: boolean
  createdAt: string
  updatedAt: string
}

export interface ExpenseCardInput {
  name: string
  last4?: string
  kind?: CardKind
  archived?: boolean
}

/**
 * A monthly limit, the same every month (table `expense_budgets`): the whole
 * month (scope 'total', target ''), one card (target = the card's id) or one
 * category (target = the category key). Its id is made from (user, scope,
 * target): see lib/stableId.ts.
 */
export interface ExpenseBudget {
  id: string
  scope: BudgetScope
  target: string
  monthlyLimit: number
  createdAt: string
  updatedAt: string
}

export interface ExpenseBudgetInput {
  scope: BudgetScope
  target: string
  monthlyLimit: number
}

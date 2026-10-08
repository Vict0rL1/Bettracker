/**
 * One row = one bet. (The Supabase table is still called `entries`; renaming a
 * table is not an additive migration, and every policy and index hangs off
 * that name. The code calls them bets everywhere else.)
 */

/**
 * Where a bet stands. The names match the Sports Predictor's bets table where
 * they overlap (pending / won / lost / void) so rows can move between the two
 * apps without translation. `push` is a tie: the stake comes back, which is
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
  updatedAt: ''
}

export type SettingsPatch = Partial<Omit<Settings, 'updatedAt'>>

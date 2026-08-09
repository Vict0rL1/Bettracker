export interface BetEntry {
  id: string
  /** Local calendar date, YYYY-MM-DD. Several entries may share a date. */
  date: string
  /** Net result in dollars: > 0 win, < 0 loss, 0 push (break-even). */
  amount: number
  /**
   * Amount risked on the bet, or null when it wasn't recorded (entries logged
   * before stake tracking). Null is excluded from ROI rather than treated as 0,
   * which would silently distort the number.
   */
  stake: number | null
  note: string
  /** Free-text tags; empty string means "not tagged". */
  sport: string
  book: string
  betType: string
  createdAt: string
  updatedAt: string
}

export interface EntryInput {
  date: string
  amount: number
  stake?: number | null
  note?: string
  sport?: string
  book?: string
  betType?: string
}

/** An entry whose stake is known — the subset ROI can be computed over. */
export type StakedEntry = BetEntry & { stake: number }

export const hasStake = (e: BetEntry): e is StakedEntry => e.stake !== null

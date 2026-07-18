export interface BetEntry {
  id: string
  /** Local calendar date, YYYY-MM-DD. Unique per user — one entry per day. */
  date: string
  /** Net result in dollars: > 0 win, < 0 loss, 0 push (break-even). */
  amount: number
  note: string
  createdAt: string
  updatedAt: string
}

export interface EntryInput {
  date: string
  amount: number
  note?: string
}

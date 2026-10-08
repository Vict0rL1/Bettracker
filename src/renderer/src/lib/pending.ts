import type { Bet } from '../../../shared/types'

export interface OpenBet {
  bet: Bet
  /** The date has passed and the bet still has no result — it probably needs settling. */
  past: boolean
}

const byDateThenLogged = (a: Bet, b: Bet): number => {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return 0
}

/** The bets still waiting for a result, oldest first, flagged when their date is behind `today` (YYYY-MM-DD). */
export function openBets(bets: readonly Bet[], today: string): OpenBet[] {
  return bets
    .filter((b) => b.status === 'pending')
    .sort(byDateThenLogged)
    .map((bet) => ({ bet, past: bet.date < today }))
}

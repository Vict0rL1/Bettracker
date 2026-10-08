import type { Bet, Settings } from '../../../shared/types'

/** What the quick-add form opens with. */
export interface QuickDefaults {
  stake: number | null
  sport: string
  book: string
  betType: string
}

/** The bet logged most recently — by when it was logged, not its date. */
export function lastLogged(bets: readonly Bet[]): Bet | null {
  let last: Bet | null = null
  for (const b of bets) if (last === null || b.createdAt > last.createdAt) last = b
  return last
}

/**
 * Prefill for the quick-add form: the default stake from settings (or, failing
 * that, whatever the last bet staked), and the last bet's tags — most people
 * log a run of bets on the same sport at the same book. Odds are never
 * prefilled: a stale price is worse than an empty box.
 */
export function quickDefaults(bets: readonly Bet[], settings: Settings): QuickDefaults {
  const last = lastLogged(bets)
  return {
    stake: settings.defaultStake ?? last?.stake ?? null,
    sport: last?.sport ?? '',
    book: last?.book ?? '',
    betType: last?.betType ?? ''
  }
}

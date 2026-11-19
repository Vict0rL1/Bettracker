import type { Bet, Settings } from '../../../shared/types'
import { canonicalGame, DEFAULT_CASINO_SITE, isCasinoBet, kindOf, type QuickKind } from './casino'

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
 *
 * "The last bet" is the last sports bet: a casino play logged in between
 * neither makes the next bet's sport "Casino" nor its stake what was wagered.
 */
export function quickDefaults(bets: readonly Bet[], settings: Settings): QuickDefaults {
  const last = lastLogged(bets.filter((b) => !isCasinoBet(b)))
  return {
    stake: settings.defaultStake ?? last?.stake ?? null,
    sport: last?.sport ?? '',
    book: last?.book ?? '',
    betType: last?.betType ?? ''
  }
}

/** The side the quick add opens on: the kind of the bet logged last (sports with none). */
export function quickKind(bets: readonly Bet[]): QuickKind {
  const last = lastLogged(bets)
  return last === null ? 'sports' : kindOf(last)
}

/** What the casino side opens with. */
export interface CasinoDefaults {
  /** The last play's game ('' with none). */
  game: string
  /** The last play's site, else Stake. */
  site: string
}

/** Prefill for the casino side: the last casino play's game and site. */
export function casinoDefaults(bets: readonly Bet[]): CasinoDefaults {
  const last = lastLogged(bets.filter(isCasinoBet))
  return { game: canonicalGame(last?.betType ?? ''), site: last?.book || DEFAULT_CASINO_SITE }
}

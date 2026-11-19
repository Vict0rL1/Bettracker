import type { Bet, BetInput } from '../../../shared/types'
import { moneyOf, resultProblem, type Problem } from './betForm'
import { MAX_AMOUNT, round2 } from './validate'

/**
 * Casino plays (Stake's Dice, Limbo, Mines …) next to the sports bets. No
 * migration: a play is an ordinary bet whose sport is "Casino", whose bet
 * type is the game and whose book is the site. It has no odds; its result is
 * what it won or lost, net (the bets' `amount`), and its stake is what was
 * wagered, when typed (null otherwise, so it stays out of ROI, as any bet
 * without a stake does).
 */

/** The sport a casino play is tagged with. */
export const CASINO_SPORT = 'Casino'

/** The site a first casino play is logged at. */
export const DEFAULT_CASINO_SITE = 'Stake'

/** The games offered a tap away, Stake's common ones. Anything else is typed. */
export const CASINO_GAMES = ['Dice', 'Limbo', 'Mines', 'Plinko', 'Crash', 'Keno', 'HiLo', 'Blackjack', 'Roulette', 'Slots'] as const

/** Which side of the quick add: a sports bet or a casino play. */
export type QuickKind = 'sports' | 'casino'

/** True for the casino's sport, however it was typed ("casino", " Casino "): a bet tagged so before counts. */
export const isCasino = (sport: string): boolean => sport.trim().toLowerCase() === 'casino'

export const isCasinoBet = (b: Pick<Bet, 'sport'>): boolean => isCasino(b.sport)

export const kindOf = (b: Pick<Bet, 'sport'>): QuickKind => (isCasinoBet(b) ? 'casino' : 'sports')

/** A game's name compared loosely: no case, spaces, dashes or dots ("Hi-Lo" is HiLo). */
const loose = (s: string): string => s.toLowerCase().replace(/[\s\-_.]+/g, '')

/**
 * A game as typed, tidied: whitespace collapsed, and one of the games offered
 * spelled as offered ("limbo" is "Limbo", "hi-lo" "HiLo"), so the breakdown
 * by type does not split one game in two. Anything else keeps its spelling.
 */
export function canonicalGame(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean === '') return ''
  return CASINO_GAMES.find((g) => loose(g) === loose(clean)) ?? clean
}

/**
 * A bet's tags in reading order: "NBA · DraftKings · Spread" for a sports bet,
 * "Casino · Limbo · Stake" for a casino play (the game before the site, so it
 * reads as what was played; "Casino" however it was typed, as the breakdown
 * says it). Empty tags are left out.
 */
export function betTags(b: Pick<Bet, 'sport' | 'book' | 'betType'>): string[] {
  const tags = isCasinoBet(b) ? [CASINO_SPORT, b.betType, b.book] : [b.sport, b.book, b.betType]
  return tags.filter(Boolean)
}

/** The casino side of the quick add, as typed. */
export interface CasinoFields {
  game: string
  /** What was won or lost, net: more than 0; the button gives the sign. */
  amount: string
  site: string
  /** What was wagered: optional. */
  wagered: string
}

/** The wagered box: empty is fine (not recorded); anything typed is more than 0. */
export function wageredProblem(text: string): Problem | null {
  const n = moneyOf(text)
  if (n === null) return null
  if (!Number.isFinite(n) || round2(n) <= 0) return { key: 'field.wageredInvalid' }
  if (n > MAX_AMOUNT) return { key: 'field.tooBig' }
  return null
}

/**
 * The amount box for a result: more than 0 once rounded to cents, and, for a
 * loss with a wager typed, no more than the wager (a play can't lose more
 * than was put on it).
 */
export function casinoAmountProblem(c: Pick<CasinoFields, 'amount' | 'wagered'>, result: 'won' | 'lost' | null): Problem | null {
  const basic = resultProblem(c.amount)
  if (basic !== null || result !== 'lost' || wageredProblem(c.wagered) !== null) return basic
  const wagered = moneyOf(c.wagered)
  const amount = moneyOf(c.amount)
  if (wagered !== null && amount !== null && round2(amount) > round2(wagered)) return { key: 'field.lossOverWagered' }
  return null
}

/**
 * A casino play as the bet the app stores: sport Casino, the game as its type,
 * the site as its book, no odds, what was wagered as its stake (null when not
 * typed) and the net result signed by the button tapped. The boxes are
 * checked first (wageredProblem, casinoAmountProblem).
 */
export function casinoInput(date: string, c: CasinoFields, result: 'won' | 'lost'): BetInput {
  const amount = round2(moneyOf(c.amount) ?? 0)
  const wagered = moneyOf(c.wagered)
  return {
    date,
    status: result,
    amount: result === 'won' ? amount : -amount,
    stake: wagered === null ? null : round2(wagered),
    odds: null,
    closingOdds: null,
    note: '',
    sport: CASINO_SPORT,
    book: c.site,
    betType: canonicalGame(c.game)
  }
}

/** The casino plays' values of a tag, as typed, sorted: the quick add's suggestions. */
export function casinoValues(bets: readonly Bet[], key: 'betType' | 'book'): string[] {
  const seen = new Set<string>()
  for (const b of bets) if (isCasinoBet(b) && b[key]) seen.add(b[key])
  return [...seen].sort((a, z) => a.localeCompare(z))
}

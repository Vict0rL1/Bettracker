import { describe, expect, it } from 'vitest'
import { bet } from '../test-utils'
import {
  betTags,
  CASINO_GAMES,
  CASINO_SPORT,
  canonicalGame,
  casinoAmountProblem,
  casinoInput,
  casinoValues,
  isCasino,
  isCasinoBet,
  kindOf,
  wageredProblem,
  type CasinoFields
} from './casino'
import { normalizeInput } from './validate'

describe('isCasino', () => {
  it('is the casino’s sport however it was typed, and nothing else', () => {
    expect(isCasino(CASINO_SPORT)).toBe(true)
    expect(isCasino('casino')).toBe(true)
    expect(isCasino('  CASINO ')).toBe(true)
    expect(isCasino('Casinos')).toBe(false)
    expect(isCasino('NBA')).toBe(false)
    expect(isCasino('')).toBe(false)
    expect(isCasinoBet(bet({ sport: 'casino' }))).toBe(true)
    expect(kindOf(bet({ sport: 'Casino' }))).toBe('casino')
    expect(kindOf(bet({ sport: 'NFL' }))).toBe('sports')
    expect(kindOf(bet({ sport: '' }))).toBe('sports')
  })
})

describe('canonicalGame', () => {
  it('spells an offered game as offered, loosely matched', () => {
    expect(canonicalGame('limbo')).toBe('Limbo')
    expect(canonicalGame('  DICE ')).toBe('Dice')
    expect(canonicalGame('hi-lo')).toBe('HiLo')
    expect(canonicalGame('Hi Lo')).toBe('HiLo')
    expect(canonicalGame('black jack')).toBe('Blackjack')
  })

  it('keeps anything else as typed, whitespace tidied', () => {
    expect(canonicalGame('  Wheel   of  Fortune ')).toBe('Wheel of Fortune')
    expect(canonicalGame('Baccarat')).toBe('Baccarat')
    expect(canonicalGame('   ')).toBe('')
  })

  it('offers Stake’s common games', () => {
    expect([...CASINO_GAMES]).toEqual(['Dice', 'Limbo', 'Mines', 'Plinko', 'Crash', 'Keno', 'HiLo', 'Blackjack', 'Roulette', 'Slots'])
  })
})

describe('betTags', () => {
  it('reads a sports bet as sport · book · type and a casino play as Casino · game · site', () => {
    expect(betTags(bet({ sport: 'NBA', book: 'DK', betType: 'Spread' }))).toEqual(['NBA', 'DK', 'Spread'])
    expect(betTags(bet({ sport: 'Casino', book: 'Stake', betType: 'Limbo' }))).toEqual(['Casino', 'Limbo', 'Stake'])
    // Tagged "casino" by hand: it reads as the breakdown has it.
    expect(betTags(bet({ sport: ' casino', book: '', betType: 'Dice' }))).toEqual(['Casino', 'Dice'])
    expect(betTags(bet({ sport: '', book: 'FD', betType: '' }))).toEqual(['FD'])
  })
})

describe('the casino boxes', () => {
  const fields = (over: Partial<CasinoFields> = {}): CasinoFields => ({ game: 'Limbo', amount: '25', site: 'Stake', wagered: '', ...over })

  it('the wager is optional, and anything typed is more than 0', () => {
    expect(wageredProblem('')).toBeNull()
    expect(wageredProblem('  ')).toBeNull()
    expect(wageredProblem('10')).toBeNull()
    expect(wageredProblem('0')).toEqual({ key: 'field.wageredInvalid' })
    expect(wageredProblem('0.001')).toEqual({ key: 'field.wageredInvalid' })
    expect(wageredProblem('-5')).toEqual({ key: 'field.wageredInvalid' })
    expect(wageredProblem('abc')).toEqual({ key: 'field.wageredInvalid' })
    expect(wageredProblem('200000000')).toEqual({ key: 'field.tooBig' })
  })

  it('the amount is more than 0, and a loss is no more than the wager', () => {
    expect(casinoAmountProblem(fields({ amount: '' }), null)).toEqual({ key: 'field.resultRequired' })
    expect(casinoAmountProblem(fields({ amount: '0.004' }), 'won')).toEqual({ key: 'field.resultRoundsZero' })
    expect(casinoAmountProblem(fields({ amount: '-3' }), 'lost')).toEqual({ key: 'field.resultInvalid' })
    expect(casinoAmountProblem(fields({ amount: '30', wagered: '20' }), 'lost')).toEqual({ key: 'field.lossOverWagered' })
    // A win can be any size; a loss of exactly the wager is the whole wager.
    expect(casinoAmountProblem(fields({ amount: '30', wagered: '20' }), 'won')).toBeNull()
    expect(casinoAmountProblem(fields({ amount: '20', wagered: '20' }), 'lost')).toBeNull()
    expect(casinoAmountProblem(fields({ amount: '30' }), 'lost')).toBeNull()
    // Before a result is tapped there is no loss to compare; a bad wager is its own box's problem.
    expect(casinoAmountProblem(fields({ amount: '30', wagered: '20' }), null)).toBeNull()
    expect(casinoAmountProblem(fields({ amount: '30', wagered: '0' }), 'lost')).toBeNull()
  })
})

describe('casinoInput', () => {
  it('is a bet with sport Casino, the game as its type, the site as its book, no odds, signed by the result', () => {
    const won = casinoInput('2026-11-19', { game: 'limbo', amount: '25.5', site: 'Stake', wagered: '' }, 'won')
    expect(won).toEqual({
      date: '2026-11-19',
      status: 'won',
      amount: 25.5,
      stake: null,
      odds: null,
      closingOdds: null,
      note: '',
      sport: 'Casino',
      book: 'Stake',
      betType: 'Limbo'
    })
    const lost = casinoInput('2026-11-19', { game: 'Plinko', amount: '12.345', site: 'Roobet', wagered: '40' }, 'lost')
    expect(lost).toMatchObject({ status: 'lost', amount: -12.35, stake: 40, betType: 'Plinko', book: 'Roobet', sport: 'Casino' })
  })

  it('is stored as it is: the writer’s checks agree', () => {
    for (const result of ['won', 'lost'] as const) {
      const input = casinoInput('2026-11-19', { game: 'Mines', amount: '7', site: ' Stake ', wagered: '10' }, result)
      expect(normalizeInput(input)).toMatchObject({ status: result, amount: result === 'won' ? 7 : -7, stake: 10, odds: null, closingOdds: null, sport: 'Casino', book: 'Stake', betType: 'Mines' })
    }
    // No game: still a casino play.
    expect(normalizeInput(casinoInput('2026-11-19', { game: '', amount: '5', site: '', wagered: '' }, 'lost'))).toMatchObject({ sport: 'Casino', betType: '', book: '', amount: -5, stake: null })
  })
})

describe('casinoValues', () => {
  it('lists the games or sites of the casino plays only', () => {
    const bets = [
      bet({ sport: 'Casino', betType: 'Limbo', book: 'Stake' }),
      bet({ sport: 'casino', betType: 'Wheel', book: 'Roobet' }),
      bet({ sport: 'Casino', betType: 'Limbo', book: '' }),
      bet({ sport: 'NBA', betType: 'Spread', book: 'DK' })
    ]
    expect(casinoValues(bets, 'betType')).toEqual(['Limbo', 'Wheel'])
    expect(casinoValues(bets, 'book')).toEqual(['Roobet', 'Stake'])
  })
})

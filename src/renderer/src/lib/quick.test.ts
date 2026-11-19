import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../shared/types'
import { bet } from '../test-utils'
import { casinoDefaults, lastLogged, quickDefaults, quickKind } from './quick'

describe('lastLogged', () => {
  it('picks the most recently logged bet, whatever its date', () => {
    const bets = [
      bet({ id: 'old-date-new-log', date: '2026-01-01', createdAt: '2026-03-01T10:00:00Z' }),
      bet({ id: 'new-date-old-log', date: '2026-03-01', createdAt: '2026-02-01T10:00:00Z' })
    ]
    expect(lastLogged(bets)?.id).toBe('old-date-new-log')
    expect(lastLogged([])).toBeNull()
  })
})

describe('quickDefaults', () => {
  const last = bet({ stake: 40, sport: 'NBA', book: 'DK', betType: 'Spread', createdAt: '2026-03-01T10:00:00Z' })
  const earlier = bet({ stake: 10, sport: 'NFL', book: 'FD', betType: 'Parlay', createdAt: '2026-02-01T10:00:00Z' })

  it('takes the tags from the last bet and the stake from settings', () => {
    expect(quickDefaults([earlier, last], { ...DEFAULT_SETTINGS, defaultStake: 25 })).toEqual({
      stake: 25,
      sport: 'NBA',
      book: 'DK',
      betType: 'Spread'
    })
  })

  it('falls back to the last stake when no default is set', () => {
    expect(quickDefaults([earlier, last], DEFAULT_SETTINGS).stake).toBe(40)
  })

  it('is empty with no history and no settings', () => {
    expect(quickDefaults([], DEFAULT_SETTINGS)).toEqual({ stake: null, sport: '', book: '', betType: '' })
  })
})

describe('casino plays and the quick add', () => {
  const sports = bet({ stake: 40, sport: 'NBA', book: 'DK', betType: 'Spread', createdAt: '2026-03-01T10:00:00Z' })
  const play = bet({ amount: 25, stake: 100, sport: 'Casino', book: 'Roobet', betType: 'Limbo', createdAt: '2026-03-02T10:00:00Z' })

  it('the sports side’s tags and stake come from the last sports bet, whatever casino play came after', () => {
    expect(quickDefaults([sports, play], DEFAULT_SETTINGS)).toEqual({ stake: 40, sport: 'NBA', book: 'DK', betType: 'Spread' })
    // A play tagged "casino" by hand counts as one too.
    expect(quickDefaults([sports, { ...play, sport: ' casino ' }], DEFAULT_SETTINGS).sport).toBe('NBA')
    expect(quickDefaults([play], DEFAULT_SETTINGS)).toEqual({ stake: null, sport: '', book: '', betType: '' })
  })

  it('opens on the kind of the bet logged last', () => {
    expect(quickKind([])).toBe('sports')
    expect(quickKind([sports, play])).toBe('casino')
    expect(quickKind([play, { ...sports, createdAt: '2026-03-03T10:00:00Z' }])).toBe('sports')
  })

  it('the casino side opens on the last play’s game and site, else Stake and no game', () => {
    expect(casinoDefaults([sports, play])).toEqual({ game: 'Limbo', site: 'Roobet' })
    expect(casinoDefaults([sports])).toEqual({ game: '', site: 'Stake' })
    // The last play's game, spelled as offered; a play without a site falls back to Stake.
    expect(casinoDefaults([play, bet({ sport: 'casino', betType: 'dice', book: '', createdAt: '2026-03-04T10:00:00Z' })])).toEqual({ game: 'Dice', site: 'Stake' })
  })
})

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../shared/types'
import { bet } from '../test-utils'
import { lastLogged, quickDefaults } from './quick'

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

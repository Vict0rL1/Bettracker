import { describe, expect, it } from 'vitest'
import { bet } from '../test-utils'
import { bandBounds, bandOf, bandRangeText, ODDS_BANDS } from './bands'
import { breakdown } from './stats'

describe('odds bands', () => {
  it('places a price in its band, upper bound inclusive', () => {
    expect(bandOf(1.4)).toBe('heavyFav')
    expect(bandOf(1.5)).toBe('heavyFav')
    expect(bandOf(1.51)).toBe('fav')
    expect(bandOf(1.9)).toBe('fav')
    expect(bandOf(1.9091)).toBe('even')
    expect(bandOf(2.1)).toBe('even')
    expect(bandOf(2.5)).toBe('dog')
    expect(bandOf(3.5)).toBe('dog')
    expect(bandOf(3.51)).toBe('longshot')
    expect(bandOf(50)).toBe('longshot')
    expect(bandOf(null)).toBeNull()
  })

  it('has strictly rising bounds ending open', () => {
    for (let i = 1; i < ODDS_BANDS.length; i++) expect(ODDS_BANDS[i].max).toBeGreaterThan(ODDS_BANDS[i - 1].max)
    expect(ODDS_BANDS[ODDS_BANDS.length - 1].max).toBe(Infinity)
    expect(bandBounds('fav')).toEqual({ lo: 1.5, hi: 1.9 })
    expect(bandBounds('heavyFav')).toEqual({ lo: 1, hi: 1.5 })
  })

  it('describes the edges in the chosen format', () => {
    expect(bandRangeText('heavyFav', 'american')).toBe('≤ -200')
    expect(bandRangeText('fav', 'american')).toBe('-200 – -111')
    expect(bandRangeText('even', 'decimal')).toBe('1.90 – 2.10')
    expect(bandRangeText('longshot', 'american')).toBe('> +250')
    expect(bandRangeText('dog', 'fractional')).toBe('11/10 – 5/2')
  })
})

describe('breakdown by odds, weekday and month', () => {
  const bets = [
    bet({ date: '2026-08-01', amount: 150, stake: 100, odds: 2.5 }), // Saturday, underdog
    bet({ date: '2026-08-02', amount: -100, stake: 100, odds: 1.9091 }), // Sunday, even
    bet({ date: '2026-08-03', amount: -50, stake: 50, odds: 1.4 }), // Monday, heavy favorite
    bet({ date: '2026-09-05', amount: 20, stake: 20 }) // Saturday, no odds
  ]

  it('groups by band in band order and leaves bets without odds out', () => {
    const rows = breakdown(bets, 'odds')
    expect(rows.map((r) => [r.label, r.profit])).toEqual([
      ['heavyFav', -50],
      ['even', -100],
      ['dog', 150]
    ])
    expect(rows[2].roi).toBeCloseTo(150)
  })

  it('groups by weekday, Sunday first', () => {
    const rows = breakdown(bets, 'weekday')
    expect(rows.map((r) => [r.label, r.profit, r.bets])).toEqual([
      ['0', -100, 1],
      ['1', -50, 1],
      ['6', 170, 2]
    ])
  })

  it('groups by month, oldest first', () => {
    const rows = breakdown(bets, 'month')
    expect(rows.map((r) => [r.label, r.profit])).toEqual([
      ['2026-08', 0],
      ['2026-09', 20]
    ])
  })

  it('still sorts tags by profit', () => {
    const rows = breakdown([bet({ amount: 1, sport: 'A' }), bet({ amount: 5, sport: 'B' })], 'sport')
    expect(rows.map((r) => r.label)).toEqual(['B', 'A'])
  })
})

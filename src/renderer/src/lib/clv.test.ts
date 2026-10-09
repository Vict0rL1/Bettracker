import { describe, expect, it } from 'vitest'
import { bet } from '../test-utils'
import { averageClv, breakdown, clvOf, summarize } from './stats'

describe('clvOf', () => {
  it('is the price taken over the closing price, minus one, as a percentage', () => {
    expect(clvOf(2.5, 2.2)).toBeCloseTo(13.636, 2)
    expect(clvOf(1.9091, 1.9091)).toBe(0)
    expect(clvOf(2, 2.2)).toBeCloseTo(-9.091, 2)
  })
})

describe('averageClv', () => {
  const bets = [
    bet({ amount: 150, stake: 100, odds: 2.5, closingOdds: 2.2 }), // +13.6%
    bet({ amount: -100, stake: 100, odds: 1.9091, closingOdds: 1.9091 }), // 0
    bet({ status: 'pending', stake: 50, odds: 2, closingOdds: 2.2 }), // −9.1%, result unknown — still counts
    bet({ amount: 90, stake: 100, odds: 1.9 }), // no close
    bet({ amount: -20, stake: 20, closingOdds: 1.8 }) // no price taken
  ]

  it('averages the bets with both prices, whatever their result, and counts the ones that beat the close', () => {
    const r = averageClv(bets)
    expect(r?.n).toBe(3)
    expect(r?.beat).toBe(1)
    expect(r?.avg).toBeCloseTo((13.636 + 0 - 9.091) / 3, 2)
  })

  it('is null without a single closing price', () => {
    expect(averageClv([bet({ amount: 1, odds: 2 })])).toBeNull()
  })

  it('reaches the summary and the breakdown', () => {
    expect(summarize(bets).clv?.n).toBe(3)
    const rows = breakdown(
      [bet({ amount: 150, stake: 100, odds: 2.5, closingOdds: 2.2, sport: 'NBA' }), bet({ amount: -10, stake: 10, odds: 2, sport: 'NBA' })],
      'sport'
    )
    expect(rows[0].clv).toBeCloseTo(13.636, 2)
    expect(rows[0].clvBets).toBe(1)
    expect(breakdown([bet({ amount: 1, sport: 'NFL' })], 'sport')[0].clv).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { bet } from '../test-utils'
import {
  averageImplied,
  averageStake,
  betWinLoss,
  bonusProfit,
  breakdown,
  cumulativeSeries,
  currentStreak,
  dayWinLoss,
  extremeDays,
  forMonth,
  groupByDay,
  isSmallSample,
  maxDrawdown,
  riskedOf,
  roi,
  SMALL_SAMPLE,
  strikeRate,
  summarize,
  tagValues,
  total
} from './stats'

describe('total', () => {
  it('sums amounts without float drift', () => {
    expect(total([bet({ amount: 0.1 }), bet({ amount: 0.2 })])).toBe(0.3)
  })

  it('is 0 for no bets, and ignores pending ones', () => {
    expect(total([])).toBe(0)
    expect(total([bet({ amount: 50 }), bet({ status: 'pending', stake: 100 })])).toBe(50)
  })
})

describe('groupByDay', () => {
  it('collapses several bets into one day, ascending', () => {
    const days = groupByDay([
      bet({ date: '2026-03-02', amount: 50 }),
      bet({ date: '2026-03-01', amount: -20 }),
      bet({ date: '2026-03-01', amount: 70 })
    ])
    expect(days.map((d) => d.date)).toEqual(['2026-03-01', '2026-03-02'])
    expect(days[0].total).toBe(50)
    expect(days[0].count).toBe(2)
    expect(days[0].scored).toBe(2)
    expect(days[1].total).toBe(50)
  })

  it('counts pending and void bets but keeps them out of the day’s score', () => {
    const [day] = groupByDay([
      bet({ date: '2026-03-01', amount: 10 }),
      bet({ date: '2026-03-01', status: 'pending', stake: 5 }),
      bet({ date: '2026-03-01', status: 'void', stake: 5 })
    ])
    expect(day.count).toBe(3)
    expect(day.scored).toBe(1)
    expect(day.pending).toBe(1)
    expect(day.total).toBe(10)
  })

  it('orders a day’s bets by when they were logged', () => {
    const days = groupByDay([
      bet({ id: 'late', date: '2026-03-01', amount: 1, createdAt: '2026-03-01T20:00:00Z' }),
      bet({ id: 'early', date: '2026-03-01', amount: 2, createdAt: '2026-03-01T08:00:00Z' })
    ])
    expect(days[0].bets.map((b) => b.id)).toEqual(['early', 'late'])
  })
})

describe('win/loss counting', () => {
  const bets = [
    bet({ date: '2026-01-01', amount: 100 }),
    bet({ date: '2026-01-02', amount: -60 }),
    bet({ date: '2026-01-02', amount: 10 }),
    bet({ date: '2026-01-03', amount: 0 }),
    bet({ date: '2026-01-04', status: 'pending', stake: 10 }),
    bet({ date: '2026-01-05', status: 'void', stake: 10 })
  ]

  it('counts days by their net total, skipping days with nothing scored', () => {
    // Jan 2 nets -50, so it is one red day even though it holds a winning bet.
    // Jan 4 (pending) and Jan 5 (void) are not pushes; they are not in the record.
    expect(dayWinLoss(groupByDay(bets))).toEqual({ wins: 1, losses: 1, pushes: 1 })
  })

  it('counts bets by status, leaving pending and void out', () => {
    expect(betWinLoss(bets)).toEqual({ wins: 2, losses: 1, pushes: 1 })
  })

  it('ignores pushes in the strike rate', () => {
    expect(strikeRate({ wins: 3, losses: 1, pushes: 9 })).toBe(75)
  })

  it('has no strike rate before anything decisive', () => {
    expect(strikeRate({ wins: 0, losses: 0, pushes: 4 })).toBeNull()
  })
})

describe('riskedOf', () => {
  it('is the stake on a won or lost bet and 0 otherwise', () => {
    expect(riskedOf(bet({ amount: 5, stake: 10 }))).toBe(10)
    expect(riskedOf(bet({ amount: -10, stake: 10 }))).toBe(10)
    expect(riskedOf(bet({ amount: 0, stake: 10 }))).toBe(0)
    expect(riskedOf(bet({ status: 'void', stake: 10 }))).toBe(0)
    expect(riskedOf(bet({ status: 'pending', stake: 10 }))).toBe(0)
    expect(riskedOf(bet({ amount: 5 }))).toBe(0)
  })
})

describe('roi', () => {
  it('divides profit by the amount staked', () => {
    const r = roi([bet({ amount: 50, stake: 100 }), bet({ amount: -100, stake: 100 })])
    expect(r).not.toBeNull()
    expect(r?.pct).toBeCloseTo(-25)
    expect(r?.staked).toBe(200)
    expect(r?.profit).toBe(-50)
    expect(r?.counted).toBe(2)
    expect(r?.missing).toBe(0)
  })

  it('excludes bets with no recorded stake, and reports how many', () => {
    const r = roi([bet({ amount: 50, stake: 100 }), bet({ amount: 900 })])
    // The 900 win is left out entirely: counting it would invent a stake.
    expect(r?.pct).toBeCloseTo(50)
    expect(r?.profit).toBe(50)
    expect(r?.counted).toBe(1)
    expect(r?.missing).toBe(1)
  })

  it('does not count a missing stake on a push or void as missing', () => {
    expect(roi([bet({ amount: 10, stake: 10 }), bet({ amount: 0 }), bet({ status: 'void' })])?.missing).toBe(0)
  })

  it('leaves pushes and voids out of the denominator', () => {
    const r = roi([bet({ amount: 10, stake: 100 }), bet({ amount: 0, stake: 100 }), bet({ status: 'void', stake: 100 })])
    expect(r?.staked).toBe(100)
    expect(r?.pct).toBeCloseTo(10)
    expect(r?.counted).toBe(1)
  })

  it('leaves free bets out entirely, rather than letting them inflate it', () => {
    const r = roi([bet({ amount: 10, stake: 100 }), bet({ amount: 200, stake: 0 })])
    expect(r?.pct).toBeCloseTo(10)
    expect(r?.counted).toBe(1)
  })

  it('ignores pending bets', () => {
    expect(roi([bet({ amount: 10, stake: 100 }), bet({ status: 'pending', stake: 500 })])?.staked).toBe(100)
  })

  it('is null when nothing has a stake', () => {
    expect(roi([bet({ amount: 10 }), bet({ amount: -10 })])).toBeNull()
  })

  it('is null rather than infinite when every stake is zero', () => {
    expect(roi([bet({ amount: 25, stake: 0 })])).toBeNull()
  })

  it('is null for no bets at all', () => {
    expect(roi([])).toBeNull()
  })

  it('reports a profit that can disagree with the all-in total', () => {
    // This is the case the UI has to explain: overall green, staked bets red.
    const bets = [bet({ amount: 500 }), bet({ amount: -100, stake: 100 })]
    expect(total(bets)).toBe(400)
    expect(roi(bets)?.profit).toBe(-100)
  })
})

describe('bonusProfit', () => {
  it('sums what free bets returned, won or lost', () => {
    const b = bonusProfit([bet({ amount: 200, stake: 0 }), bet({ amount: -0.01, stake: 0 }), bet({ amount: 50, stake: 10 })])
    expect(b.profit).toBe(199.99)
    expect(b.count).toBe(2)
  })

  it('does not count a free bet that pushed, or an unstaked bet', () => {
    expect(bonusProfit([bet({ amount: 0, stake: 0 }), bet({ amount: 30 })])).toEqual({ profit: 0, count: 0 })
  })
})

describe('averageStake', () => {
  it('averages only the bets that recorded one', () => {
    expect(averageStake([bet({ stake: 100 }), bet({ stake: 50 }), bet({})])).toBe(75)
  })

  it('is null when no stake was ever recorded', () => {
    expect(averageStake([bet({}), bet({})])).toBeNull()
  })
})

describe('averageImplied', () => {
  it('averages 1/odds over decided bets with odds', () => {
    const r = averageImplied([bet({ amount: 1, odds: 2 }), bet({ amount: -1, odds: 4 }), bet({ amount: 1 }), bet({ status: 'pending', odds: 1.5 })])
    expect(r?.n).toBe(2)
    expect(r?.avg).toBeCloseTo(37.5)
  })

  it('is null without odds', () => {
    expect(averageImplied([bet({ amount: 1 })])).toBeNull()
  })
})

describe('isSmallSample', () => {
  it('flags anything under the threshold', () => {
    expect(isSmallSample(SMALL_SAMPLE - 1)).toBe(true)
    expect(isSmallSample(SMALL_SAMPLE)).toBe(false)
  })
})

describe('currentStreak', () => {
  const days = (...totals: number[]) =>
    groupByDay(totals.map((amount, i) => bet({ date: `2026-02-${String(i + 1).padStart(2, '0')}`, amount })))

  it('counts back from the most recent decisive day', () => {
    expect(currentStreak(days(-10, 20, 30))).toEqual({ kind: 'W', count: 2 })
  })

  it('skips break-even days without breaking the run', () => {
    expect(currentStreak(days(-5, -8, 0, -3))).toEqual({ kind: 'L', count: 3 })
  })

  it('skips a day with only pending bets', () => {
    const d = groupByDay([bet({ date: '2026-02-01', amount: 5 }), bet({ date: '2026-02-02', status: 'pending' })])
    expect(currentStreak(d)).toEqual({ kind: 'W', count: 1 })
  })

  it('stops at the first day of the other colour', () => {
    expect(currentStreak(days(50, 60, -1))).toEqual({ kind: 'L', count: 1 })
  })

  it('is null when every day broke even', () => {
    expect(currentStreak(days(0, 0))).toBeNull()
  })

  it('is null with no days', () => {
    expect(currentStreak([])).toBeNull()
  })
})

describe('cumulativeSeries and drawdown', () => {
  const days = groupByDay([
    bet({ date: '2026-01-01', amount: 100 }),
    bet({ date: '2026-01-02', amount: -30 }),
    bet({ date: '2026-01-03', amount: -50 }),
    bet({ date: '2026-01-04', amount: 200 })
  ])

  it('accumulates one point per day', () => {
    expect(cumulativeSeries(days).map((p) => p.balance)).toEqual([100, 70, 20, 220])
  })

  it('draws no point for a day with only pending bets', () => {
    const d = groupByDay([bet({ date: '2026-01-01', amount: 10 }), bet({ date: '2026-01-02', status: 'pending' })])
    expect(cumulativeSeries(d).map((p) => p.date)).toEqual(['2026-01-01'])
  })

  it('measures the deepest fall from a peak', () => {
    expect(maxDrawdown(cumulativeSeries(days))).toBe(80)
  })

  it('is 0 when the curve never falls', () => {
    expect(maxDrawdown(cumulativeSeries(groupByDay([bet({ amount: 10 })])))).toBe(0)
  })

  it('measures a fall below zero from the starting point', () => {
    const down = groupByDay([bet({ date: '2026-01-01', amount: -40 })])
    expect(maxDrawdown(cumulativeSeries(down))).toBe(40)
  })
})

describe('extremeDays', () => {
  it('finds the best and worst day in one pass', () => {
    const days = groupByDay([
      bet({ date: '2026-01-01', amount: 30 }),
      bet({ date: '2026-01-02', amount: -80 }),
      bet({ date: '2026-01-03', amount: 90 })
    ])
    const { best, worst } = extremeDays(days)
    expect(best?.date).toBe('2026-01-03')
    expect(worst?.date).toBe('2026-01-02')
  })

  it('leaves a side null when no such day exists', () => {
    const { best, worst } = extremeDays(groupByDay([bet({ amount: 5 })]))
    expect(best?.total).toBe(5)
    expect(worst).toBeNull()
  })
})

describe('forMonth', () => {
  it('keeps only the selected month, not a prefix collision', () => {
    const bets = [bet({ date: '2026-01-31' }), bet({ date: '2026-02-01' }), bet({ date: '2026-12-01' }), bet({ date: '2027-01-01' })]
    expect(forMonth(bets, { year: 2026, month: 0 }).map((b) => b.date)).toEqual(['2026-01-31'])
    expect(forMonth(bets, { year: 2026, month: 11 }).map((b) => b.date)).toEqual(['2026-12-01'])
  })
})

describe('breakdown', () => {
  const bets = [
    bet({ amount: 100, stake: 50, sport: 'NBA', book: 'DK' }),
    bet({ amount: -50, stake: 50, sport: 'NBA', book: 'FD' }),
    bet({ amount: -20, stake: 20, sport: 'NFL', book: 'DK' }),
    bet({ status: 'pending', stake: 20, sport: 'NFL' }),
    bet({ amount: 300, sport: '' })
  ]

  it('groups by tag, most profitable first, counting pending bets apart', () => {
    const rows = breakdown(bets, 'sport')
    expect(rows.map((r) => r.label)).toEqual(['NBA', 'NFL'])
    expect(rows[0].profit).toBe(50)
    expect(rows[0].bets).toBe(2)
    expect(rows[0].roi).toBeCloseTo(50)
    expect(rows[1].bets).toBe(1)
    expect(rows[1].pending).toBe(1)
  })

  it('leaves untagged bets out entirely', () => {
    expect(breakdown(bets, 'sport').reduce((n, r) => n + r.bets + r.pending, 0)).toBe(4)
  })

  it('reports how many bets the ROI actually covers', () => {
    const mixed = breakdown([bet({ amount: 90, sport: 'NBA' }), bet({ amount: -10, stake: 10, sport: 'NBA' })], 'sport')
    expect(mixed[0].bets).toBe(2)
    expect(mixed[0].roiBets).toBe(1)
    expect(mixed[0].profit).toBe(80)
    expect(mixed[0].roi).toBeCloseTo(-100)
  })

  it('has a null roi for a slice with no stakes', () => {
    expect(breakdown([bet({ amount: 5, book: 'DK' })], 'book')[0].roi).toBeNull()
  })

  it('is empty when nothing carries that tag', () => {
    expect(breakdown(bets, 'betType')).toEqual([])
  })
})

describe('tagValues', () => {
  it('lists distinct non-empty values, sorted', () => {
    const bets = [bet({ sport: 'NFL' }), bet({ sport: 'NBA' }), bet({ sport: 'NFL' }), bet({ sport: '' })]
    expect(tagValues(bets, 'sport')).toEqual(['NBA', 'NFL'])
  })
})

describe('summarize', () => {
  it('matches the individual helpers it replaces', () => {
    const bets = [
      bet({ date: '2026-01-01', amount: 100, stake: 50, odds: 3 }),
      bet({ date: '2026-01-02', amount: -60, stake: 60, odds: 1.8 }),
      bet({ date: '2026-01-02', amount: 10, stake: 10 }),
      bet({ date: '2026-01-03', status: 'pending', stake: 25 }),
      bet({ date: '2026-01-04', amount: 40, stake: 0 })
    ]
    const s = summarize(bets)
    const days = groupByDay(bets)
    expect(s.total).toBe(total(bets))
    expect(s.bets).toBe(5)
    expect(s.pendingCount).toBe(1)
    expect(s.pendingStaked).toBe(25)
    expect(s.dayCount).toBe(4)
    expect(s.dayWl).toEqual(dayWinLoss(days))
    expect(s.betWl).toEqual(betWinLoss(bets))
    expect(s.strike).toBe(strikeRate(betWinLoss(bets)))
    expect(s.strikeN).toBe(4)
    expect(s.streak).toEqual(currentStreak(days))
    expect(s.roi?.pct).toBe(roi(bets)?.pct)
    expect(s.bonus).toEqual({ profit: 40, count: 1 })
    expect(s.implied?.n).toBe(2)
    expect(s.series).toEqual(cumulativeSeries(days))
    expect(s.drawdown).toBe(maxDrawdown(cumulativeSeries(days)))
    expect(s.first).toBe('2026-01-01')
  })

  it('handles an empty history without throwing', () => {
    const s = summarize([])
    expect(s).toMatchObject({ total: 0, bets: 0, pendingCount: 0, dayCount: 0, drawdown: 0, first: null, strikeN: 0 })
    expect(s.roi).toBeNull()
    expect(s.strike).toBeNull()
    expect(s.streak).toBeNull()
    expect(s.best).toBeNull()
    expect(s.worst).toBeNull()
    expect(s.implied).toBeNull()
    expect(s.bonus).toEqual({ profit: 0, count: 0 })
  })
})

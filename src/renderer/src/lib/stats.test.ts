import { describe, expect, it } from 'vitest'
import { entry } from '../test-utils'
import {
  averageStake,
  breakdown,
  cumulativeSeries,
  currentStreak,
  betWinLoss,
  dayWinLoss,
  extremeDays,
  forMonth,
  groupByDay,
  maxDrawdown,
  roi,
  strikeRate,
  summarize,
  tagValues,
  total
} from './stats'

describe('total', () => {
  it('sums amounts without float drift', () => {
    expect(total([entry({ amount: 0.1 }), entry({ amount: 0.2 })])).toBe(0.3)
  })

  it('is 0 for no entries', () => {
    expect(total([])).toBe(0)
  })
})

describe('groupByDay', () => {
  it('collapses several sessions into one day, ascending', () => {
    const days = groupByDay([
      entry({ date: '2026-03-02', amount: 50 }),
      entry({ date: '2026-03-01', amount: -20 }),
      entry({ date: '2026-03-01', amount: 70 })
    ])
    expect(days.map((d) => d.date)).toEqual(['2026-03-01', '2026-03-02'])
    expect(days[0].total).toBe(50)
    expect(days[0].count).toBe(2)
    expect(days[1].total).toBe(50)
  })

  it('orders a day’s sessions by when they were logged', () => {
    const days = groupByDay([
      entry({ id: 'late', date: '2026-03-01', amount: 1, createdAt: '2026-03-01T20:00:00Z' }),
      entry({ id: 'early', date: '2026-03-01', amount: 2, createdAt: '2026-03-01T08:00:00Z' })
    ])
    expect(days[0].entries.map((e) => e.id)).toEqual(['early', 'late'])
  })
})

describe('win/loss counting', () => {
  const entries = [
    entry({ date: '2026-01-01', amount: 100 }),
    entry({ date: '2026-01-02', amount: -60 }),
    entry({ date: '2026-01-02', amount: 10 }),
    entry({ date: '2026-01-03', amount: 0 })
  ]

  it('counts days by their net total', () => {
    // Jan 2 nets -50, so it is one red day even though it holds a winning bet.
    expect(dayWinLoss(groupByDay(entries))).toEqual({ wins: 1, losses: 1, pushes: 1 })
  })

  it('counts bets individually', () => {
    expect(betWinLoss(entries)).toEqual({ wins: 2, losses: 1, pushes: 1 })
  })

  it('ignores pushes in the strike rate', () => {
    expect(strikeRate({ wins: 3, losses: 1, pushes: 9 })).toBe(75)
  })

  it('has no strike rate before anything decisive', () => {
    expect(strikeRate({ wins: 0, losses: 0, pushes: 4 })).toBeNull()
  })
})

describe('roi', () => {
  it('divides profit by the amount staked', () => {
    const r = roi([entry({ amount: 50, stake: 100 }), entry({ amount: -100, stake: 100 })])
    expect(r).not.toBeNull()
    expect(r?.pct).toBeCloseTo(-25)
    expect(r?.staked).toBe(200)
    expect(r?.profit).toBe(-50)
    expect(r?.counted).toBe(2)
    expect(r?.missing).toBe(0)
  })

  it('excludes bets with no recorded stake, and reports how many', () => {
    const r = roi([entry({ amount: 50, stake: 100 }), entry({ amount: 900 })])
    // The 900 win is left out entirely: counting it would invent a stake.
    expect(r?.pct).toBeCloseTo(50)
    expect(r?.profit).toBe(50)
    expect(r?.counted).toBe(1)
    expect(r?.missing).toBe(1)
  })

  it('is null when nothing has a stake', () => {
    expect(roi([entry({ amount: 10 }), entry({ amount: -10 })])).toBeNull()
  })

  it('is null rather than infinite when every stake is zero', () => {
    expect(roi([entry({ amount: 25, stake: 0 })])).toBeNull()
  })

  it('is null for no entries at all', () => {
    expect(roi([])).toBeNull()
  })

  it('reports a profit that can disagree with the all-in total', () => {
    // This is the case the UI has to explain: overall green, staked bets red.
    const entries = [entry({ amount: 500 }), entry({ amount: -100, stake: 100 })]
    expect(total(entries)).toBe(400)
    expect(roi(entries)?.profit).toBe(-100)
  })
})

describe('averageStake', () => {
  it('averages only the bets that recorded one', () => {
    expect(averageStake([entry({ stake: 100 }), entry({ stake: 50 }), entry({})])).toBe(75)
  })

  it('is null when no stake was ever recorded', () => {
    expect(averageStake([entry({}), entry({})])).toBeNull()
  })
})

describe('currentStreak', () => {
  const days = (...totals: number[]) =>
    groupByDay(totals.map((amount, i) => entry({ date: `2026-02-${String(i + 1).padStart(2, '0')}`, amount })))

  it('counts back from the most recent decisive day', () => {
    expect(currentStreak(days(-10, 20, 30))).toEqual({ kind: 'W', count: 2 })
  })

  it('skips break-even days without breaking the run', () => {
    expect(currentStreak(days(-5, -8, 0, -3))).toEqual({ kind: 'L', count: 3 })
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
    entry({ date: '2026-01-01', amount: 100 }),
    entry({ date: '2026-01-02', amount: -30 }),
    entry({ date: '2026-01-03', amount: -50 }),
    entry({ date: '2026-01-04', amount: 200 })
  ])

  it('accumulates one point per day', () => {
    expect(cumulativeSeries(days).map((p) => p.balance)).toEqual([100, 70, 20, 220])
  })

  it('measures the deepest fall from a peak', () => {
    expect(maxDrawdown(cumulativeSeries(days))).toBe(80)
  })

  it('is 0 when the curve never falls', () => {
    expect(maxDrawdown(cumulativeSeries(groupByDay([entry({ amount: 10 })])))).toBe(0)
  })

  it('measures a fall below zero from the starting point', () => {
    const down = groupByDay([entry({ date: '2026-01-01', amount: -40 })])
    expect(maxDrawdown(cumulativeSeries(down))).toBe(40)
  })
})

describe('extremeDays', () => {
  it('finds the best and worst day in one pass', () => {
    const days = groupByDay([
      entry({ date: '2026-01-01', amount: 30 }),
      entry({ date: '2026-01-02', amount: -80 }),
      entry({ date: '2026-01-03', amount: 90 })
    ])
    const { best, worst } = extremeDays(days)
    expect(best?.date).toBe('2026-01-03')
    expect(worst?.date).toBe('2026-01-02')
  })

  it('leaves a side null when no such day exists', () => {
    const { best, worst } = extremeDays(groupByDay([entry({ amount: 5 })]))
    expect(best?.total).toBe(5)
    expect(worst).toBeNull()
  })
})

describe('forMonth', () => {
  it('keeps only the selected month, not a prefix collision', () => {
    const entries = [
      entry({ date: '2026-01-31' }),
      entry({ date: '2026-02-01' }),
      entry({ date: '2026-12-01' }),
      entry({ date: '2027-01-01' })
    ]
    expect(forMonth(entries, { year: 2026, month: 0 }).map((e) => e.date)).toEqual(['2026-01-31'])
    expect(forMonth(entries, { year: 2026, month: 11 }).map((e) => e.date)).toEqual(['2026-12-01'])
  })
})

describe('breakdown', () => {
  const entries = [
    entry({ amount: 100, stake: 50, sport: 'NBA', book: 'DK' }),
    entry({ amount: -50, stake: 50, sport: 'NBA', book: 'FD' }),
    entry({ amount: -20, stake: 20, sport: 'NFL', book: 'DK' }),
    entry({ amount: 300, sport: '' })
  ]

  it('groups by tag, most profitable first', () => {
    const rows = breakdown(entries, 'sport')
    expect(rows.map((r) => r.label)).toEqual(['NBA', 'NFL'])
    expect(rows[0].profit).toBe(50)
    expect(rows[0].bets).toBe(2)
    expect(rows[0].roi).toBeCloseTo(50)
  })

  it('leaves untagged bets out entirely', () => {
    expect(breakdown(entries, 'sport').reduce((n, r) => n + r.bets, 0)).toBe(3)
  })

  it('reports how many bets the ROI actually covers', () => {
    const mixed = breakdown([entry({ amount: 90, sport: 'NBA' }), entry({ amount: -10, stake: 10, sport: 'NBA' })], 'sport')
    expect(mixed[0].bets).toBe(2)
    expect(mixed[0].roiBets).toBe(1)
    expect(mixed[0].profit).toBe(80)
    expect(mixed[0].roi).toBeCloseTo(-100)
  })

  it('has a null roi for a slice with no stakes', () => {
    expect(breakdown([entry({ amount: 5, book: 'DK' })], 'book')[0].roi).toBeNull()
  })

  it('is empty when nothing carries that tag', () => {
    expect(breakdown(entries, 'betType')).toEqual([])
  })
})

describe('tagValues', () => {
  it('lists distinct non-empty values, sorted', () => {
    const entries = [entry({ sport: 'NFL' }), entry({ sport: 'NBA' }), entry({ sport: 'NFL' }), entry({ sport: '' })]
    expect(tagValues(entries, 'sport')).toEqual(['NBA', 'NFL'])
  })
})

describe('summarize', () => {
  it('matches the individual helpers it replaces', () => {
    const entries = [
      entry({ date: '2026-01-01', amount: 100, stake: 50 }),
      entry({ date: '2026-01-02', amount: -60, stake: 60 }),
      entry({ date: '2026-01-02', amount: 10, stake: 10 })
    ]
    const s = summarize(entries)
    const days = groupByDay(entries)
    expect(s.total).toBe(total(entries))
    expect(s.bets).toBe(3)
    expect(s.dayCount).toBe(2)
    expect(s.dayWl).toEqual(dayWinLoss(days))
    expect(s.betWl).toEqual(betWinLoss(entries))
    expect(s.strike).toBe(strikeRate(betWinLoss(entries)))
    expect(s.streak).toEqual(currentStreak(days))
    expect(s.roi?.pct).toBe(roi(entries)?.pct)
    expect(s.series).toEqual(cumulativeSeries(days))
    expect(s.drawdown).toBe(maxDrawdown(cumulativeSeries(days)))
    expect(s.first).toBe('2026-01-01')
  })

  it('handles an empty history without throwing', () => {
    const s = summarize([])
    expect(s).toMatchObject({ total: 0, bets: 0, dayCount: 0, drawdown: 0, first: null })
    expect(s.roi).toBeNull()
    expect(s.strike).toBeNull()
    expect(s.streak).toBeNull()
    expect(s.best).toBeNull()
    expect(s.worst).toBeNull()
  })
})

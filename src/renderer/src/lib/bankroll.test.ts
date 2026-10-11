import { describe, expect, it } from 'vitest'
import type { BankrollMove, Bet, BetStatus } from '../../../shared/types'
import { bet } from '../test-utils'
import { bankrollNow, bankrollSeries, moveHints, stakeNote, stakeNoteApplies, STAKE_WARN_RATIO, type Bankroll } from './bankroll'
import { shiftDays } from './range'

let seq = 0

/** A deposit (+) or withdrawal (−) with defaults, like bet(). */
function move(over: Partial<BankrollMove> = {}): BankrollMove {
  seq++
  const date = over.date ?? '2026-01-01'
  return {
    id: over.id ?? `m${seq}`,
    date,
    amount: over.amount ?? 100,
    note: over.note ?? '',
    createdAt: over.createdAt ?? `${date}T00:00:00.000Z`,
    updatedAt: over.updatedAt ?? `${date}T00:00:00.000Z`
  }
}

/** Narrows to a known bankroll, failing the test otherwise. */
function known(b: Bankroll): Extract<Bankroll, { known: true }> {
  if (!b.known) throw new Error(`bankroll not known: ${b.reason}`)
  return b
}

describe('bankrollNow', () => {
  it('is loading until the moves and the settings have both been loaded', () => {
    expect(bankrollNow([], null, 1000)).toEqual({ known: false, reason: 'loading' })
    expect(bankrollNow([], [move()], undefined)).toEqual({ known: false, reason: 'loading' })
    expect(bankrollNow([], null, undefined)).toEqual({ known: false, reason: 'loading' })
  })

  it('is unset with no starting bankroll and no moves, whatever the bets', () => {
    expect(bankrollNow([], [], null)).toEqual({ known: false, reason: 'unset' })
    expect(bankrollNow([bet({ amount: 50 })], [], null)).toEqual({ known: false, reason: 'unset' })
  })

  it('a starting bankroll with no moves is the start plus settled results', () => {
    const b = known(bankrollNow([bet({ amount: 91 }), bet({ amount: -50 })], [], 1000))
    expect(b).toMatchObject({ start: 1000, startSet: true, funded: 1000, settledPL: 41, current: 1041 })
    expect(b.deposits).toEqual({ count: 0, sum: 0 })
    expect(b.withdrawals).toEqual({ count: 0, sum: 0 })
  })

  it('moves without a starting bankroll count from 0', () => {
    const b = known(bankrollNow([bet({ amount: -20 })], [move({ amount: 300 })], null))
    expect(b).toMatchObject({ start: 0, startSet: false, funded: 300, current: 280 })
  })

  it('tallies deposits and withdrawals apart, withdrawals as a negative sum', () => {
    const moves = [move({ amount: 500 }), move({ amount: 250.25 }), move({ amount: -120.5 })]
    const b = known(bankrollNow([], moves, 1000))
    expect(b.deposits).toEqual({ count: 2, sum: 750.25 })
    expect(b.withdrawals).toEqual({ count: 1, sum: -120.5 })
    expect(b.funded).toBe(1629.75)
    expect(b.current).toBe(1629.75)
  })

  it('counts a move dated in the future already', () => {
    expect(known(bankrollNow([], [move({ date: '2099-01-01', amount: -40 })], 100)).current).toBe(60)
  })

  it('adds settled results only: pending adds nothing, push and void add 0, a free bet its win', () => {
    const bets = [
      bet({ amount: 91, stake: 100 }),
      bet({ amount: -50, stake: 50 }),
      bet({ status: 'push', stake: 20 }),
      bet({ status: 'void', stake: 10 }),
      bet({ amount: 30, stake: 0 }),
      bet({ status: 'pending', stake: 40 }),
      bet({ status: 'pending' })
    ]
    const b = known(bankrollNow(bets, [], 500))
    expect(b.settledPL).toBe(71)
    expect(b.current).toBe(571)
    expect(b).toMatchObject({ inPlay: 40, inPlayCount: 2, unstakedPending: 1 })
  })

  it('finds the first bet date across every status, null with no bets', () => {
    const bets = [bet({ date: '2026-03-04', amount: 5 }), bet({ date: '2026-02-01', status: 'pending' }), bet({ date: '2026-02-10', status: 'void' })]
    expect(known(bankrollNow(bets, [], 0)).firstBetDate).toBe('2026-02-01')
    expect(known(bankrollNow([], [], 0)).firstBetDate).toBeNull()
  })

  it('adds in cents, without drift', () => {
    const bets = Array.from({ length: 10 }, () => bet({ amount: 0.1 }))
    const b = known(bankrollNow(bets, [move({ amount: 0.2 })], 0.1))
    expect(b.settledPL).toBe(1)
    expect(b.current).toBe(1.3)
  })

  it('never clamps: a bankroll can read below zero', () => {
    expect(known(bankrollNow([bet({ amount: -300 })], [], 100)).current).toBe(-200)
  })
})

describe('bankrollSeries', () => {
  const moves = [move({ date: '2026-03-01', amount: 500 }), move({ date: '2026-03-05', amount: -100 })]
  const bets = [
    bet({ date: '2026-03-02', amount: 50 }),
    bet({ date: '2026-03-02', amount: -20 }),
    bet({ date: '2026-03-03', status: 'pending', stake: 25 }),
    bet({ date: '2026-03-04', status: 'void' })
  ]

  it('is empty with nothing settled and nothing moved', () => {
    expect(bankrollSeries([], [], 1000)).toEqual([])
    expect(bankrollSeries([bet({ status: 'pending' })], [], 1000)).toEqual([])
  })

  it('one end-of-day point per day with a result or a move, after an opening point', () => {
    expect(bankrollSeries(bets, moves, 1000)).toEqual([
      { date: '2026-02-28', balance: 1000, dayTotal: 0, moved: 0, funded: 1000, opening: true },
      { date: '2026-03-01', balance: 1500, dayTotal: 0, moved: 500, funded: 1500 },
      { date: '2026-03-02', balance: 1530, dayTotal: 30, moved: 0, funded: 1500 },
      // 03-03 has only a pending bet: no point. 03-04's void is settled.
      { date: '2026-03-04', balance: 1530, dayTotal: 0, moved: 0, funded: 1500 },
      { date: '2026-03-05', balance: 1430, dayTotal: 0, moved: -100, funded: 1400 }
    ])
  })

  it('puts a bet and a move on the same day in one point', () => {
    const series = bankrollSeries([bet({ date: '2026-03-01', amount: -40 })], [move({ date: '2026-03-01', amount: 200 })], 0)
    expect(series[1]).toEqual({ date: '2026-03-01', balance: 160, dayTotal: -40, moved: 200, funded: 200 })
  })

  it('clips to the bounds, opening the day before `from` with everything earlier', () => {
    expect(bankrollSeries(bets, moves, 1000, { from: '2026-03-02', to: '2026-03-04' })).toEqual([
      { date: '2026-03-01', balance: 1500, dayTotal: 0, moved: 0, funded: 1500, opening: true },
      { date: '2026-03-02', balance: 1530, dayTotal: 30, moved: 0, funded: 1500 },
      { date: '2026-03-04', balance: 1530, dayTotal: 0, moved: 0, funded: 1500 }
    ])
  })

  it('opens the day before `from` even when the range starts before any data', () => {
    const series = bankrollSeries(bets, moves, 1000, { from: '2026-01-01', to: null })
    expect(series[0]).toEqual({ date: '2025-12-31', balance: 1000, dayTotal: 0, moved: 0, funded: 1000, opening: true })
    expect(series).toHaveLength(5)
  })

  it('with only an end, opens the day before the first point', () => {
    const series = bankrollSeries(bets, moves, 1000, { from: null, to: '2026-03-02' })
    expect(series.map((p) => p.date)).toEqual(['2026-02-28', '2026-03-01', '2026-03-02'])
  })

  it('is empty when nothing falls in the bounds', () => {
    expect(bankrollSeries(bets, moves, 1000, { from: '2026-04-01', to: '2026-04-30' })).toEqual([])
    expect(bankrollSeries(bets, moves, 1000, { from: '2026-01-01', to: '2026-02-28' })).toEqual([])
  })

  it('values stay absolute in a range: no restart at 0', () => {
    const series = bankrollSeries(bets, moves, 1000, { from: '2026-03-05', to: null })
    expect(series.map((p) => p.balance)).toEqual([1530, 1430])
  })
})

/** A small deterministic generator (mulberry32), so the property test is reproducible. */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('bankrollSeries and bankrollNow agree (property, fixed seed)', () => {
  const rand = rng(20261011)
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1))
  const cents = (lo: number, hi: number): number => int(lo * 100, hi * 100) / 100
  const day = (): string => shiftDays('2026-01-01', int(0, 89))

  function randomBet(): Bet {
    const status = (['pending', 'won', 'lost', 'push', 'void'] as BetStatus[])[int(0, 4)]
    const amount = status === 'won' ? cents(0.01, 900) : status === 'lost' ? -cents(0.01, 900) : 0
    return bet({ date: day(), status, amount, stake: rand() < 0.2 ? null : cents(0, 500) })
  }

  function randomMove(): BankrollMove {
    const size = cents(0.01, 2000)
    return move({ date: day(), amount: rand() < 0.4 ? -size : size })
  }

  it('the last unbounded point is the bankroll now; a bounded series is the same points, clipped', () => {
    let checked = 0
    for (let trial = 0; trial < 300; trial++) {
      const bets = Array.from({ length: int(0, 40) }, randomBet)
      const moves = Array.from({ length: int(0, 8) }, randomMove)
      const start = rand() < 0.3 ? null : cents(0, 5000)
      const now = bankrollNow(bets, moves, start)
      if (!now.known) continue
      const series = bankrollSeries(bets, moves, now.start)
      if (series.length === 0) continue
      checked++

      const last = series[series.length - 1]
      expect(last.balance).toBe(now.current)
      expect(last.funded).toBe(now.funded)
      expect(series[0]).toMatchObject({ opening: true, balance: now.start, funded: now.start })
      const sum = (xs: number[]): number => Math.round(xs.reduce((s, x) => s + x * 100, 0)) / 100
      expect(sum(series.map((p) => p.dayTotal))).toBe(now.settledPL)
      expect(sum(series.map((p) => p.moved))).toBe(Math.round((now.deposits.sum + now.withdrawals.sum) * 100) / 100)

      // Any window: the points inside are the unbounded ones, untouched, and
      // the opening carries the balance of the last day before it (the
      // start when there is none).
      const from = day()
      const to = shiftDays(from, int(0, 40))
      const clipped = bankrollSeries(bets, moves, now.start, { from, to })
      const days = series.filter((p) => !p.opening)
      const inside = days.filter((p) => p.date >= from && p.date <= to)
      if (inside.length === 0) {
        expect(clipped).toEqual([])
        continue
      }
      expect(clipped.slice(1)).toEqual(inside)
      const before = days.filter((p) => p.date < from)
      const carried = before.length > 0 ? before[before.length - 1] : { balance: now.start, funded: now.start }
      expect(clipped[0]).toEqual({ date: shiftDays(from, -1), balance: carried.balance, dayTotal: 0, moved: 0, funded: carried.funded, opening: true })
    }
    // The generator must actually exercise the property.
    expect(checked).toBeGreaterThan(150)
  })
})

describe('stakeNote', () => {
  it('says nothing while the bankroll is unknown', () => {
    expect(stakeNote(50, null)).toEqual({ kind: 'none' })
  })

  it('shows the bankroll alone until a stake is typed', () => {
    expect(stakeNote(null, 1180)).toEqual({ kind: 'bankroll', current: 1180 })
    expect(stakeNote(0, 1180)).toEqual({ kind: 'bankroll', current: 1180 })
    expect(stakeNote(Number.NaN, 1180)).toEqual({ kind: 'bankroll', current: 1180 })
    expect(stakeNote(0.004, 1180)).toEqual({ kind: 'bankroll', current: 1180 })
    // No stake comes first: an empty bankroll with nothing typed is just shown.
    expect(stakeNote(0, 0)).toEqual({ kind: 'bankroll', current: 0 })
  })

  it('says the bankroll is empty at or below zero', () => {
    expect(stakeNote(10, 0)).toEqual({ kind: 'empty', current: 0 })
    expect(stakeNote(10, -50)).toEqual({ kind: 'empty', current: -50 })
  })

  it('draws the line at exactly 5%, in cents', () => {
    expect(STAKE_WARN_RATIO).toBe(0.05)
    expect(stakeNote(59, 1180)).toEqual({ kind: 'share', pct: 5, current: 1180 })
    expect(stakeNote(59.01, 1180)).toEqual({ kind: 'over', pct: 5.1, current: 1180 })
  })

  it('rounds the shown percentage away from the line, without float error', () => {
    // 4.99%: a share reads 4.9, never 5.0.
    expect(stakeNote(58.9, 1180)).toMatchObject({ kind: 'share', pct: 4.9 })
    // In floating point 1.4 / 100 is a hair under 1.4% (floor: 1.3) and
    // 1.06 / 10 a hair over 10.6% (ceil: 10.7); in cents both are exact.
    expect(stakeNote(1.4, 100)).toMatchObject({ kind: 'share', pct: 1.4 })
    expect(stakeNote(1.06, 10)).toMatchObject({ kind: 'over', pct: 10.6 })
    expect(stakeNote(0.14, 10)).toMatchObject({ kind: 'share', pct: 1.4 })
    expect(stakeNote(1180, 1180)).toMatchObject({ kind: 'over', pct: 100 })
    expect(stakeNote(2000, 1000)).toMatchObject({ kind: 'over', pct: 200 })
  })
})

describe('stakeNoteApplies', () => {
  const today = '2026-10-11'

  it('applies to a bet dated today or later, or still pending', () => {
    expect(stakeNoteApplies(today, 'won', today)).toBe(true)
    expect(stakeNoteApplies('2026-10-12', 'lost', today)).toBe(true)
    expect(stakeNoteApplies('2026-10-01', 'pending', today)).toBe(true)
  })

  it('not to one settled in the past', () => {
    expect(stakeNoteApplies('2026-10-10', 'won', today)).toBe(false)
    expect(stakeNoteApplies('2026-01-01', 'void', today)).toBe(false)
  })
})

describe('moveHints', () => {
  it('flags a duplicate: another move on the same day for the same amount, in cents', () => {
    const moves = [move({ id: 'd1', date: '2026-03-01', amount: 500 })]
    const b = bankrollNow([], moves, null)
    expect(moveHints({ date: '2026-03-01', amount: 500 }, moves, b)).toEqual(['duplicate'])
    expect(moveHints({ date: '2026-03-01', amount: 500.001 }, moves, b)).toEqual(['duplicate'])
    expect(moveHints({ date: '2026-03-02', amount: 500 }, moves, b)).toEqual([])
    expect(moveHints({ date: '2026-03-01', amount: 400 }, moves, b)).toEqual([])
    // A move is no duplicate of itself while being edited.
    expect(moveHints({ date: '2026-03-01', amount: 500 }, moves, b, 'd1')).toEqual([])
  })

  it('flags a withdrawal that takes the bankroll below zero', () => {
    const moves = [move({ id: 'w1', date: '2026-03-01', amount: -150 })]
    const b = bankrollNow([], moves, 200)
    expect(moveHints({ date: '2026-03-02', amount: -60 }, moves, b)).toEqual(['belowZero'])
    expect(moveHints({ date: '2026-03-02', amount: -50 }, moves, b)).toEqual([])
  })

  it('judges an edit by what it changes: an unchanged withdrawal is fine, a bigger one may not be', () => {
    const moves = [move({ id: 'w1', date: '2026-03-01', amount: -200 })]
    const b = bankrollNow([], moves, 200)
    expect(known(b).current).toBe(0)
    expect(moveHints({ date: '2026-03-01', amount: -200 }, moves, b, 'w1')).toEqual([])
    expect(moveHints({ date: '2026-03-01', amount: -200.01 }, moves, b, 'w1')).toEqual(['belowZero'])
  })

  it('flags lowering a deposit below what was spent, but not a deposit into a bankroll already below zero', () => {
    const moves = [move({ id: 'd1', date: '2026-03-01', amount: 500 })]
    const b = bankrollNow([bet({ date: '2026-03-02', amount: -200 })], moves, null)
    expect(moveHints({ date: '2026-03-01', amount: 100 }, moves, b, 'd1')).toEqual(['belowZero'])
    const negative = bankrollNow([bet({ amount: -200 })], [], 100)
    expect(known(negative).current).toBe(-100)
    expect(moveHints({ date: '2026-03-01', amount: 50 }, [], negative)).toEqual([])
    expect(moveHints({ date: '2026-03-01', amount: -10 }, [], negative)).toEqual(['belowZero'])
  })

  it('flags a deposit on or before the first bet when a starting bankroll is set', () => {
    const bets = [bet({ date: '2026-03-05', amount: 10 }), bet({ date: '2026-03-09', status: 'pending' })]
    const b = bankrollNow(bets, [], 1000)
    expect(moveHints({ date: '2026-03-05', amount: 300 }, [], b)).toEqual(['beforeStart'])
    expect(moveHints({ date: '2026-02-01', amount: 300 }, [], b)).toEqual(['beforeStart'])
    expect(moveHints({ date: '2026-03-06', amount: 300 }, [], b)).toEqual([])
    // A withdrawal is not the starting money counted twice.
    expect(moveHints({ date: '2026-03-01', amount: -30 }, [], b)).toEqual([])
    // Without a starting bankroll, an early deposit is how the bankroll starts.
    const noStart = bankrollNow(bets, [move({ date: '2026-03-01', amount: 200 })], null)
    expect(moveHints({ date: '2026-03-01', amount: 300 }, [], noStart)).toEqual([])
    // No bets yet: nothing to be before.
    expect(moveHints({ date: '2026-03-01', amount: 300 }, [], bankrollNow([], [], 1000))).toEqual([])
  })

  it('reports every hint that applies, and only duplicates while the bankroll is unknown', () => {
    const moves = [move({ id: 'w1', date: '2026-03-01', amount: -500 })]
    const bets = [bet({ date: '2026-03-01', amount: -10 })]
    expect(moveHints({ date: '2026-03-01', amount: -500 }, moves, bankrollNow(bets, moves, 100))).toEqual(['duplicate', 'belowZero'])
    const early = [move({ id: 'd1', date: '2026-02-01', amount: 300 })]
    expect(moveHints({ date: '2026-02-01', amount: 300 }, early, bankrollNow(bets, early, 1000))).toEqual(['duplicate', 'beforeStart'])
    const loading: Bankroll = { known: false, reason: 'loading' }
    expect(moveHints({ date: '2026-03-01', amount: -5000 }, moves, loading)).toEqual([])
    expect(moveHints({ date: '2026-03-01', amount: -500 }, moves, loading)).toEqual(['duplicate'])
  })
})

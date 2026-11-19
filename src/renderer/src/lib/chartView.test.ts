import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { moneyFormat, scaledFormat } from './format'
import { bankrollAxis, loadChartView, niceScale, saveChartView, withOpening, xTicks, yAxisFor, type ChartPoint } from './chartView'

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('remembering the chart view', () => {
  it('round-trips', () => {
    saveChartView('bankroll')
    expect(loadChartView()).toBe('bankroll')
    saveChartView('pl')
    expect(loadChartView()).toBe('pl')
  })

  it('falls back to P/L on nothing or nonsense', () => {
    expect(loadChartView()).toBe('pl')
    localStorage.setItem('bettracker:chart-view', 'pie')
    expect(loadChartView()).toBe('pl')
    localStorage.setItem('bettracker:chart-view', '"bankroll"')
    expect(loadChartView()).toBe('pl')
  })

  it('survives storage that throws', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => saveChartView('bankroll')).not.toThrow()
    expect(loadChartView()).toBe('pl')
  })
})

describe('niceScale — round ticks for the bankroll axis', () => {
  it('covers the values on steps of 1, 2, 2.5 or 5 times a power of ten', () => {
    expect(niceScale(948, 1650)).toEqual({ lo: 800, hi: 1800, ticks: [800, 1000, 1200, 1400, 1600, 1800] })
    expect(niceScale(0.3, 9.7)).toEqual({ lo: 0, hi: 10, ticks: [0, 2.5, 5, 7.5, 10] })
    expect(niceScale(-120, 40)).toEqual({ lo: -150, hi: 50, ticks: [-150, -100, -50, 0, 50] })
  })

  it('opens up a flat line instead of collapsing to one tick', () => {
    const s = niceScale(1000, 1000)
    expect(s.lo).toBeLessThan(s.hi)
    expect(s.ticks.length).toBeGreaterThan(1)
    expect(s.lo).toBeLessThanOrEqual(1000)
    expect(s.hi).toBeGreaterThanOrEqual(1000)
  })

  it('keeps ticks free of float dust', () => {
    for (const t of niceScale(0.1, 0.7).ticks) expect(String(t).length).toBeLessThan(6)
  })
})

describe('bankrollAxis — ticks the labels can tell apart', () => {
  // The labels, as the chart's dollar and unit axes write them.
  const dollars = (v: number): string => moneyFormat(null).axis(v)
  const units = (v: number): string => scaledFormat(true).axis(v)
  const distinct = (labels: string[]): boolean => new Set(labels).size === labels.length

  it('never repeats a label from $1,000 up', () => {
    for (const [lo, hi] of [
      [1000, 1120],
      [980, 1120],
      [10000, 10010],
      [1900, 2800],
      [99_950, 100_040]
    ]) {
      const { ticks } = bankrollAxis(lo, hi, false)
      expect(distinct(ticks.map(dollars)), `${lo}-${hi}: ${ticks.map(dollars).join(' ')}`).toBe(true)
      expect(ticks[0]).toBeLessThanOrEqual(lo)
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(hi)
    }
    expect(bankrollAxis(1000, 1120, false).ticks.map(dollars)).toEqual(['$1k', '$1.1k', '$1.2k'])
    expect(bankrollAxis(1900, 2800, false).ticks.map(dollars)).toEqual(['$1.5k', '$2k', '$2.5k', '$3k'])
  })

  it('keeps fine steps below $1,000, and in units', () => {
    expect(bankrollAxis(120, 180, false).ticks.map(dollars)).toEqual(['$120', '$140', '$160', '$180'])
    const { ticks } = bankrollAxis(50, 56, true)
    expect(distinct(ticks.map(units))).toBe(true)
    expect(distinct(bankrollAxis(995, 1003, true).ticks.map(units))).toBe(true)
  })
})

const pt = (date: string, balance: number, extra: Partial<ChartPoint> = {}): ChartPoint => ({ date, balance, dayTotal: 0, ...extra })

describe('withOpening — the P/L curve starts at 0 the day before its first point', () => {
  it('prepends the opening point, so one settled day already draws a line', () => {
    const points = [{ date: '2026-03-01', balance: 45, dayTotal: 45 }]
    expect(withOpening(points)).toEqual([{ date: '2026-02-28', balance: 0, dayTotal: 0, opening: true }, points[0]])
  })

  it('opens across a month or year boundary on the calendar', () => {
    expect(withOpening([pt('2026-01-01', 10)])[0].date).toBe('2025-12-31')
    expect(withOpening([pt('2024-03-01', 10)])[0].date).toBe('2024-02-29')
  })

  it('keeps the points as they are, and adds nothing to nothing', () => {
    const points = [pt('2026-03-01', 45), pt('2026-03-04', -20)]
    expect(withOpening(points).slice(1)).toEqual(points)
    expect(withOpening([])).toEqual([])
  })
})

describe('xTicks — which dates get a label', () => {
  const dates = (n: number): { date: string }[] => Array.from({ length: n }, (_, i) => ({ date: `2026-03-${String(i + 1).padStart(2, '0')}` }))

  it('labels the first and the last point and spreads the rest, five at most', () => {
    expect(xTicks(dates(31))).toEqual(['2026-03-01', '2026-03-09', '2026-03-16', '2026-03-24', '2026-03-31'])
    expect(xTicks(dates(5))).toEqual(dates(5).map((d) => d.date))
    expect(xTicks(dates(31), 3)).toEqual(['2026-03-01', '2026-03-16', '2026-03-31'])
  })

  it('never repeats a date, and copes with one point or none', () => {
    expect(xTicks(dates(2))).toEqual(['2026-03-01', '2026-03-02'])
    expect(xTicks(dates(3))).toEqual(['2026-03-01', '2026-03-02', '2026-03-03'])
    expect(xTicks(dates(1))).toEqual(['2026-03-01'])
    expect(xTicks([])).toEqual([])
  })
})

describe('yAxisFor — the axis of either view, on round ticks', () => {
  it('P/L: includes zero and the round bounds around the data, with the zero line', () => {
    const axis = yAxisFor('pl', [pt('2026-03-01', 0, { opening: true }), pt('2026-03-02', 948), pt('2026-03-03', 1650)], false)
    // Span 1,650 at the k labels' resolution (100): steps of 500.
    expect(axis).toEqual({ domain: [0, 2000], ticks: [0, 500, 1000, 1500, 2000], zero: true })
    const down = yAxisFor('pl', [pt('2026-03-01', 0, { opening: true }), pt('2026-03-02', -120), pt('2026-03-03', 40)], false)
    expect(down.domain).toEqual([-150, 50])
    expect(down.zero).toBe(true)
  })

  it('P/L: a flat series at zero (every day a push) still has room in its domain, never [0, 0]', () => {
    const flat = yAxisFor('pl', [pt('2026-03-01', 0, { opening: true }), pt('2026-03-02', 0), pt('2026-03-03', 0)], false)
    expect(flat.domain[0]).toBeLessThan(flat.domain[1])
    expect(flat.domain[0]).toBeLessThanOrEqual(0)
    expect(flat.domain[1]).toBeGreaterThanOrEqual(0)
    expect(flat.ticks.length).toBeGreaterThan(1)
    expect(flat.zero).toBe(true)
    const flatUnits = yAxisFor('pl', [pt('2026-03-01', 0), pt('2026-03-02', 0)], true)
    expect(flatUnits.domain[0]).toBeLessThan(flatUnits.domain[1])
    expect(yAxisFor('pl', [], false).domain[0]).toBeLessThan(yAxisFor('pl', [], false).domain[1])
  })

  it('bankroll: fitted to the balance and the money put in, zero only when it crosses it', () => {
    const up = yAxisFor('bankroll', [pt('2026-03-01', 1000, { funded: 1000, opening: true }), pt('2026-03-02', 1120, { funded: 1000 })], false)
    expect(up).toEqual({ domain: [1000, 1200], ticks: [1000, 1100, 1200], zero: false })
    const under = yAxisFor('bankroll', [pt('2026-03-01', 100, { funded: 100 }), pt('2026-03-02', -20, { funded: 100 })], false)
    expect(under.zero).toBe(true)
    expect(under.domain[0]).toBeLessThanOrEqual(-20)
    expect(under.domain[1]).toBeGreaterThanOrEqual(100)
  })

  it('bankroll: a flat series has room in its domain too', () => {
    const flat = yAxisFor('bankroll', [pt('2026-03-01', 1000, { funded: 1000 }), pt('2026-03-02', 1000, { funded: 1000 })], false)
    expect(flat.domain[0]).toBeLessThan(flat.domain[1])
  })
})

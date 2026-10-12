import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { moneyFormat, scaledFormat } from './format'
import { bankrollAxis, loadChartView, niceScale, saveChartView } from './chartView'

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

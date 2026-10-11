import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadChartView, niceScale, saveChartView } from './chartView'

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

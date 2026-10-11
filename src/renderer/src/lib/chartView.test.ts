import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadChartView, saveChartView } from './chartView'

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

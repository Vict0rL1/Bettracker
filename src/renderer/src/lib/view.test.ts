import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_VIEWS, loadSpendChartView, loadView, saveSpendChartView, saveView } from './view'

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('the view this device opens on', () => {
  it('is the bets until the expenses are chosen, and is remembered', () => {
    expect(loadView()).toBe('bets')
    saveView('expenses')
    expect(localStorage.getItem('bettracker:view')).toBe('expenses')
    expect(loadView()).toBe('expenses')
    saveView('bets')
    expect(loadView()).toBe('bets')
    expect(APP_VIEWS).toEqual(['bets', 'expenses'])
  })

  it('reads anything else stored there as the bets', () => {
    localStorage.setItem('bettracker:view', 'Expenses')
    expect(loadView()).toBe('bets')
    localStorage.setItem('bettracker:view', '"expenses"')
    expect(loadView()).toBe('bets')
  })

  it('opens on the bets, and saves nothing, when storage throws', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(loadView()).toBe('bets')
    expect(() => saveView('expenses')).not.toThrow()
    expect(loadSpendChartView()).toBe('cumulative')
    expect(() => saveSpendChartView('daily')).not.toThrow()
  })
})

describe('the spending chart’s view', () => {
  it('is the running total until "per day" is chosen, and is remembered', () => {
    expect(loadSpendChartView()).toBe('cumulative')
    saveSpendChartView('daily')
    expect(localStorage.getItem('bettracker:spend-chart')).toBe('daily')
    expect(loadSpendChartView()).toBe('daily')
    saveSpendChartView('cumulative')
    expect(loadSpendChartView()).toBe('cumulative')
    localStorage.setItem('bettracker:spend-chart', 'weekly')
    expect(loadSpendChartView()).toBe('cumulative')
  })
})

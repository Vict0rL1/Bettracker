import { beforeEach, describe, expect, it } from 'vitest'
import { bet } from '../test-utils'
import { filterRange, loadRange, rangeBounds, saveRange, shiftDays } from './range'

// A Wednesday, for the week test.
const TODAY = '2026-10-07'

beforeEach(() => localStorage.clear())

describe('shiftDays', () => {
  it('moves across month and year ends', () => {
    expect(shiftDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftDays('2024-02-28', 1)).toBe('2024-02-29')
  })
})

describe('rangeBounds', () => {
  it('all time is unbounded', () => {
    expect(rangeBounds({ kind: 'all' }, TODAY)).toEqual({ from: null, to: null })
  })

  it('this week runs Sunday to Saturday, like the calendar', () => {
    expect(rangeBounds({ kind: 'week' }, TODAY)).toEqual({ from: '2026-10-04', to: '2026-10-10' })
    expect(rangeBounds({ kind: 'week' }, '2026-10-04')).toEqual({ from: '2026-10-04', to: '2026-10-10' })
    expect(rangeBounds({ kind: 'week' }, '2026-10-10')).toEqual({ from: '2026-10-04', to: '2026-10-10' })
  })

  it('this month covers the whole calendar month', () => {
    expect(rangeBounds({ kind: 'month' }, TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(rangeBounds({ kind: 'month' }, '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })

  it('last 30 days ends today and includes it', () => {
    expect(rangeBounds({ kind: '30d' }, TODAY)).toEqual({ from: '2026-09-08', to: '2026-10-07' })
  })

  it('this year', () => {
    expect(rangeBounds({ kind: 'year' }, TODAY)).toEqual({ from: '2026-01-01', to: '2026-12-31' })
  })

  it('custom keeps its own ends, open where missing', () => {
    expect(rangeBounds({ kind: 'custom', from: '2026-01-05' }, TODAY)).toEqual({ from: '2026-01-05', to: null })
    expect(rangeBounds({ kind: 'custom', to: '2026-01-05' }, TODAY)).toEqual({ from: null, to: '2026-01-05' })
  })
})

describe('filterRange', () => {
  const bets = [bet({ id: 'a', date: '2026-09-07' }), bet({ id: 'b', date: '2026-09-08' }), bet({ id: 'c', date: '2026-10-07' }), bet({ id: 'd', date: '2026-10-08' })]

  it('is inclusive at both ends', () => {
    expect(filterRange(bets, { kind: '30d' }, TODAY).map((b) => b.id)).toEqual(['b', 'c'])
    expect(filterRange(bets, { kind: 'custom', from: '2026-09-08', to: '2026-10-07' }, TODAY).map((b) => b.id)).toEqual(['b', 'c'])
  })

  it('all time passes everything through', () => {
    expect(filterRange(bets, { kind: 'all' }, TODAY)).toHaveLength(4)
  })
})

describe('remembering the range', () => {
  it('round-trips, custom dates included', () => {
    saveRange({ kind: 'custom', from: '2026-01-01', to: '2026-01-31' })
    expect(loadRange()).toEqual({ kind: 'custom', from: '2026-01-01', to: '2026-01-31' })
    saveRange({ kind: 'week' })
    expect(loadRange()).toEqual({ kind: 'week' })
  })

  it('falls back to all time on nothing, nonsense or an unknown kind, and drops a bad custom date', () => {
    expect(loadRange()).toEqual({ kind: 'all' })
    localStorage.setItem('bettracker:range', 'not json')
    expect(loadRange()).toEqual({ kind: 'all' })
    localStorage.setItem('bettracker:range', JSON.stringify({ kind: 'fortnight' }))
    expect(loadRange()).toEqual({ kind: 'all' })
    localStorage.setItem('bettracker:range', JSON.stringify({ kind: 'custom', from: '2026-13-40', to: '2026-02-01' }))
    expect(loadRange()).toEqual({ kind: 'custom', from: undefined, to: '2026-02-01' })
  })
})

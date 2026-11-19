import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addDays, addMonths, daysInMonth, firstWeekday, monthPrefix, monthYearShort, toDateStr, weekdayOf } from './dates'
import { setLang } from './i18n'

beforeEach(() => setLang('en'))

describe('daysInMonth', () => {
  it('knows every month, leap Februaries included', () => {
    expect(daysInMonth({ year: 2026, month: 0 })).toBe(31)
    expect(daysInMonth({ year: 2026, month: 1 })).toBe(28)
    expect(daysInMonth({ year: 2024, month: 1 })).toBe(29)
    expect(daysInMonth({ year: 2000, month: 1 })).toBe(29)
    expect(daysInMonth({ year: 1900, month: 1 })).toBe(28)
    expect(daysInMonth({ year: 2100, month: 1 })).toBe(28)
    expect(daysInMonth({ year: 2026, month: 3 })).toBe(30)
    expect(daysInMonth({ year: 2026, month: 11 })).toBe(31)
  })
})

describe('firstWeekday', () => {
  it('is the weekday of the 1st, Sunday 0, as the calendar lays its blanks', () => {
    // 1 Nov 2026 is a Sunday; 1 Aug 2026 a Saturday; 1 Feb 2026 a Sunday; 1 Mar 2026 a Sunday.
    expect(firstWeekday({ year: 2026, month: 10 })).toBe(0)
    expect(firstWeekday({ year: 2026, month: 7 })).toBe(6)
    expect(firstWeekday({ year: 2026, month: 1 })).toBe(0)
    expect(firstWeekday({ year: 2026, month: 2 })).toBe(0)
    expect(firstWeekday({ year: 2026, month: 11 })).toBe(2)
    expect(firstWeekday({ year: 2026, month: 10 })).toBe(weekdayOf('2026-11-01'))
  })
})

describe('addDays', () => {
  it('moves along the calendar across month and year ends, and through a leap day', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29')
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01')
    expect(addDays('2026-01-15', 0)).toBe('2026-01-15')
    expect(addDays('2026-01-15', 365)).toBe('2027-01-15')
  })

  describe('across a DST change (the local day has 23 or 25 hours)', () => {
    const before = process.env.TZ
    beforeEach(() => {
      process.env.TZ = 'America/New_York'
    })
    afterEach(() => {
      if (before === undefined) delete process.env.TZ
      else process.env.TZ = before
    })

    it('stays on whole calendar days', () => {
      // Clocks go forward on 8 Mar 2026 and back on 1 Nov 2026 in New York.
      expect(addDays('2026-03-07', 1)).toBe('2026-03-08')
      expect(addDays('2026-03-08', 1)).toBe('2026-03-09')
      expect(addDays('2026-03-09', -1)).toBe('2026-03-08')
      expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
      expect(addDays('2026-11-01', 1)).toBe('2026-11-02')
      expect(addDays('2026-11-02', -1)).toBe('2026-11-01')
      expect(addDays('2026-03-01', 30)).toBe('2026-03-31')
    })
  })
})

describe('monthYearShort', () => {
  it('follows the interface language, with a capital first letter in both', () => {
    expect(monthYearShort('2026-08-15')).toBe('Aug 2026')
    expect(monthYearShort('2026-01-05')).toBe('Jan 2026')
    setLang('es')
    expect(monthYearShort('2026-08-15')).toBe('Ago 2026')
    expect(monthYearShort('2026-01-05')).toBe('Ene 2026')
  })
})

describe('month keys', () => {
  it('addMonths wraps years in both directions and monthPrefix pads the month', () => {
    expect(addMonths({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 })
    expect(addMonths({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 })
    expect(addMonths({ year: 2026, month: 5 }, -18)).toEqual({ year: 2024, month: 11 })
    expect(monthPrefix({ year: 2026, month: 0 })).toBe('2026-01')
    expect(toDateStr(2026, 10, 3)).toBe('2026-11-03')
  })
})

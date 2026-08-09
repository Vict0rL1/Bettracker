import { describe, expect, it } from 'vitest'
import { MAX_AMOUNT, isValidDate, normalizeInput } from './validate'

describe('isValidDate', () => {
  it('accepts a real calendar date', () => {
    expect(isValidDate('2026-02-28')).toBe(true)
    expect(isValidDate('2024-02-29')).toBe(true)
  })

  it('rejects a day that does not exist in that month', () => {
    expect(isValidDate('2026-02-30')).toBe(false)
    expect(isValidDate('2025-02-29')).toBe(false)
    expect(isValidDate('2026-13-01')).toBe(false)
  })

  it('rejects anything not in YYYY-MM-DD form', () => {
    expect(isValidDate('2026-1-1')).toBe(false)
    expect(isValidDate('01/02/2026')).toBe(false)
    expect(isValidDate('')).toBe(false)
  })
})

describe('normalizeInput', () => {
  const base = { date: '2026-05-04', amount: 10 }

  it('rounds money to cents', () => {
    expect(normalizeInput({ ...base, amount: 10.005 }).amount).toBe(10.01)
    expect(normalizeInput({ ...base, stake: 3.333 }).stake).toBe(3.33)
  })

  it('keeps a missing stake as null instead of 0', () => {
    expect(normalizeInput(base).stake).toBeNull()
    expect(normalizeInput({ ...base, stake: null }).stake).toBeNull()
    expect(normalizeInput({ ...base, stake: undefined }).stake).toBeNull()
  })

  it('allows a zero stake for free bets', () => {
    expect(normalizeInput({ ...base, stake: 0 }).stake).toBe(0)
  })

  it('rejects a negative stake', () => {
    expect(() => normalizeInput({ ...base, stake: -5 })).toThrow(/risked/i)
  })

  it('rejects out-of-range money', () => {
    expect(() => normalizeInput({ ...base, amount: MAX_AMOUNT + 1 })).toThrow(/out of range/i)
    expect(() => normalizeInput({ ...base, stake: MAX_AMOUNT + 1 })).toThrow(/out of range/i)
  })

  it('rejects non-finite money', () => {
    expect(() => normalizeInput({ ...base, amount: Number.NaN })).toThrow(/finite/i)
    expect(() => normalizeInput({ ...base, amount: Number.POSITIVE_INFINITY })).toThrow(/finite/i)
    expect(() => normalizeInput({ ...base, stake: Number.NaN })).toThrow(/finite/i)
  })

  it('rejects an impossible date', () => {
    expect(() => normalizeInput({ date: '2026-02-31', amount: 1 })).toThrow(/not a valid calendar date/i)
  })

  it('trims the note and collapses whitespace in tags', () => {
    const clean = normalizeInput({ ...base, note: '  late bet  ', sport: '  NBA   playoffs ', book: ' DK ' })
    expect(clean.note).toBe('late bet')
    expect(clean.sport).toBe('NBA playoffs')
    expect(clean.book).toBe('DK')
  })

  it('caps long text instead of rejecting it', () => {
    const clean = normalizeInput({ ...base, note: 'x'.repeat(900), betType: 'y'.repeat(200) })
    expect(clean.note).toHaveLength(500)
    expect(clean.betType).toHaveLength(40)
  })

  it('defaults every tag to an empty string', () => {
    expect(normalizeInput(base)).toMatchObject({ note: '', sport: '', book: '', betType: '' })
  })
})

import { describe, expect, it } from 'vitest'
import { MAX_AMOUNT, MAX_ODDS, isValidDate, normalizeInput, suggestedAmount } from './validate'

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
    expect(() => normalizeInput({ ...base, stake: -5 })).toThrow(/negative/i)
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

  describe('status', () => {
    it('follows the sign of the amount when not given — the pre-status rule', () => {
      expect(normalizeInput({ date: '2026-05-04', amount: 25 }).status).toBe('won')
      expect(normalizeInput({ date: '2026-05-04', amount: -25 }).status).toBe('lost')
      expect(normalizeInput({ date: '2026-05-04', amount: 0 }).status).toBe('push')
    })

    it('is pending when there is no amount at all', () => {
      const clean = normalizeInput({ date: '2026-05-04' })
      expect(clean.status).toBe('pending')
      expect(clean.amount).toBeNull()
    })

    it('drops the amount of a pending bet, whatever was passed', () => {
      expect(normalizeInput({ date: '2026-05-04', amount: 40, status: 'pending' }).amount).toBeNull()
    })

    it('insists a won bet nets positive and a lost bet negative', () => {
      expect(() => normalizeInput({ date: '2026-05-04', amount: -1, status: 'won' })).toThrow(/positive/i)
      expect(() => normalizeInput({ date: '2026-05-04', amount: 0, status: 'won' })).toThrow(/positive/i)
      expect(() => normalizeInput({ date: '2026-05-04', amount: 5, status: 'lost' })).toThrow(/negative/i)
      expect(() => normalizeInput({ date: '2026-05-04', status: 'won' })).toThrow(/needs its result/i)
    })

    it('reads the sign off the amount in cents, as it is stored', () => {
      // A result under half a cent is 0.00: a push, never a "won" 0.00.
      expect(normalizeInput({ ...base, amount: 0.004 })).toMatchObject({ status: 'push', amount: 0 })
      expect(normalizeInput({ ...base, amount: -0.004 })).toMatchObject({ status: 'push', amount: 0 })
      expect(() => normalizeInput({ ...base, amount: 0.004, status: 'won' })).toThrow(/positive/)
      expect(() => normalizeInput({ ...base, amount: -0.004, status: 'lost' })).toThrow(/negative/)
      expect(normalizeInput({ ...base, amount: 0.004, status: 'void' })).toMatchObject({ status: 'void', amount: 0 })
      expect(normalizeInput({ ...base, amount: 0.005 })).toMatchObject({ status: 'won', amount: 0.01 })
    })

    it('settles a push or void at exactly 0', () => {
      expect(normalizeInput({ date: '2026-05-04', status: 'push' }).amount).toBe(0)
      expect(normalizeInput({ date: '2026-05-04', status: 'void', amount: 0 }).amount).toBe(0)
      expect(() => normalizeInput({ date: '2026-05-04', status: 'push', amount: 3 })).toThrow(/returns the stake/i)
    })

    it('rejects an unknown status', () => {
      expect(() => normalizeInput({ ...base, status: 'cashout' as never })).toThrow(/not a bet status/i)
    })
  })

  describe('odds', () => {
    it('keeps decimal odds to three places and null when absent', () => {
      expect(normalizeInput({ ...base, odds: 1.9091 }).odds).toBe(1.909)
      expect(normalizeInput(base).odds).toBeNull()
      expect(normalizeInput({ ...base, odds: null }).odds).toBeNull()
    })

    it('rejects a price that is not above 1', () => {
      expect(() => normalizeInput({ ...base, odds: 1 })).toThrow(/greater than 1/i)
      expect(() => normalizeInput({ ...base, odds: 0.5 })).toThrow(/greater than 1/i)
      expect(() => normalizeInput({ ...base, odds: -2 })).toThrow(/greater than 1/i)
    })

    it('rejects a typo-sized price', () => {
      expect(() => normalizeInput({ ...base, odds: MAX_ODDS + 1 })).toThrow(/out of range/i)
      expect(() => normalizeInput({ ...base, odds: Number.NaN })).toThrow(/finite/i)
    })
  })
})

describe('suggestedAmount', () => {
  it('works a win out from stake and odds, a loss from the stake alone', () => {
    expect(suggestedAmount('won', 100, 1.91)).toBe(91)
    expect(suggestedAmount('won', 50, 2.5)).toBe(75)
    expect(suggestedAmount('lost', 100, null)).toBe(-100)
  })

  it('returns the stake on a push or void', () => {
    expect(suggestedAmount('push', 100, 1.91)).toBe(0)
    expect(suggestedAmount('void', null, null)).toBe(0)
  })

  it('has nothing to suggest without the inputs it needs', () => {
    expect(suggestedAmount('won', 100, null)).toBeNull()
    expect(suggestedAmount('won', null, 1.91)).toBeNull()
    expect(suggestedAmount('lost', null, 1.91)).toBeNull()
    expect(suggestedAmount('pending', 100, 1.91)).toBeNull()
  })
})

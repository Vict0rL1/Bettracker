import { describe, expect, it } from 'vitest'
import {
  MAX_AMOUNT,
  MAX_ODDS,
  effectiveUnit,
  isValidDate,
  normalizeInput,
  normalizeMove,
  parseMoneyBox,
  roundCents,
  storableOdds,
  suggestedAmount,
  unitSizePatch
} from './validate'

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
      // What the database would store (3 decimals) must be above 1 too.
      expect(() => normalizeInput({ ...base, odds: 1.0004 })).toThrow(/greater than 1/i)
      expect(() => normalizeInput({ ...base, closingOdds: 1.0004 })).toThrow(/greater than 1/i)
      expect(normalizeInput({ ...base, odds: 1.0006 }).odds).toBe(1.001)
      // The top of the range is judged the same way.
      expect(normalizeInput({ ...base, odds: MAX_ODDS + 0.0004 }).odds).toBe(MAX_ODDS)
      expect(() => normalizeInput({ ...base, odds: MAX_ODDS + 0.0005 })).toThrow(/out of range/i)
    })

    it('says which prices the forms and the import may offer: the ones that survive being stored', () => {
      expect(storableOdds(1.91)).toBe(true)
      expect(storableOdds(1.0006)).toBe(true)
      expect(storableOdds(1.0004)).toBe(false)
      expect(storableOdds(1)).toBe(false)
      expect(storableOdds(MAX_ODDS + 0.0004)).toBe(true)
      expect(storableOdds(MAX_ODDS + 0.0005)).toBe(false)
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

describe('normalizeMove — a deposit or withdrawal before it is queued', () => {
  it('keeps the sign: + deposit, − withdrawal, in cents', () => {
    expect(normalizeMove({ date: '2026-03-01', amount: 500 })).toEqual({ date: '2026-03-01', amount: 500, note: '' })
    expect(normalizeMove({ date: '2026-03-01', amount: -120.5, note: '  rent  ' })).toEqual({ date: '2026-03-01', amount: -120.5, note: 'rent' })
  })

  it('rounds a withdrawal by its size, so it matches the same deposit', () => {
    for (const typed of [12.345, 0.005, 1.005, 99.995]) {
      expect(normalizeMove({ date: '2026-03-01', amount: -typed }).amount).toBe(-normalizeMove({ date: '2026-03-01', amount: typed }).amount)
    }
    expect(roundCents(-12.346)).toBe(-12.35)
    expect(roundCents(0)).toBe(0)
  })

  it('refuses what the database would: zero once rounded, out of range, not a number, not a date', () => {
    expect(() => normalizeMove({ date: '2026-03-01', amount: 0 })).toThrow(/zero/)
    expect(() => normalizeMove({ date: '2026-03-01', amount: 0.004 })).toThrow(/zero/)
    expect(() => normalizeMove({ date: '2026-03-01', amount: -0.004 })).toThrow(/zero/)
    expect(() => normalizeMove({ date: '2026-03-01', amount: MAX_AMOUNT + 1 })).toThrow(/range/)
    expect(() => normalizeMove({ date: '2026-03-01', amount: -(MAX_AMOUNT + 1) })).toThrow(/range/)
    expect(() => normalizeMove({ date: '2026-03-01', amount: Number.NaN })).toThrow(/finite/)
    expect(() => normalizeMove({ date: '2026-02-30', amount: 5 })).toThrow(/calendar date/)
  })

  it('caps the note like a bet note', () => {
    expect(normalizeMove({ date: '2026-03-01', amount: 5, note: 'x'.repeat(600) }).note).toHaveLength(500)
  })
})

describe('parseMoneyBox — a settings money box', () => {
  const zeroOk = { allowZero: true }
  const zeroNo = { allowZero: false }

  it('reads an empty box as cleared', () => {
    expect(parseMoneyBox('', zeroNo)).toBeNull()
    expect(parseMoneyBox('   ', zeroOk)).toBeNull()
  })

  it('keeps an amount in cents, trimmed', () => {
    expect(parseMoneyBox('25', zeroNo)).toBe(25)
    expect(parseMoneyBox(' 12.346 ', zeroNo)).toBe(12.35)
    expect(parseMoneyBox(String(MAX_AMOUNT), zeroNo)).toBe(MAX_AMOUNT)
    // parseFloat reads the leading number, as the existing boxes always have.
    expect(parseMoneyBox('12abc', zeroNo)).toBe(12)
  })

  it('refuses what the database would: not a number, negative, out of range', () => {
    expect(parseMoneyBox('abc', zeroOk)).toBe('invalid')
    expect(parseMoneyBox('-5', zeroOk)).toBe('invalid')
    expect(parseMoneyBox('-0.001', zeroOk)).toBe('invalid')
    expect(parseMoneyBox(String(MAX_AMOUNT + 1), zeroOk)).toBe('invalid')
    expect(parseMoneyBox('Infinity', zeroOk)).toBe('invalid')
  })

  it('judges zero once rounded to cents, as stored', () => {
    expect(parseMoneyBox('0', zeroOk)).toBe(0)
    expect(parseMoneyBox('0', zeroNo)).toBe('invalid')
    expect(parseMoneyBox('0.004', zeroNo)).toBe('invalid')
    expect(parseMoneyBox('0.004', zeroOk)).toBe(0)
    expect(parseMoneyBox('0.005', zeroNo)).toBe(0.01)
    expect(Object.is(parseMoneyBox('-0', zeroOk), 0)).toBe(true)
  })
})

describe('effectiveUnit', () => {
  it('is the unit size only while units are on and the size is usable', () => {
    expect(effectiveUnit({ showUnits: true, unitSize: 20 })).toBe(20)
    expect(effectiveUnit({ showUnits: false, unitSize: 20 })).toBeNull()
    expect(effectiveUnit({ showUnits: true, unitSize: null })).toBeNull()
    expect(effectiveUnit({ showUnits: true, unitSize: 0 })).toBeNull()
    expect(effectiveUnit({ showUnits: true, unitSize: -5 })).toBeNull()
  })
})

describe('unitSizePatch — committing the unit size box', () => {
  const on = { unitSize: 20, showUnits: true }
  const off = { unitSize: null, showUnits: false }

  it('reverts a box the database would refuse, zero once rounded included', () => {
    for (const text of ['abc', '0', '0.004', '-1', String(MAX_AMOUNT + 1)]) expect(unitSizePatch(text, on)).toBe('revert')
  })

  it('clearing the unit turns units off too, unless both already are', () => {
    expect(unitSizePatch('', on)).toEqual({ unitSize: null, showUnits: false })
    expect(unitSizePatch('  ', { unitSize: 20, showUnits: false })).toEqual({ unitSize: null, showUnits: false })
    expect(unitSizePatch('', { unitSize: null, showUnits: true })).toEqual({ unitSize: null, showUnits: false })
    expect(unitSizePatch('', off)).toBeNull()
  })

  it('sends nothing for the same value, in cents', () => {
    expect(unitSizePatch('20', on)).toBeNull()
    expect(unitSizePatch('20.001', on)).toBeNull()
  })

  it('sends only the new size, leaving units on or off as they were', () => {
    expect(unitSizePatch('25', on)).toEqual({ unitSize: 25 })
    expect(unitSizePatch(' 12.5 ', off)).toEqual({ unitSize: 12.5 })
    expect(unitSizePatch('0.005', off)).toEqual({ unitSize: 0.01 })
  })
})

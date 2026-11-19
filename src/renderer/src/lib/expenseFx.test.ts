import { describe, expect, it } from 'vitest'
import { chargedFx, fxInput, fxView, mainDigits, NO_ORIGINAL, parseRateText, rateBoxText, rateKey, settledFx, type FxAuto, type FxStored } from './expenseFx'
import { normalizeExpense } from './validate'

const ecb: FxAuto = { rate: 1.4034, asOf: '2026-11-13', source: 'service' }
const view = (o: Partial<Parameters<typeof fxView>[0]> = {}) => fxView({ typed: null, amount: 12, main: 'CAD', ...o })
const required = { key: 'field.rateRequired', vars: { currency: 'CAD' } }

describe('parseRateText — a rate as typed', () => {
  it.each<[string, ReturnType<typeof parseRateText>]>([
    ['1.4034', 1.4034],
    ['1,4034', 1.4034],
    // A single separator is the decimal one, whatever follows: a rate of 1,403 is 1.403, never 1403.
    ['1,403', 1.403],
    ['1.403', 1.403],
    ['16.000', 16],
    ['0,00034', 0.00034],
    ['.5', 0.5],
    ['5.', 5],
    ['2', 2],
    [' 1.4 ', 1.4],
    ['4,000.50', 4000.5],
    ['4.000,50', 4000.5],
    ['1.403412345678', 1.40341235],
    ['', null],
    ['   ', null],
    ['0', 'invalid'],
    ['0.000000001', 'invalid'],
    ['-1.4', 'invalid'],
    ['1.4x', 'invalid'],
    ['abc', 'invalid'],
    ['1.2.3', 'invalid'],
    ['1,2,3', 'invalid'],
    ['12,34.5', 'invalid'],
    ['.', 'invalid'],
    [',', 'invalid'],
    ['1e3', 'invalid'],
    ['10000000000', 'invalid']
  ])('"%s" → %s', (text, expected) => {
    expect(parseRateText(text)).toBe(expected)
  })

  it('rateBoxText writes at least four decimals and all a rate has', () => {
    expect(rateBoxText(1.4)).toBe('1.4000')
    expect(rateBoxText(1.4034)).toBe('1.4034')
    expect(rateBoxText(1.40341235)).toBe('1.40341235')
    expect(rateBoxText(0.00034123)).toBe('0.00034123')
    for (const r of [1.4, 1.4034, 0.00034123, 4000.5]) expect(parseRateText(rateBoxText(r))).toBe(r)
  })
})

describe('mainDigits — an amount is stored with two decimals at most', () => {
  it('follows the currency up to two', () => {
    expect(mainDigits('CAD')).toBe(2)
    expect(mainDigits('CLP')).toBe(0)
    expect(mainDigits('KWD')).toBe(2)
  })
})

describe('fxView — the two boxes and what they come to', () => {
  describe('nothing typed', () => {
    it('with the day’s rate: the rate, the converted amount and where it is from', () => {
      expect(view({ auto: ecb })).toEqual({
        rateText: '1.4034',
        convertedText: '16.84',
        rate: 1.4034,
        converted: 16.84,
        origin: { how: 'service', asOf: '2026-11-13' },
        rateProblem: null,
        convertedProblem: null
      })
      expect(view({ auto: { ...ecb, source: 'last' } }).origin).toEqual({ how: 'last', asOf: '2026-11-13' })
      expect(view({ auto: { ...ecb, source: 'cache' } }).origin).toEqual({ how: 'cache', asOf: '2026-11-13' })
    })

    it('without a rate: both boxes empty, and it can’t be saved (never as if it were the main currency)', () => {
      expect(view()).toEqual({ rateText: '', convertedText: '', rate: null, converted: null, origin: null, rateProblem: required, convertedProblem: null })
    })

    it('with a rate and no amount yet: the rate shows, the converted box waits for the amount', () => {
      expect(view({ auto: ecb, amount: null })).toMatchObject({ rateText: '1.4034', convertedText: '', rate: 1.4034, converted: null, rateProblem: null, convertedProblem: null })
      expect(view({ auto: ecb, amount: 0 })).toMatchObject({ converted: null, convertedText: '' })
    })

    it('converts to the main currency’s own minor units', () => {
      expect(fxView({ typed: null, auto: { ...ecb, rate: 4000.5 }, amount: 12.34, main: 'COP' })).toMatchObject({ convertedText: '49366', converted: 49366 })
      expect(fxView({ typed: null, auto: { ...ecb, rate: 0.30725 }, amount: 1, main: 'KWD' })).toMatchObject({ converted: 0.31 })
    })

    it('an amount that comes to nothing at that rate is a problem of the converted box', () => {
      expect(view({ auto: { ...ecb, rate: 0.0001 }, amount: 12 })).toMatchObject({ rate: 0.0001, converted: null, convertedText: '0.00', convertedProblem: { key: 'field.convertedZero' } })
      expect(view({ auto: { ...ecb, rate: 1000 }, amount: 99_999_999 })).toMatchObject({ converted: null, convertedProblem: { key: 'field.tooBig' } })
    })

    it('the rate typed for every row without one (the review) comes after a fetched one', () => {
      expect(view({ all: 1.4 })).toMatchObject({ rateText: '1.4000', converted: 16.8, origin: { how: 'typedAll' } })
      expect(view({ all: 1.4, auto: ecb })).toMatchObject({ converted: 16.84, origin: { how: 'service', asOf: '2026-11-13' } })
    })
  })

  describe('the rate saved with the expense being edited', () => {
    const stored: FxStored = { rate: 1.4034, converted: 17.25, original: 12 }

    it('stands as saved while the amount is untouched: what the bank charged is not recomputed', () => {
      expect(view({ stored })).toMatchObject({ rateText: '1.4034', convertedText: '17.25', rate: 1.4034, converted: 17.25, origin: { how: 'stored' } })
    })

    it('a new amount is converted with the saved rate', () => {
      expect(view({ stored, amount: 20 })).toMatchObject({ rate: 1.4034, converted: 28.07, origin: { how: 'stored' } })
      expect(view({ stored, amount: null })).toMatchObject({ rate: 1.4034, converted: null, convertedText: '' })
    })

    it('comes before a fetched rate, and after what the user typed', () => {
      expect(view({ stored, auto: { ...ecb, rate: 1.5 } })).toMatchObject({ rate: 1.4034, converted: 17.25 })
      expect(view({ stored, typed: { lead: 'rate', text: '1.5' } })).toMatchObject({ rate: 1.5, converted: 18, origin: { how: 'typed' } })
    })
  })

  describe('the user types the rate', () => {
    it('the converted amount follows it, whatever was fetched', () => {
      expect(view({ typed: { lead: 'rate', text: '1.5' }, auto: ecb })).toEqual({
        rateText: '1.5',
        convertedText: '18.00',
        rate: 1.5,
        converted: 18,
        origin: { how: 'typed' },
        rateProblem: null,
        convertedProblem: null
      })
    })

    it('the box keeps exactly what was typed, a decimal comma too', () => {
      expect(view({ typed: { lead: 'rate', text: '1,40' } })).toMatchObject({ rateText: '1,40', rate: 1.4, converted: 16.8 })
      expect(view({ typed: { lead: 'rate', text: '1.' } })).toMatchObject({ rateText: '1.', rate: 1, converted: 12 })
    })

    it('something that is no rate: said next to the box, and nothing to save', () => {
      expect(view({ typed: { lead: 'rate', text: 'abc' } })).toMatchObject({ rateText: 'abc', convertedText: '', rate: null, converted: null, rateProblem: { key: 'field.rateInvalid' } })
      expect(view({ typed: { lead: 'rate', text: '0' } })).toMatchObject({ rate: null, rateProblem: { key: 'field.rateInvalid' } })
    })

    it('emptied while still in the box: both empty, so a new rate can be typed from scratch', () => {
      expect(view({ typed: { lead: 'rate', text: '' }, auto: ecb })).toEqual({ rateText: '', convertedText: '', rate: null, converted: null, origin: null, rateProblem: required, convertedProblem: null })
    })
  })

  describe('the user types the amount in the main currency (what the bank charged)', () => {
    it('the rate follows it', () => {
      expect(view({ typed: { lead: 'converted', text: '17.25' }, auto: ecb })).toEqual({
        rateText: '1.4375',
        convertedText: '17.25',
        rate: 1.4375,
        converted: 17.25,
        origin: { how: 'typed' },
        rateProblem: null,
        convertedProblem: null
      })
      expect(view({ typed: { lead: 'converted', text: '16,84' } })).toMatchObject({ convertedText: '16,84', converted: 16.84, rate: 1.40333333, rateText: '1.40333333' })
    })

    it('the rate changes with the amount paid; the amount typed stays', () => {
      expect(view({ typed: { lead: 'converted', text: '17.25' }, amount: 12.5 })).toMatchObject({ converted: 17.25, rate: 1.38 })
    })

    it('without the amount paid there is no rate yet (the amount box says what is missing)', () => {
      expect(view({ typed: { lead: 'converted', text: '17.25' }, amount: null })).toMatchObject({ convertedText: '17.25', converted: 17.25, rate: null, rateText: '', rateProblem: null, convertedProblem: null })
    })

    it('says what is wrong with it: not a number, nothing, cents the currency doesn’t have, too much', () => {
      expect(view({ typed: { lead: 'converted', text: 'abc' } })).toMatchObject({ converted: null, rate: null, convertedProblem: { key: 'field.resultInvalid' } })
      expect(view({ typed: { lead: 'converted', text: '0' } })).toMatchObject({ converted: null, convertedProblem: { key: 'field.convertedRequired', vars: { currency: 'CAD' } } })
      expect(view({ typed: { lead: 'converted', text: '0.004' } })).toMatchObject({ converted: null, convertedProblem: { key: 'field.convertedZero' } })
      expect(view({ typed: { lead: 'converted', text: '100000001' } })).toMatchObject({ converted: null, convertedProblem: { key: 'field.tooBig' } })
      expect(fxView({ typed: { lead: 'converted', text: '4,5' }, amount: 12, main: 'CLP' })).toMatchObject({ convertedProblem: { key: 'field.noMinorUnits', vars: { currency: 'CLP' } } })
    })

    it('an amount so small next to what was paid that no rate fits is refused', () => {
      expect(view({ typed: { lead: 'converted', text: '0.01' }, amount: 99_999_999 })).toMatchObject({ rate: null, convertedProblem: { key: 'field.rateInvalid' } })
    })

    it('emptied while still in the box: both empty', () => {
      expect(view({ typed: { lead: 'converted', text: ' ' }, auto: ecb })).toMatchObject({ rateText: '', convertedText: '', rate: null, converted: null, rateProblem: required })
    })
  })

  describe('what a scanned picture says the card was charged in the main currency', () => {
    const charged = chargedFx({ amount: 16.95, currency: 'CAD', paid: 12 }, 'CAD') as FxStored

    it('is the converted amount as charged, with the rate behind it', () => {
      expect(view({ charged })).toMatchObject({ rateText: '1.4125', convertedText: '16.95', rate: 1.4125, converted: 16.95, origin: { how: 'charged' } })
    })

    it('a new amount paid is converted at that rate', () => {
      expect(view({ charged, amount: 20 })).toMatchObject({ rate: 1.4125, converted: 28.25, origin: { how: 'charged' } })
    })

    it('comes before a fetched rate and the rate typed for all rows, and after what the user typed', () => {
      expect(view({ charged, auto: ecb, all: 1.5 })).toMatchObject({ rate: 1.4125, converted: 16.95 })
      expect(view({ charged, typed: { lead: 'converted', text: '17' } })).toMatchObject({ converted: 17, origin: { how: 'typed' } })
    })
  })

  it('settledFx: a box left empty is no longer typed in; anything else stays', () => {
    expect(settledFx({ lead: 'rate', text: '' })).toBeNull()
    expect(settledFx({ lead: 'converted', text: '  ' })).toBeNull()
    expect(settledFx(null)).toBeNull()
    const typed = { lead: 'rate' as const, text: '1.5' }
    expect(settledFx(typed)).toBe(typed)
    const bad = { lead: 'rate' as const, text: 'abc' }
    expect(settledFx(bad)).toBe(bad)
  })
})

describe('chargedFx — what the card was charged, as a rate', () => {
  it('charged in the main currency: that amount, and converted ÷ paid to 8 decimals', () => {
    expect(chargedFx({ amount: 16.95, currency: 'CAD', paid: 12 }, 'CAD')).toEqual({ rate: 1.4125, converted: 16.95, original: 12 })
    expect(chargedFx({ amount: 17, currency: 'CAD', paid: 12 }, 'CAD')).toEqual({ rate: 1.41666667, converted: 17, original: 12 })
  })

  it('none when it was charged in another currency, there is no charge, or no rate the app can store comes out', () => {
    expect(chargedFx({ amount: 16.95, currency: 'EUR', paid: 12 }, 'CAD')).toBeNull()
    expect(chargedFx(null, 'CAD')).toBeNull()
    expect(chargedFx({ amount: 16.95, currency: 'CAD', paid: 0 }, 'CAD')).toBeNull()
    expect(chargedFx({ amount: 0, currency: 'CAD', paid: 12 }, 'CAD')).toBeNull()
    // Past the rate column's room.
    expect(chargedFx({ amount: 99_000_000, currency: 'CAD', paid: 0.01 }, 'CAD')).toBeNull()
  })

  it('rateKey: a currency and a day', () => {
    expect(rateKey('USD', '2026-11-13')).toBe('USD@2026-11-13')
  })
})

describe('fxInput — what is saved', () => {
  it('the amount in the main currency, what was paid, in what, and the rate', () => {
    const input = fxInput(view({ auto: ecb }), 12, 'USD', false)
    expect(input).toEqual({ amount: 16.84, originalAmount: 12, originalCurrency: 'USD', fxRate: 1.4034 })
    expect(normalizeExpense({ date: '2026-11-13', ...input })).toMatchObject(input)
  })

  it('a refund is negative in both amounts; the rate never is', () => {
    expect(fxInput(view({ auto: ecb }), 12, 'USD', true)).toEqual({ amount: -16.84, originalAmount: -12, originalCurrency: 'USD', fxRate: 1.4034 })
  })

  it('what the bank charged is saved as typed, with the rate it implies', () => {
    const input = fxInput(view({ typed: { lead: 'converted', text: '17.25' } }), 12, 'USD', false)
    expect(input).toEqual({ amount: 17.25, originalAmount: 12, originalCurrency: 'USD', fxRate: 1.4375 })
    expect(() => normalizeExpense({ date: '2026-11-13', ...input })).not.toThrow()
  })

  it('without a rate nothing valid comes out: the app’s checks refuse it', () => {
    expect(() => normalizeExpense({ date: '2026-11-13', ...fxInput(view(), 12, 'USD', false) })).toThrow()
  })

  it('NO_ORIGINAL: an expense in the main currency keeps none of the three', () => {
    expect(NO_ORIGINAL).toEqual({ originalAmount: null, originalCurrency: null, fxRate: null })
  })
})

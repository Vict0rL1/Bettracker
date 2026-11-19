import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  cachedRate,
  cacheKey,
  convert,
  emptyCache,
  FX_CACHE_MAX,
  FX_FRESH_MS,
  FX_ORIGIN,
  isCode,
  isDate,
  isRate,
  isSettled,
  lastRate,
  MAX_RATE,
  parseRateBody,
  rateDay,
  rateFrom,
  rateText,
  rateUrl,
  readCache,
  roundRate,
  withRate,
  type CachedRate,
  type FxCache
} from './fx'

const DAY = 24 * 60 * 60 * 1000
const at = (date: string, hour = 12): number => Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00.000Z`)

describe('the module stands alone (the live rates check compiles this one file)', () => {
  const source = readFileSync(new URL('./fx.ts', import.meta.url), 'utf8')

  it('has no import and no re-export', () => {
    expect(source).not.toMatch(/^\s*import\s|^\s*export\s[^=]*\sfrom\s/m)
  })

  it('uses no API of one runtime only: no DOM, no network, no storage', () => {
    expect(source).not.toMatch(/\b(Buffer|process|require|Deno|window|document|localStorage|navigator|fetch|XMLHttpRequest)\b/)
  })
})

describe('rateUrl — what is asked of the service', () => {
  it('asks for a past day by its date', () => {
    expect(rateUrl('USD', 'CAD', '2026-11-13', '2026-11-18')).toBe('https://api.frankfurter.dev/v1/2026-11-13?base=USD&symbols=CAD')
  })

  it('asks for the latest rate for today and for any later day', () => {
    expect(rateUrl('USD', 'CAD', '2026-11-18', '2026-11-18')).toBe('https://api.frankfurter.dev/v1/latest?base=USD&symbols=CAD')
    expect(rateUrl('EUR', 'MXN', '2026-12-01', '2026-11-18')).toBe('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=MXN')
  })

  it('carries two currency codes and a date, and nothing else', () => {
    const url = new URL(rateUrl('USD', 'CAD', '2026-11-13', '2026-11-18') as string)
    expect(url.origin).toBe(FX_ORIGIN)
    expect([...url.searchParams.keys()]).toEqual(['base', 'symbols'])
    expect(url.pathname).toBe('/v1/2026-11-13')
    expect(url.hash).toBe('')
    expect(url.username + url.password).toBe('')
  })

  it('makes no request out of anything that is not a code or a date', () => {
    expect(rateUrl('usd', 'CAD', '2026-11-13', '2026-11-18')).toBeNull()
    expect(rateUrl('USD', 'CA', '2026-11-13', '2026-11-18')).toBeNull()
    expect(rateUrl('USD', 'CAD&x=1', '2026-11-13', '2026-11-18')).toBeNull()
    expect(rateUrl('USD', 'CAD', '2026-02-30', '2026-11-18')).toBeNull()
    expect(rateUrl('USD', 'CAD', '13/11/2026', '2026-11-18')).toBeNull()
    expect(rateUrl('USD', 'CAD', '../latest', '2026-11-18')).toBeNull()
    expect(rateUrl('USD', 'CAD', '2026-11-13', 'today')).toBeNull()
  })

  it('rateDay: a past day is itself, today and later are today', () => {
    expect(rateDay('2026-11-13', '2026-11-18')).toBe('2026-11-13')
    expect(rateDay('2026-11-18', '2026-11-18')).toBe('2026-11-18')
    expect(rateDay('2027-01-01', '2026-11-18')).toBe('2026-11-18')
  })
})

describe('isCode, isDate, isRate', () => {
  it('a code is three capital letters', () => {
    expect(isCode('USD')).toBe(true)
    for (const bad of ['usd', 'US', 'USDT', 'U$D', ' USD', '', null, 840]) expect(isCode(bad), String(bad)).toBe(false)
  })

  it('a date is a calendar day that exists', () => {
    expect(isDate('2026-11-13')).toBe(true)
    expect(isDate('2028-02-29')).toBe(true)
    for (const bad of ['2026-02-29', '2026-13-01', '2026-11-31', '2026-1-3', '20261113', 'latest', '', null, 20261113]) expect(isDate(bad), String(bad)).toBe(false)
  })

  it('a rate is a finite number above 0 once rounded to 8 decimals, with room in the column', () => {
    for (const ok of [1.4034, 0.00000001, 0.000341, 4000.5, MAX_RATE]) expect(isRate(ok), String(ok)).toBe(true)
    for (const bad of [0, -1.4, 0.000000004, Infinity, NaN, MAX_RATE + 1, '1.4', null, undefined]) expect(isRate(bad), String(bad)).toBe(false)
  })

  it('roundRate keeps 8 decimals, half up, without binary dust', () => {
    expect(roundRate(1.403412345678)).toBe(1.40341235)
    expect(roundRate(0.1 + 0.2)).toBe(0.3)
    expect(roundRate(1.000000005)).toBe(1.00000001)
    expect(roundRate(1.4034)).toBe(1.4034)
  })
})

describe('parseRateBody — the service’s answer, checked', () => {
  const body = (over: Record<string, unknown> = {}) => ({ amount: 1.0, base: 'USD', date: '2026-11-13', rates: { CAD: 1.4034 }, ...over })

  it('reads the rate of the pair asked for and the day it is of', () => {
    expect(parseRateBody(body(), 'USD', 'CAD')).toEqual({ rate: 1.4034, asOf: '2026-11-13' })
  })

  it('reads the answer as the service writes it (JSON text, the amount as 1.0)', () => {
    const text = '{"amount":1.0,"base":"USD","date":"2026-11-13","rates":{"CAD":1.4034}}'
    expect(parseRateBody(JSON.parse(text), 'USD', 'CAD')).toEqual({ rate: 1.4034, asOf: '2026-11-13' })
  })

  it('takes the rate per unit when the answer is for another amount, and 1 when it names none', () => {
    expect(parseRateBody(body({ amount: 10, rates: { CAD: 14.034 } }), 'USD', 'CAD')).toEqual({ rate: 1.4034, asOf: '2026-11-13' })
    const { amount: _none, ...noAmount } = body()
    expect(parseRateBody(noAmount, 'USD', 'CAD')).toEqual({ rate: 1.4034, asOf: '2026-11-13' })
  })

  it('rounds a long rate to the 8 decimals it is stored with', () => {
    expect(parseRateBody(body({ rates: { CAD: 1.403412345678 } }), 'USD', 'CAD')?.rate).toBe(1.40341235)
  })

  it('ignores the other currencies of an answer that holds more', () => {
    expect(parseRateBody(body({ rates: { EUR: 0.86, CAD: 1.4034, MXN: 18.3 } }), 'USD', 'CAD')?.rate).toBe(1.4034)
  })

  it('has no rate when the shape is wrong: never a guess', () => {
    const bad: unknown[] = [
      null,
      undefined,
      'text',
      42,
      [],
      [body()],
      {},
      { message: 'not found' },
      body({ rates: undefined }),
      body({ rates: null }),
      body({ rates: [] }),
      body({ rates: [1.4034] }),
      body({ rates: {} }),
      body({ rates: { EUR: 0.86 } }),
      body({ rates: { cad: 1.4034 } }),
      body({ rates: { CAD: '1.4034' } }),
      body({ rates: { CAD: null } }),
      body({ rates: { CAD: 0 } }),
      body({ rates: { CAD: -1.4034 } }),
      body({ rates: { CAD: Number.NaN } }),
      body({ rates: { CAD: Number.POSITIVE_INFINITY } }),
      body({ rates: { CAD: 0.000000001 } }),
      body({ rates: { CAD: 1e12 } }),
      body({ base: 'EUR' }),
      body({ base: undefined }),
      body({ base: 'usd' }),
      body({ date: undefined }),
      body({ date: 'latest' }),
      body({ date: '2026-02-30' }),
      body({ date: 20261113 }),
      body({ amount: 0 }),
      body({ amount: -1 }),
      body({ amount: '1' }),
      body({ amount: null })
    ]
    for (const b of bad) expect(parseRateBody(b, 'USD', 'CAD'), JSON.stringify(b)).toBeNull()
  })

  it('does not take a rate from the prototype chain', () => {
    const rates = Object.create({ CAD: 1.4034 }) as Record<string, number>
    expect(parseRateBody(body({ rates }), 'USD', 'CAD')).toBeNull()
    expect(parseRateBody(body({ rates: {} }), 'USD', 'constructor')).toBeNull()
  })

  it('answers only for codes that are codes', () => {
    expect(parseRateBody(body(), 'usd', 'CAD')).toBeNull()
    expect(parseRateBody(body({ rates: { toString: 1 } }), 'USD', 'toString')).toBeNull()
  })
})

describe('convert — the original at a rate, in the main currency', () => {
  it('multiplies and rounds to cents', () => {
    expect(convert(12, 1.4034, 2)).toBe(16.84)
    expect(convert(12, 1.4, 2)).toBe(16.8)
    expect(convert(100, 1.4034, 2)).toBe(140.34)
    expect(convert(4.5, 1.4034, 2)).toBe(6.32)
  })

  it('rounds half up in whole numbers: no binary dust decides a cent', () => {
    // 1.15 × 1.5 = 1.725 exactly; in floating point it is 1.7249999999999999 and would round down.
    expect(1.15 * 1.5).toBeLessThan(1.725)
    expect(convert(1.15, 1.5, 2)).toBe(1.73)
    expect(convert(0.01, 0.5, 2)).toBe(0.01)
    expect(convert(0.01, 0.49999999, 2)).toBe(0)
    expect(convert(2.675, 1, 2)).toBe(2.68)
    expect(convert(1.005, 1, 2)).toBe(1.01)
  })

  it('rounds to the main currency’s own minor units', () => {
    expect(convert(12, 4000.5, 0)).toBe(48006)
    expect(convert(12.34, 4000.5, 0)).toBe(49366)
    expect(convert(1, 0.5, 0)).toBe(1)
    // An amount is stored with two decimals at most, whatever the currency has.
    expect(convert(1, 0.30725, 3)).toBe(0.31)
  })

  it('keeps the sign of the original: a refund stays a refund', () => {
    expect(convert(-12, 1.4034, 2)).toBe(-16.84)
    expect(Object.is(convert(-0.001, 1.4, 2), -0)).toBe(false)
    expect(convert(-0.001, 1.4, 2)).toBe(0)
  })

  it('handles the largest amounts and small rates without losing a cent', () => {
    expect(convert(100_000_000, 1.40341235, 2)).toBe(140_341_235)
    expect(convert(99_999_999.99, 1.00000001, 2)).toBe(100_000_000.99)
    expect(convert(12_500, 0.00034123, 2)).toBe(4.27)
    expect(convert(1_000_000, 0.00000001, 2)).toBe(0.01)
  })

  it('is NaN for what is no number or no rate', () => {
    expect(convert(Number.NaN, 1.4, 2)).toBeNaN()
    expect(convert(12, Number.NaN, 2)).toBeNaN()
    expect(convert(12, Number.POSITIVE_INFINITY, 2)).toBeNaN()
    expect(convert(12, -1.4, 2)).toBeNaN()
    expect(convert(12, 1.4, 1.5)).toBeNaN()
  })
})

describe('rateFrom — the rate behind what the bank charged', () => {
  it('is converted ÷ original, to 8 decimals', () => {
    expect(rateFrom(12, 16.84)).toBe(1.40333333)
    expect(rateFrom(12, 16.8)).toBe(1.4)
    expect(rateFrom(100, 140.34)).toBe(1.4034)
    expect(rateFrom(3, 1)).toBe(0.33333333)
    expect(rateFrom(3, 2)).toBe(0.66666667)
  })

  it('leaves the signs out: a refund has the rate of a purchase', () => {
    expect(rateFrom(-12, -16.8)).toBe(1.4)
    expect(rateFrom(-12, 16.8)).toBe(1.4)
  })

  it('gives back the amount it came from', () => {
    for (const [original, converted] of [
      [12, 16.84],
      [4.5, 6.32],
      [19.99, 28.05],
      [1234.56, 1732.57],
      [0.99, 1.39],
      [12500, 4.27]
    ] as const) {
      const rate = rateFrom(original, converted) as number
      expect(convert(original, rate, 2), `${original} → ${converted}`).toBe(converted)
    }
  })

  it('is null without an original, and 0 when the amount is nothing next to it (which no box accepts)', () => {
    expect(rateFrom(0, 16.8)).toBeNull()
    expect(rateFrom(0.004, 16.8)).toBeNull()
    expect(rateFrom(Number.NaN, 16.8)).toBeNull()
    expect(rateFrom(12, Number.POSITIVE_INFINITY)).toBeNull()
    expect(rateFrom(100_000_000, 0.01)).toBe(0)
    expect(isRate(rateFrom(100_000_000, 0.01))).toBe(false)
  })
})

describe('rateText — a rate in a box or a line', () => {
  it('drops the zeros that say nothing, keeping at least the decimals asked for', () => {
    expect(rateText(1.4034)).toBe('1.4034')
    expect(rateText(1.4)).toBe('1.4')
    expect(rateText(1.4, 4)).toBe('1.4000')
    expect(rateText(2)).toBe('2')
    expect(rateText(2, 2)).toBe('2.00')
    expect(rateText(0.00034123)).toBe('0.00034123')
    expect(rateText(1.40341235, 4)).toBe('1.40341235')
    expect(rateText(4000.5)).toBe('4000.5')
  })
})

describe('the cache', () => {
  const entry = (rate: number, asOf: string, fetched: number): CachedRate => ({ rate, asOf, at: fetched })
  const put = (c: FxCache, from: string, to: string, day: string, e: CachedRate, max?: number): FxCache => withRate(c, from, to, day, e, max)

  it('is keyed by pair and the day asked for', () => {
    expect(cacheKey('USD', 'CAD', '2026-11-13')).toBe('USD>CAD@2026-11-13')
    const c = put(emptyCache(), 'USD', 'CAD', '2026-11-13', entry(1.4034, '2026-11-13', at('2026-11-18')))
    expect(Object.keys(c.rates)).toEqual(['USD>CAD@2026-11-13'])
    expect(cachedRate(c, 'USD', 'CAD', '2026-11-13', at('2026-11-18'))?.entry.rate).toBe(1.4034)
    expect(cachedRate(c, 'CAD', 'USD', '2026-11-13', at('2026-11-18'))).toBeNull()
    expect(cachedRate(c, 'USD', 'CAD', '2026-11-12', at('2026-11-18'))).toBeNull()
    expect(cachedRate(c, 'EUR', 'CAD', '2026-11-13', at('2026-11-18'))).toBeNull()
  })

  it('never changes the cache it was given', () => {
    const before = emptyCache()
    put(before, 'USD', 'CAD', '2026-11-13', entry(1.4, '2026-11-13', 1))
    expect(before).toEqual({ v: 1, rates: {} })
  })

  describe('a settled rate is used for good; one that may be replaced, for a few hours', () => {
    it('the rate of the very day asked for is settled, however long ago it was fetched', () => {
      const e = entry(1.4034, '2026-11-13', at('2026-11-13', 17))
      expect(isSettled(e, '2026-11-13')).toBe(true)
      const c = put(emptyCache(), 'USD', 'CAD', '2026-11-13', e)
      expect(cachedRate(c, 'USD', 'CAD', '2026-11-13', at('2027-11-13'))).toEqual({ entry: e, fresh: true })
    })

    it('a weekend keeps the Friday rate for good once the weekend is well past', () => {
      // Asked on Tuesday for Saturday the 14th: Friday's rate, and nothing newer can come for that Saturday.
      const e = entry(1.4034, '2026-11-13', at('2026-11-17'))
      expect(isSettled(e, '2026-11-14')).toBe(true)
    })

    it('this morning’s latest (still yesterday’s rate) is used for six hours, then asked for again', () => {
      const fetched = at('2026-11-18', 8)
      const e = entry(1.4034, '2026-11-17', fetched)
      expect(isSettled(e, '2026-11-18')).toBe(false)
      const c = put(emptyCache(), 'USD', 'CAD', '2026-11-18', e)
      expect(cachedRate(c, 'USD', 'CAD', '2026-11-18', fetched + FX_FRESH_MS - 1)?.fresh).toBe(true)
      // Stale, but still there: it is what is used when the service can't be reached.
      expect(cachedRate(c, 'USD', 'CAD', '2026-11-18', fetched + FX_FRESH_MS)).toEqual({ entry: e, fresh: false })
    })

    it('a day asked for before its rate could be out is not settled until two days after it', () => {
      // Sunday's Friday rate fetched on the Sunday itself: may still be… Friday's, for good, but that is only known later.
      const e = entry(1.4034, '2026-11-13', at('2026-11-15', 10))
      expect(isSettled(e, '2026-11-15')).toBe(false)
      expect(isSettled({ ...e, at: at('2026-11-17', 0) }, '2026-11-15')).toBe(true)
      expect(isSettled({ ...e, at: at('2026-11-16', 23) }, '2026-11-15')).toBe(false)
    })

    it('a clock set back never makes a stale rate fresh', () => {
      const e = entry(1.4034, '2026-11-17', at('2026-11-18', 8))
      const c = put(emptyCache(), 'USD', 'CAD', '2026-11-18', e)
      expect(cachedRate(c, 'USD', 'CAD', '2026-11-18', at('2026-11-18', 8) - 1000)?.fresh).toBe(false)
    })
  })

  describe('lastRate — the newest of a pair, for when the service can’t be reached', () => {
    it('is the one of the latest day, then the one fetched last', () => {
      let c = emptyCache()
      c = put(c, 'USD', 'CAD', '2026-11-10', entry(1.39, '2026-11-10', at('2026-11-18', 9)))
      c = put(c, 'USD', 'CAD', '2026-11-13', entry(1.4034, '2026-11-13', at('2026-11-14')))
      c = put(c, 'USD', 'CAD', '2026-11-14', entry(1.4035, '2026-11-13', at('2026-11-17')))
      c = put(c, 'EUR', 'CAD', '2026-11-17', entry(1.62, '2026-11-17', at('2026-11-18')))
      expect(lastRate(c, 'USD', 'CAD')).toEqual(entry(1.4035, '2026-11-13', at('2026-11-17')))
      expect(lastRate(c, 'EUR', 'CAD')?.rate).toBe(1.62)
      expect(lastRate(c, 'CAD', 'USD')).toBeNull()
      expect(lastRate(emptyCache(), 'USD', 'CAD')).toBeNull()
    })
  })

  describe('pruning', () => {
    it('keeps at most the cap, dropping the ones fetched longest ago', () => {
      let c = emptyCache()
      for (let i = 0; i < 6; i++) c = put(c, 'USD', 'CAD', `2026-11-0${i + 1}`, entry(1.4 + i / 100, `2026-11-0${i + 1}`, 1000 + i), 4)
      expect(Object.keys(c.rates).sort()).toEqual(['USD>CAD@2026-11-03', 'USD>CAD@2026-11-04', 'USD>CAD@2026-11-05', 'USD>CAD@2026-11-06'])
    })

    it('a rate fetched again replaces its entry without counting twice', () => {
      let c = emptyCache()
      c = put(c, 'USD', 'CAD', '2026-11-18', entry(1.4, '2026-11-17', 1000), 2)
      c = put(c, 'EUR', 'CAD', '2026-11-18', entry(1.62, '2026-11-17', 1001), 2)
      c = put(c, 'USD', 'CAD', '2026-11-18', entry(1.41, '2026-11-18', 2000), 2)
      expect(Object.keys(c.rates).sort()).toEqual(['EUR>CAD@2026-11-18', 'USD>CAD@2026-11-18'])
      expect(c.rates['USD>CAD@2026-11-18'].rate).toBe(1.41)
    })

    it('the newest rate of a pair in use outlives older ones of other pairs', () => {
      let c = emptyCache()
      for (let i = 0; i < FX_CACHE_MAX + 20; i++) {
        const day = new Date(Date.UTC(2025, 0, 1) + i * DAY).toISOString().slice(0, 10)
        c = put(c, 'EUR', 'CAD', day, entry(1.5, day, i))
      }
      c = put(c, 'USD', 'CAD', '2026-11-18', entry(1.4, '2026-11-18', FX_CACHE_MAX + 100))
      expect(Object.keys(c.rates)).toHaveLength(FX_CACHE_MAX)
      expect(lastRate(c, 'USD', 'CAD')?.rate).toBe(1.4)
    })
  })

  describe('readCache — whatever storage held', () => {
    const good = { v: 1, rates: { 'USD>CAD@2026-11-13': { rate: 1.4034, asOf: '2026-11-13', at: 1000 } } }

    it('reads back what was written', () => {
      expect(readCache(JSON.parse(JSON.stringify(good)))).toEqual(good)
      const c = put(emptyCache(), 'USD', 'CAD', '2026-11-13', entry(1.4034, '2026-11-13', 1000))
      expect(readCache(JSON.parse(JSON.stringify(c)))).toEqual(c)
    })

    it('is empty for another version or another shape', () => {
      for (const raw of [null, undefined, 'x', 3, [], { v: 2, rates: good.rates }, { rates: good.rates }, { v: 1 }, { v: 1, rates: [] }, { v: 1, rates: 'x' }]) {
        expect(readCache(raw), JSON.stringify(raw)).toEqual(emptyCache())
      }
    })

    it('drops a broken entry and keeps the rest', () => {
      const raw = {
        v: 1,
        rates: {
          ...good.rates,
          'USD>CAD@2026-02-30': { rate: 1.4, asOf: '2026-02-27', at: 1 },
          'usd>cad@2026-11-13': { rate: 1.4, asOf: '2026-11-13', at: 1 },
          'USD-CAD-2026-11-13': { rate: 1.4, asOf: '2026-11-13', at: 1 },
          'EUR>CAD@2026-11-13': { rate: '1.62', asOf: '2026-11-13', at: 1 },
          'GBP>CAD@2026-11-13': { rate: 0, asOf: '2026-11-13', at: 1 },
          'MXN>CAD@2026-11-13': { rate: 0.07, asOf: 'yesterday', at: 1 },
          'JPY>CAD@2026-11-13': { rate: 0.009, asOf: '2026-11-13' },
          'CHF>CAD@2026-11-13': null,
          'AUD>CAD@2026-11-13': { rate: 0.91, asOf: '2026-11-13', at: 5, extra: 'left out' }
        }
      }
      expect(readCache(raw)).toEqual({ v: 1, rates: { ...good.rates, 'AUD>CAD@2026-11-13': { rate: 0.91, asOf: '2026-11-13', at: 5 } } })
    })
  })
})

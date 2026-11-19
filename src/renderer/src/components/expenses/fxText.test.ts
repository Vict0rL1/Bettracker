import { beforeEach, describe, expect, it } from 'vitest'
import { setLang, t } from '../../lib/i18n'
import { originLine, rateDate } from './fxText'

const TODAY = '2026-11-18'
const line = (o: Partial<Parameters<typeof originLine>[0]>) => originLine({ origin: null, state: undefined, from: 'USD', to: 'CAD', today: TODAY, t, ...o })

beforeEach(() => setLang('en'))

describe('rateDate — the day a rate is of, in words', () => {
  it('is short within this year, and says the year otherwise', () => {
    expect(rateDate('2026-11-13', TODAY)).toBe('Nov 13')
    expect(rateDate('2025-12-31', TODAY)).toBe('Dec 31, 2025')
    expect(rateDate('2026-12-31', '2027-01-02')).toBe('Dec 31, 2026')
  })

  it('follows the language', () => {
    setLang('es')
    expect(rateDate('2026-11-13', TODAY)).toBe('13 nov')
  })
})

describe('originLine — where the rate on screen comes from, or why there is none', () => {
  it('the service’s rate of a day, and this device’s copy of it, read the same', () => {
    expect(line({ origin: { how: 'service', asOf: '2026-11-13' }, state: { ok: true, rate: 1.4, asOf: '2026-11-13', source: 'service' } })).toBe('Rate of Nov 13 (ECB)')
    expect(line({ origin: { how: 'cache', asOf: '2026-11-13' } })).toBe('Rate of Nov 13 (ECB)')
  })

  it('names the bank as each language does', () => {
    setLang('es')
    expect(line({ origin: { how: 'service', asOf: '2026-11-13' } })).toBe('Tasa del 13 nov (BCE)')
  })

  it('a saved rate used because the service can’t be reached says which day it is of', () => {
    expect(line({ origin: { how: 'last', asOf: '2026-11-10' } })).toBe('The rate service can’t be reached: using the saved rate of Nov 10.')
  })

  it('what the user typed wins over everything, even while a rate is asked for', () => {
    expect(line({ origin: { how: 'typed' }, state: 'loading' })).toBe('Typed by you. Empty the box to get the day’s rate back.')
    expect(line({ origin: { how: 'typed' }, kept: true })).toBe('Typed by you. Empty the box to get the day’s rate back.')
  })

  it('says a rate is being fetched, in words, whatever stands in the boxes meanwhile', () => {
    expect(line({ state: 'loading' })).toBe('Getting the rate…')
    expect(line({ origin: { how: 'stored' }, state: 'loading', kept: true })).toBe('Getting the rate…')
  })

  it('the rate saved with the expense: as it is, or kept because the new date’s couldn’t be had', () => {
    expect(line({ origin: { how: 'stored' } })).toBe('Saved with this expense.')
    expect(line({ origin: { how: 'stored' }, kept: true, state: { ok: false, reason: 'offline' } })).toBe('The rate for this date couldn’t be fetched: this is the one saved with the expense.')
  })

  it('no rate: why, and what to type instead', () => {
    expect(line({ state: { ok: false, reason: 'offline' } })).toBe('No connection, and no saved rate for USD. Type the rate, or the amount in CAD.')
    expect(line({ state: { ok: false, reason: 'unsupported' } })).toBe('No rate is published for USD to CAD. Type the rate, or the amount in CAD.')
    expect(line({ state: { ok: false, reason: 'unavailable' } })).toBe('The rate couldn’t be fetched. Type the rate, or the amount in CAD.')
  })

  it('the review’s rate for every row without one', () => {
    expect(line({ origin: { how: 'typedAll' }, state: { ok: false, reason: 'offline' } })).toBe('The rate typed above for rows without one.')
  })

  it('says nothing while a box was emptied and not left, or when no rate is wanted', () => {
    expect(line({ typedEmpty: true })).toBe('')
    expect(line({})).toBe('')
  })
})

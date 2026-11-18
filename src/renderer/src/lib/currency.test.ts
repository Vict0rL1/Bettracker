import { describe, expect, it } from 'vitest'
import { currencyDigits, currencyFormat, currencyName, currencyOptions, currencySymbol, DEFAULT_EXPENSE_CURRENCY, EXPENSE_CURRENCIES } from './currency'

const NBSP = ' '

describe('currencyFormat', () => {
  it('writes amounts with the currency’s symbol and the natural minus in front', () => {
    expect(currencyFormat('EUR').plain(-12.5)).toBe('-€12.50')
    expect(currencyFormat('EUR').plain(1234.5)).toBe('€1,234.50')
    expect(currencyFormat('MXN').plain(1234.5)).toBe('MX$1,234.50')
    expect(currencyFormat('GBP').plain(3)).toBe('£3.00')
    expect(currencyFormat('USD').plain(-45)).toBe('-$45.00')
  })

  it('writes a letter code with a no-break space, in the currency’s own minor digits', () => {
    expect(currencyFormat('ARS').plain(12500)).toBe(`ARS${NBSP}12,500.00`)
    // COP: Intl decides its digits (ISO says 2; recent CLDR data, as in Node 22, says 0).
    expect(currencyFormat('COP').plain(12500)).toBe(`COP${NBSP}12,500${currencyDigits('COP') === 2 ? '.00' : ''}`)
    expect(currencyFormat('CLP').plain(12500)).toBe(`CLP${NBSP}12,500`)
    expect(currencyDigits('CLP')).toBe(0)
    expect(currencyDigits('PYG')).toBe(0)
    expect(currencyDigits('EUR')).toBe(2)
  })

  it('never shows "-0"', () => {
    expect(currencyFormat('EUR').plain(-0.001)).toBe('€0.00')
    expect(currencyFormat('EUR').signed(-0.001)).toBe('€0.00')
  })

  it('signed: a plus for money in, a minus for money out', () => {
    expect(currencyFormat('EUR').signed(12.5)).toBe('+€12.50')
    expect(currencyFormat('EUR').signed(-12.5)).toBe('-€12.50')
  })

  it('compact and axis: the symbol and a trimmed k', () => {
    const eur = currencyFormat('EUR')
    expect(eur.compact(12.4)).toBe('€12')
    expect(eur.compact(1400)).toBe('€1.4k')
    expect(eur.compact(1000)).toBe('€1k')
    expect(eur.compact(-250_400)).toBe('-€250k')
    expect(eur.axis(1250)).toBe('€1.3k')
    expect(eur.axis(-5)).toBe('-€5')
    expect(eur.axis(0)).toBe('€0')
    expect(currencyFormat('ARS').axis(12_000)).toBe(`ARS${NBSP}12k`)
    expect(currencyFormat('ARS').compact(12_000)).toBe(`ARS${NBSP}12k`)
  })

  it('stake: whole units from 1,000, else to the cent; bankroll as plain', () => {
    const mxn = currencyFormat('MXN')
    expect(mxn.stake(1240.4)).toBe('MX$1,240')
    expect(mxn.stake(12.5)).toBe('MX$12.50')
    expect(mxn.bankroll(-2180)).toBe('-MX$2,180.00')
  })

  it('never in units: amounts are shown as they are', () => {
    const f = currencyFormat('EUR')
    expect(f.unit).toBeNull()
    expect(f.scale(12.5)).toBe(12.5)
  })

  it('falls back to dollars for a code that is no currency', () => {
    expect(currencyFormat('dollars').plain(3)).toBe('$3.00')
    expect(currencyFormat('').plain(3)).toBe('$3.00')
    expect(currencyFormat('usd').plain(3)).toBe('$3.00')
    expect(currencyFormat('nope')).toBe(currencyFormat('USD'))
  })

  it('is the same object for the same code (a stable context value)', () => {
    expect(currencyFormat('EUR')).toBe(currencyFormat('EUR'))
    expect(currencyFormat('EUR')).not.toBe(currencyFormat('USD'))
  })
})

describe('the currency list and its words', () => {
  it('offers at least 12 currencies, dollars first and each once', () => {
    expect(EXPENSE_CURRENCIES.length).toBeGreaterThanOrEqual(12)
    expect(EXPENSE_CURRENCIES[0]).toBe(DEFAULT_EXPENSE_CURRENCY)
    expect(new Set(EXPENSE_CURRENCIES).size).toBe(EXPENSE_CURRENCIES.length)
    for (const c of EXPENSE_CURRENCIES) expect(() => new Intl.NumberFormat('en-US', { style: 'currency', currency: c })).not.toThrow()
  })

  it('adds a code set elsewhere that is not in the list, and nothing else', () => {
    expect(currencyOptions('EUR')).toEqual([...EXPENSE_CURRENCIES])
    expect(currencyOptions('JPY')).toEqual([...EXPENSE_CURRENCIES, 'JPY'])
    expect(currencyOptions('jpy')).toEqual([...EXPENSE_CURRENCIES])
    expect(currencyOptions('')).toEqual([...EXPENSE_CURRENCIES])
  })

  it('names a currency in each language, or gives the code', () => {
    expect(currencyName('MXN', 'en')).toBe('Mexican Peso')
    expect(currencyName('MXN', 'es')).toBe('peso mexicano')
    expect(currencyName('EUR', 'es')).toBe('euro')
    expect(currencyName('not a code', 'en')).toBe('not a code')
  })

  it('gives the symbol en-US shows, or the code', () => {
    expect(currencySymbol('USD')).toBe('$')
    expect(currencySymbol('EUR')).toBe('€')
    expect(currencySymbol('MXN')).toBe('MX$')
    expect(currencySymbol('BRL')).toBe('R$')
    expect(currencySymbol('CAD')).toBe('CA$')
    expect(currencySymbol('COP')).toBe('COP')
    expect(currencySymbol('junk')).toBe('$')
  })
})

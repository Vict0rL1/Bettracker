import { describe, expect, it } from 'vitest'
import { codeAmount, currencyDigits, currencyFormat, currencyName, currencyOptions, currencySymbol, DEFAULT_EXPENSE_CURRENCY, EXPENSE_CURRENCIES, payCurrencyOptions, symbolDisplay } from './currency'

const NBSP = ' '

describe('currencyFormat', () => {
  it('writes amounts with the currency’s symbol and the natural minus in front', () => {
    expect(currencyFormat('EUR').plain(-12.5)).toBe('-€12.50')
    expect(currencyFormat('EUR').plain(1234.5)).toBe('€1,234.50')
    expect(currencyFormat('GBP').plain(3)).toBe('£3.00')
    expect(currencyFormat('USD').plain(-45)).toBe('-$45.00')
  })

  // The main currency is the one currency of every total on the screen (its code stands next to the month's title),
  // so it is written with its narrow symbol: Canadian dollars are "$", not "CA$".
  it('writes the main currency with its narrow symbol: every dollar and peso is "$"', () => {
    expect(currencyFormat('CAD').plain(1234.5)).toBe('$1,234.50')
    expect(currencyFormat('CAD').plain(-12)).toBe('-$12.00')
    expect(currencyFormat('MXN').plain(1234.5)).toBe('$1,234.50')
    expect(currencyFormat('ARS').plain(12500)).toBe('$12,500.00')
    expect(currencyFormat('BRL').plain(3)).toBe('R$3.00')
    expect(currencyFormat('CAD').compact(1400)).toBe('$1.4k')
    expect(currencyFormat('CAD').axis(250)).toBe('$250')
  })

  it('asks for the narrow symbol, and for the plain one on an engine that refuses the option instead of failing', () => {
    expect(symbolDisplay()).toBe('narrowSymbol')
    expect(
      symbolDisplay(() => {
        throw new RangeError('Value narrowSymbol out of range for Intl.NumberFormat options property currencyDisplay')
      })
    ).toBe('symbol')
  })

  it('writes a letter symbol with a no-break space, in the currency’s own minor digits', () => {
    // Soles have no narrow symbol in en-US: the code stands in, with its space.
    expect(currencyFormat('PEN').plain(12500)).toBe(`PEN${NBSP}12,500.00`)
    expect(currencyFormat('BOB').plain(12.5)).toBe(`Bs${NBSP}12.50`)
    // COP: Intl decides its digits (ISO says 2; recent CLDR data, as in Node 22, says 0).
    expect(currencyFormat('COP').plain(12500)).toBe(`$12,500${currencyDigits('COP') === 2 ? '.00' : ''}`)
    expect(currencyFormat('CLP').plain(12500)).toBe('$12,500')
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
    expect(currencyFormat('PEN').axis(12_000)).toBe(`PEN${NBSP}12k`)
    expect(currencyFormat('PEN').compact(12_000)).toBe(`PEN${NBSP}12k`)
    expect(currencyFormat('ARS').axis(12_000)).toBe('$12k')
  })

  it('from a million, M with one decimal, trimmed (pesos reach it)', () => {
    const ars = currencyFormat('ARS')
    expect(ars.compact(1_500_000)).toBe('$1.5M')
    expect(ars.compact(1_000_000)).toBe('$1M')
    expect(ars.compact(-12_400_000)).toBe('-$12.4M')
    expect(ars.axis(1_500_000)).toBe('$1.5M')
    expect(ars.axis(2_000_000)).toBe('$2M')
    expect(ars.axis(-1_000_000)).toBe('-$1M')
    // Just under it stays in k.
    expect(ars.compact(999_499)).toBe('$999k')
    expect(ars.axis(999_000)).toBe('$999k')
    expect(currencyFormat('PEN').compact(12_000_000)).toBe(`PEN${NBSP}12M`)
  })

  it('stake: whole units from 1,000, else to the cent; bankroll as plain', () => {
    const mxn = currencyFormat('MXN')
    expect(mxn.stake(1240.4)).toBe('$1,240')
    expect(mxn.stake(12.5)).toBe('$12.50')
    expect(mxn.bankroll(-2180)).toBe('-$2,180.00')
    expect(currencyFormat('PEN').stake(1240.4)).toBe(`PEN${NBSP}1,240`)
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

  it('gives the narrow symbol en-US shows, or the code where there is none', () => {
    expect(currencySymbol('USD')).toBe('$')
    expect(currencySymbol('EUR')).toBe('€')
    expect(currencySymbol('MXN')).toBe('$')
    expect(currencySymbol('BRL')).toBe('R$')
    expect(currencySymbol('CAD')).toBe('$')
    expect(currencySymbol('COP')).toBe('$')
    expect(currencySymbol('GBP')).toBe('£')
    expect(currencySymbol('BOB')).toBe('Bs')
    expect(currencySymbol('PEN')).toBe('PEN')
    expect(currencySymbol('junk')).toBe('$')
  })
})

describe('codeAmount — an amount in another currency, written with its code', () => {
  it('writes the code, a no-break space and the amount in that currency’s digits', () => {
    expect(codeAmount(12, 'USD')).toBe(`USD${NBSP}12.00`)
    expect(codeAmount(1234.5, 'EUR')).toBe(`EUR${NBSP}1,234.50`)
    expect(codeAmount(12500, 'COP')).toBe(`COP${NBSP}12,500`)
    expect(codeAmount(1200, 'JPY')).toBe(`JPY${NBSP}1,200`)
    // Never a bare "$": that is how the main currency is written.
    for (const code of ['USD', 'CAD', 'MXN', 'ARS']) expect(codeAmount(5, code)).not.toContain('$')
  })

  it('a refund has its minus in front, and nothing reads as "-0"', () => {
    expect(codeAmount(-5, 'USD')).toBe(`-USD${NBSP}5.00`)
    expect(codeAmount(-0.001, 'USD')).toBe(`USD${NBSP}0.00`)
  })

  it('keeps cents a currency doesn’t have rather than rounding them away unseen', () => {
    expect(codeAmount(12500.5, 'COP')).toBe(`COP${NBSP}12,500.5`)
    expect(codeAmount(1200.25, 'JPY')).toBe(`JPY${NBSP}1,200.25`)
  })

  it('writes a code Intl has never heard of all the same, and one that is no code as it is', () => {
    expect(codeAmount(12, 'XYZ')).toBe(`XYZ${NBSP}12.00`)
    expect(codeAmount(12, 'usd')).toBe(`usd${NBSP}12.00`)
    expect(codeAmount(-12, 'dollars')).toBe(`-dollars${NBSP}12.00`)
    expect(codeAmount(-0.001, '')).toBe(`${NBSP}0.00`)
  })
})

describe('payCurrencyOptions — what an expense can be paid in', () => {
  it('offers the main currency first, then dollars, then the rest of the list, each once', () => {
    const list = payCurrencyOptions('CAD', null)
    expect(list.slice(0, 3)).toEqual(['CAD', 'USD', 'EUR'])
    expect(new Set(list).size).toBe(list.length)
    expect([...list].sort()).toEqual([...EXPENSE_CURRENCIES].sort())
  })

  it('offers the last other currency used on this device right after the main one, then dollars', () => {
    expect(payCurrencyOptions('CAD', 'EUR').slice(0, 4)).toEqual(['CAD', 'EUR', 'USD', 'MXN'])
    expect(payCurrencyOptions('CAD', 'USD').slice(0, 3)).toEqual(['CAD', 'USD', 'EUR'])
    // The main one is never offered twice, whatever was used last (it was changed since).
    expect(payCurrencyOptions('EUR', 'EUR').slice(0, 3)).toEqual(['EUR', 'USD', 'MXN'])
    expect(payCurrencyOptions('USD', null).slice(0, 2)).toEqual(['USD', 'EUR'])
  })

  it('adds a code from elsewhere (the expense being edited, the one read from a picture) that the list lacks', () => {
    expect(payCurrencyOptions('CAD', null, 'JPY')).toContain('JPY')
    expect(payCurrencyOptions('CAD', null, 'JPY').at(-1)).toBe('JPY')
    expect(payCurrencyOptions('JPY', 'CHF')).toEqual(['JPY', 'CHF', ...EXPENSE_CURRENCIES])
    expect(payCurrencyOptions('CAD', 'nope', 'jpy')).toEqual(payCurrencyOptions('CAD', null))
  })
})

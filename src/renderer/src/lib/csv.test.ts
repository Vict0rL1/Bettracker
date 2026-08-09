import { describe, expect, it } from 'vitest'
import { entry } from '../test-utils'
import { entriesToCsv, parseCsv, parseEntriesCsv } from './csv'

describe('entriesToCsv', () => {
  it('writes a header, a BOM and CRLF endings', () => {
    const csv = entriesToCsv([entry({ date: '2026-01-02', amount: 10, stake: 5 })])
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv.slice(1).split('\r\n')[0]).toBe('date,stake,amount,sport,book,bet_type,note')
  })

  it('leaves the stake column blank when none was recorded', () => {
    const csv = entriesToCsv([entry({ date: '2026-01-02', amount: 10 })])
    expect(csv).toContain('2026-01-02,,10.00,')
  })

  it('quotes fields containing commas, quotes or newlines', () => {
    const csv = entriesToCsv([entry({ amount: 1, note: 'a,b "c"\nd' })])
    expect(csv).toContain('"a,b ""c""\nd"')
  })

  it('sorts by date', () => {
    const csv = entriesToCsv([entry({ date: '2026-03-01', amount: 1 }), entry({ date: '2026-01-01', amount: 2 })])
    const dates = csv.slice(1).trim().split('\r\n').slice(1).map((l) => l.split(',')[0])
    expect(dates).toEqual(['2026-01-01', '2026-03-01'])
  })
})

describe('parseCsv', () => {
  it('reads quoted fields containing commas and escaped quotes', () => {
    expect(parseCsv('a,"b,c","d""e"')).toEqual([['a', 'b,c', 'd"e']])
  })

  it('reads a newline inside a quoted field', () => {
    expect(parseCsv('a,"line1\nline2"\nx,y')).toEqual([
      ['a', 'line1\nline2'],
      ['x', 'y']
    ])
  })

  it('accepts CRLF and drops the trailing blank line', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
  })

  it('strips a leading BOM', () => {
    expect(parseCsv('﻿date,amount')).toEqual([['date', 'amount']])
  })

  it('returns nothing for empty text', () => {
    expect(parseCsv('')).toEqual([])
  })
})

describe('parseEntriesCsv', () => {
  it('round-trips what entriesToCsv writes', () => {
    const original = [
      entry({ date: '2026-01-02', amount: 120.5, stake: 100, sport: 'NBA', book: 'DK', betType: 'Parlay', note: 'a,b' }),
      entry({ date: '2026-01-03', amount: -40, stake: null, note: '' })
    ]
    const { rows, errors, skipped } = parseEntriesCsv(entriesToCsv(original))
    expect(errors).toEqual([])
    expect(skipped).toBe(0)
    expect(rows).toEqual([
      { date: '2026-01-02', amount: 120.5, stake: 100, sport: 'NBA', book: 'DK', betType: 'Parlay', note: 'a,b' },
      { date: '2026-01-03', amount: -40, stake: null, sport: '', book: '', betType: '', note: '' }
    ])
  })

  it('matches columns by name in any order, ignoring extras', () => {
    const { rows } = parseEntriesCsv('note,amount,ignored,date\nhello,25,zz,2026-04-01\n')
    expect(rows).toEqual([
      { date: '2026-04-01', amount: 25, stake: null, sport: '', book: '', betType: '', note: 'hello' }
    ])
  })

  it('accepts aliases used by other trackers', () => {
    const { rows } = parseEntriesCsv('Day,P/L,Risk,League,Sportsbook,Market\n2026-04-01,10,20,NFL,FanDuel,Spread\n')
    expect(rows[0]).toMatchObject({
      date: '2026-04-01',
      amount: 10,
      stake: 20,
      sport: 'NFL',
      book: 'FanDuel',
      betType: 'Spread'
    })
  })

  it('reads currency symbols, thousands separators and parenthesised negatives', () => {
    const { rows } = parseEntriesCsv('date,amount,stake\n2026-04-01,"$1,234.50",$100\n2026-04-02,(45.00),50\n')
    expect(rows[0].amount).toBe(1234.5)
    expect(rows[0].stake).toBe(100)
    expect(rows[1].amount).toBe(-45)
  })

  it('refuses a file with no date or amount column', () => {
    const { rows, errors } = parseEntriesCsv('foo,bar\n1,2\n')
    expect(rows).toEqual([])
    expect(errors[0]).toMatch(/header row/i)
  })

  it('skips bad lines, reports them, and keeps the good ones', () => {
    const { rows, errors, skipped } = parseEntriesCsv(
      'date,amount,stake\n2026-04-01,10,5\nnot-a-date,10,5\n2026-04-03,abc,5\n2026-04-04,10,-3\n'
    )
    expect(rows).toHaveLength(1)
    expect(skipped).toBe(3)
    expect(errors).toHaveLength(3)
    expect(errors[0]).toMatch(/Line 3/)
    expect(errors[1]).toMatch(/Line 4/)
    expect(errors[2]).toMatch(/Line 5/)
  })

  it('caps the error list and says how many more were skipped', () => {
    const bad = Array.from({ length: 9 }, () => 'nope,1,1').join('\n')
    const { errors, skipped } = parseEntriesCsv(`date,amount,stake\n${bad}\n`)
    expect(skipped).toBe(9)
    expect(errors).toHaveLength(6)
    expect(errors[5]).toMatch(/4 more skipped lines/)
  })

  it('reports an empty file', () => {
    expect(parseEntriesCsv('').errors[0]).toMatch(/empty/i)
  })
})

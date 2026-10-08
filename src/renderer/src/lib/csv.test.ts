import { describe, expect, it } from 'vitest'
import { bet } from '../test-utils'
import { betsToCsv, parseCsv, parseBetsCsv } from './csv'

describe('betsToCsv', () => {
  it('writes a header, a BOM and CRLF endings', () => {
    const csv = betsToCsv([bet({ date: '2026-01-02', amount: 10, stake: 5 })])
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv.slice(1).split('\r\n')[0]).toBe('date,status,stake,odds,amount,sport,book,bet_type,note')
  })

  it('leaves stake, odds and a pending amount blank when unknown', () => {
    expect(betsToCsv([bet({ date: '2026-01-02', amount: 10 })])).toContain('2026-01-02,won,,,10.00,')
    expect(betsToCsv([bet({ date: '2026-01-03', status: 'pending', stake: 25, odds: 1.91 })])).toContain('2026-01-03,pending,25.00,1.91,,')
  })

  it('quotes fields containing commas, quotes or newlines', () => {
    const csv = betsToCsv([bet({ amount: 1, note: 'a,b "c"\nd' })])
    expect(csv).toContain('"a,b ""c""\nd"')
  })

  it('defuses cells a spreadsheet would run as a formula', () => {
    const csv = betsToCsv([
      bet({ amount: 1, note: '=HYPERLINK("http://x")', sport: '+1', book: '-x', betType: '@cmd' }),
      bet({ amount: 1, note: '\tlead tab', sport: "'quoted", book: 'plain', betType: '' })
    ])
    const lines = csv.slice(1).trim().split('\r\n')
    expect(lines[1]).toContain(`'+1,'-x,'@cmd,"'=HYPERLINK(""http://x"")"`)
    // A tab needs the guard but not quoting (only commas, quotes and newlines do).
    expect(lines[2]).toMatch(/,'\tlead tab$/)
    expect(lines[2]).toContain(`''quoted,plain,`)
  })

  it('leaves negative amounts alone — they are numbers, not text', () => {
    expect(betsToCsv([bet({ amount: -40, stake: 40 })])).toContain(',40.00,,-40.00,')
  })

  it('sorts by date', () => {
    const csv = betsToCsv([bet({ date: '2026-03-01', amount: 1 }), bet({ date: '2026-01-01', amount: 2 })])
    const dates = csv.slice(1).trim().split('\r\n').slice(1).map((l: string) => l.split(',')[0])
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

describe('parseBetsCsv', () => {
  it('round-trips what betsToCsv writes, pending bets included', () => {
    const original = [
      bet({ date: '2026-01-02', amount: 120.5, stake: 100, odds: 2.205, sport: 'NBA', book: 'DK', betType: 'Parlay', note: 'a,b' }),
      bet({ date: '2026-01-03', amount: -40, stake: null, note: '' }),
      bet({ date: '2026-01-04', status: 'pending', stake: 30, odds: 1.8 }),
      bet({ date: '2026-01-05', status: 'void', stake: 30 })
    ]
    const { rows, errors, skipped, noStake } = parseBetsCsv(betsToCsv(original))
    expect(errors).toEqual([])
    expect(skipped).toBe(0)
    expect(noStake).toBe(1)
    expect(rows).toEqual([
      { date: '2026-01-02', amount: 120.5, stake: 100, odds: 2.205, status: 'won', sport: 'NBA', book: 'DK', betType: 'Parlay', note: 'a,b' },
      { date: '2026-01-03', amount: -40, stake: null, odds: null, status: 'lost', sport: '', book: '', betType: '', note: '' },
      { date: '2026-01-04', amount: null, stake: 30, odds: 1.8, status: 'pending', sport: '', book: '', betType: '', note: '' },
      { date: '2026-01-05', amount: 0, stake: 30, odds: null, status: 'void', sport: '', book: '', betType: '', note: '' }
    ])
  })

  it('round-trips formula-looking text without loss, stripping exactly one guard apostrophe', () => {
    const notes = ['=SUM(A1:A9)', '+5 units', '-3 units', '@everyone', "'already quoted", "''two", 'normal', '']
    const original = notes.map((note, i) => bet({ date: `2026-01-0${i + 1}`, amount: 1, note, sport: note }))
    const { rows, errors } = parseBetsCsv(betsToCsv(original))
    expect(errors).toEqual([])
    expect(rows.map((r) => r.note)).toEqual(notes)
    expect(rows.map((r) => r.sport)).toEqual(notes)
  })

  it('strips a guard apostrophe from files written by other tools too', () => {
    const { rows } = parseBetsCsv("date,amount,note\n2026-04-01,1,'=1+1\n2026-04-02,1,'plain\n")
    expect(rows.map((r) => r.note)).toEqual(['=1+1', 'plain'])
  })

  it('imports the very first export format (date, amount, note) unchanged', () => {
    const { rows, errors } = parseBetsCsv('date,amount,note\r\n2026-04-01,25.00,parlay\r\n2026-04-02,-10.00,\r\n')
    expect(errors).toEqual([])
    expect(rows).toEqual([
      { date: '2026-04-01', amount: 25, stake: null, odds: null, sport: '', book: '', betType: '', note: 'parlay' },
      { date: '2026-04-02', amount: -10, stake: null, odds: null, sport: '', book: '', betType: '', note: '' }
    ])
  })

  it('imports the stake-era export format (no odds or status columns)', () => {
    const { rows, noStake } = parseBetsCsv('date,stake,amount,sport,book,bet_type,note\n2026-04-01,20.00,38.00,NFL,FD,Spread,x\n')
    expect(rows[0]).toMatchObject({ date: '2026-04-01', stake: 20, amount: 38, odds: null, sport: 'NFL', note: 'x' })
    expect(rows[0].status).toBeUndefined() // left to the amount's sign, as before
    expect(noStake).toBe(0)
  })

  it('matches columns by name in any order, ignoring extras', () => {
    const { rows } = parseBetsCsv('note,amount,ignored,date\nhello,25,zz,2026-04-01\n')
    expect(rows).toEqual([{ date: '2026-04-01', amount: 25, stake: null, odds: null, sport: '', book: '', betType: '', note: 'hello' }])
  })

  it('accepts aliases used by other trackers, including "session" for the note', () => {
    const { rows, errors } = parseBetsCsv(
      'Day,Result,Risk,Price,League,Sportsbook,Market,Session,P/L\n2026-04-01,W,20,1.91,NFL,FanDuel,Spread,late line,18.20\n'
    )
    expect(errors).toEqual([])
    expect(rows[0]).toMatchObject({
      date: '2026-04-01',
      status: 'won',
      amount: 18.2,
      stake: 20,
      odds: 1.91,
      sport: 'NFL',
      book: 'FanDuel',
      betType: 'Spread',
      note: 'late line'
    })
  })

  it('reads status words in their common spellings', () => {
    const text = 'date,status,stake,amount\n2026-04-01,Win,10,9\n2026-04-02,LOSS,10,-10\n2026-04-03,tie,10,\n2026-04-04,cancelled,10,\n2026-04-05,open,10,\n'
    const { rows, errors } = parseBetsCsv(text)
    expect(errors).toEqual([])
    expect(rows.map((r) => r.status)).toEqual(['won', 'lost', 'push', 'void', 'pending'])
    expect(rows.map((r) => r.amount)).toEqual([9, -10, 0, 0, null])
  })

  it('reads a numeric "result" column as the amount when there is no amount column', () => {
    const { rows, errors } = parseBetsCsv('date,result\n2026-04-01,15\n2026-04-02,(4.50)\n')
    expect(errors).toEqual([])
    expect(rows.map((r) => r.amount)).toEqual([15, -4.5])
    expect(rows[0].status).toBeUndefined()
  })

  it('still reads a "result" column of words as the status', () => {
    const { rows } = parseBetsCsv('date,result,amount\n2026-04-01,lost,-5\n')
    expect(rows[0]).toMatchObject({ status: 'lost', amount: -5 })
  })

  it('reads currency symbols, thousands separators, parenthesised negatives and comma decimals in odds', () => {
    const { rows } = parseBetsCsv('date,amount,stake,odds\n2026-04-01,"$1,234.50",$100,"2,50"\n2026-04-02,(45.00),50,1.91\n')
    expect(rows[0].amount).toBe(1234.5)
    expect(rows[0].stake).toBe(100)
    expect(rows[0].odds).toBe(2.5)
    expect(rows[1].amount).toBe(-45)
  })

  it('refuses a file with no date column, or neither amount nor status', () => {
    expect(parseBetsCsv('foo,bar\n1,2\n').errors[0]).toMatch(/header row/i)
    expect(parseBetsCsv('date,note\n2026-01-01,x\n').errors[0]).toMatch(/header row/i)
  })

  it('skips bad lines, reports them, and keeps the good ones', () => {
    const { rows, errors, skipped } = parseBetsCsv(
      'date,amount,stake,odds\n2026-04-01,10,5,1.5\nnot-a-date,10,5,\n2026-04-03,abc,5,\n2026-04-04,10,-3,\n2026-04-05,10,5,0.9\n'
    )
    expect(rows).toHaveLength(1)
    expect(skipped).toBe(4)
    expect(errors).toHaveLength(4)
    expect(errors[0]).toMatch(/Line 3/)
    expect(errors[1]).toMatch(/Line 4/)
    expect(errors[2]).toMatch(/Line 5/)
    expect(errors[3]).toMatch(/Line 6.*above 1/)
  })

  it('reports a row whose status contradicts its amount instead of importing it', () => {
    const { rows, errors } = parseBetsCsv('date,status,amount\n2026-04-01,won,-5\n2026-04-02,push,3\n2026-04-03,won,\n')
    expect(rows).toHaveLength(0)
    expect(errors[0]).toMatch(/positive/)
    expect(errors[1]).toMatch(/returns the stake/)
    expect(errors[2]).toMatch(/needs its result/)
  })

  it('counts rows that arrived without a stake', () => {
    const { noStake } = parseBetsCsv('date,amount,stake\n2026-04-01,1,\n2026-04-02,1,5\n2026-04-03,1,\n')
    expect(noStake).toBe(2)
  })

  it('caps the error list and says how many more were skipped', () => {
    const bad = Array.from({ length: 9 }, () => 'nope,1,1').join('\n')
    const { errors, skipped } = parseBetsCsv(`date,amount,stake\n${bad}\n`)
    expect(skipped).toBe(9)
    expect(errors).toHaveLength(6)
    expect(errors[5]).toMatch(/4 more skipped lines/)
  })

  it('reports an empty file', () => {
    expect(parseBetsCsv('').errors[0]).toMatch(/empty/i)
  })
})

import { describe, expect, it } from 'vitest'
import { bet } from '../test-utils'
import { betsToCsv, parseCsv, parseBetsCsv } from './csv'

describe('betsToCsv', () => {
  it('writes a header, a BOM and CRLF endings', () => {
    const csv = betsToCsv([bet({ date: '2026-01-02', amount: 10, stake: 5 })])
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv.slice(1).split('\r\n')[0]).toBe('date,status,stake,odds,closing_odds,amount,sport,book,bet_type,note')
  })

  it('leaves stake, odds, closing odds and a pending amount blank when unknown', () => {
    expect(betsToCsv([bet({ date: '2026-01-02', amount: 10 })])).toContain('2026-01-02,won,,,,10.00,')
    expect(betsToCsv([bet({ date: '2026-01-03', status: 'pending', stake: 25, odds: 1.91 })])).toContain('2026-01-03,pending,25.00,1.91,,,')
  })

  it('writes the closing price as stored (decimal), and reads it back under any of its names', () => {
    const csv = betsToCsv([bet({ date: '2026-01-02', amount: 150, stake: 100, odds: 2.5, closingOdds: 2.2 })])
    expect(csv).toContain('2026-01-02,won,100.00,2.5,2.2,150.00,')
    expect(parseBetsCsv(csv).rows[0].closingOdds).toBe(2.2)
    const other = parseBetsCsv('date,amount,odds,closing line\n2026-01-02,150,2.5,"2,20"\n')
    expect(other.rows[0].closingOdds).toBe(2.2)
  })

  it('rejects a closing price that is not a decimal above 1', () => {
    const r = parseBetsCsv('date,amount,closing_odds\n2026-01-02,10,0.9\n2026-01-03,10,\n')
    expect(r.rows).toHaveLength(1)
    expect(r.errors[0]).toMatch(/closing price/)
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
    expect(betsToCsv([bet({ amount: -40, stake: 40 })])).toContain(',40.00,,,-40.00,')
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
      { date: '2026-01-02', amount: 120.5, stake: 100, odds: 2.205, closingOdds: null, status: 'won', sport: 'NBA', book: 'DK', betType: 'Parlay', note: 'a,b' },
      { date: '2026-01-03', amount: -40, stake: null, odds: null, closingOdds: null, status: 'lost', sport: '', book: '', betType: '', note: '' },
      { date: '2026-01-04', amount: null, stake: 30, odds: 1.8, closingOdds: null, status: 'pending', sport: '', book: '', betType: '', note: '' },
      { date: '2026-01-05', amount: 0, stake: 30, odds: null, closingOdds: null, status: 'void', sport: '', book: '', betType: '', note: '' }
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
      { date: '2026-04-01', amount: 25, stake: null, odds: null, closingOdds: null, sport: '', book: '', betType: '', note: 'parlay' },
      { date: '2026-04-02', amount: -10, stake: null, odds: null, closingOdds: null, sport: '', book: '', betType: '', note: '' }
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
    expect(rows).toEqual([{ date: '2026-04-01', amount: 25, stake: null, odds: null, closingOdds: null, sport: '', book: '', betType: '', note: 'hello' }])
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

describe('parseBetsCsv — odds in any format', () => {
  const oddsOf = (text: string, format?: 'american' | 'decimal' | 'fractional') => {
    const { rows, errors } = parseBetsCsv(text, format)
    return { odds: rows.map((r) => r.odds), closing: rows.map((r) => r.closingOdds), errors }
  }

  it('reads signed American prices, instead of taking +150 for a decimal 150', () => {
    const { odds, errors } = oddsOf('date,amount,odds\n2026-04-01,15,+150\n2026-04-02,-11,-110\n2026-04-03,-12,-120\n')
    expect(errors).toEqual([])
    expect(odds).toEqual([2.5, 1 + 100 / 110, 1 + 100 / 120])
  })

  it('reads fractions, with a slash, a colon or a dash', () => {
    const { odds, errors } = oddsOf('date,amount,odds\n2026-04-01,15,3/2\n2026-04-02,-6,5/6\n2026-04-03,10,10:11\n2026-04-04,1,100-1\n2026-04-05,1,3-2\n')
    expect(errors).toEqual([])
    expect(odds).toEqual([2.5, 1 + 5 / 6, 1 + 10 / 11, 101, 2.5])
  })

  it('reads the closing odds column the same way', () => {
    const { closing, errors } = oddsOf('date,amount,odds,closing\n2026-04-01,15,+150,+140\n2026-04-02,-11,-110,-115\n2026-04-03,10,3/2,6/4\n')
    expect(errors).toEqual([])
    expect(closing).toEqual([2.4, 1 + 100 / 115, 2.5])
  })

  it('reads a whole number from 100 up as American when the file\'s other odds are American (a spreadsheet dropped the plus sign)', () => {
    const { odds, errors } = oddsOf('date,amount,odds\n2026-04-01,15,150\n2026-04-02,-11,-110\n', 'decimal')
    expect(errors).toEqual([])
    expect(odds).toEqual([2.5, 1 + 100 / 110])
  })

  it('keeps reading decimal files exactly as before, a 150.0 longshot included', () => {
    const { odds, errors } = oddsOf('date,amount,odds\n2026-04-01,1490,150\n2026-04-02,-10,1.91\n2026-04-03,20,3\n', 'american')
    expect(errors).toEqual([])
    expect(odds).toEqual([150, 1.91, 3])
  })

  it('round-trips its own export, whatever the user\'s odds format', () => {
    const csv = betsToCsv([
      bet({ date: '2026-01-02', amount: 1490, stake: 10, odds: 150, closingOdds: 120 }),
      bet({ date: '2026-01-03', amount: -10, stake: 10, odds: 1.909, closingOdds: 1.87 })
    ])
    for (const format of ['american', 'decimal', 'fractional'] as const) {
      const { odds, closing } = oddsOf(csv, format)
      expect(odds).toEqual([150, 1.909])
      expect(closing).toEqual([120, 1.87])
    }
  })

  it('follows the user\'s odds format when a file gives no other clue, like the odds box', () => {
    const text = 'date,amount,odds\n2026-04-01,15,150\n2026-04-02,20,200\n'
    expect(oddsOf(text, 'american').odds).toEqual([2.5, 3])
    expect(oddsOf(text, 'decimal').odds).toEqual([150, 200])
    expect(oddsOf(text, 'fractional').odds).toEqual([150, 200])
    // Without a format (older callers) a bare number stays decimal, as it always was.
    expect(oddsOf(text).odds).toEqual([150, 200])
  })

  it('lets a header that names the format decide', () => {
    expect(oddsOf('date,amount,american odds\n2026-04-01,15,150\n2026-04-02,-10,1.91\n', 'decimal').odds).toEqual([2.5, 1.91])
    expect(oddsOf('date,amount,decimal odds\n2026-04-01,15,150\n2026-04-02,-11,-110\n', 'american').odds).toEqual([150, 1 + 100 / 110])
    expect(oddsOf('date,amount,us odds\n2026-04-01,15,150\n').odds).toEqual([2.5])
    expect(oddsOf('date,amount,fractional odds\n2026-04-01,15,3/2\n').odds).toEqual([2.5])
  })

  it('reports a whole number it cannot place when the file mixes American and decimal odds', () => {
    const { odds, errors, skipped } = (() => {
      const r = parseBetsCsv('date,amount,odds\n2026-04-01,15,150\n2026-04-02,-11,-110\n2026-04-03,-10,1.91\n', 'american')
      return { odds: r.rows.map((x) => x.odds), errors: r.errors, skipped: r.skipped }
    })()
    expect(odds).toEqual([1 + 100 / 110, 1.91])
    expect(skipped).toBe(1)
    expect(errors[0]).toMatch(/Line 2: "150" could be American \(\+150\) or decimal/)
  })

  it('round-trips its own export even when every price in it is a whole number from 100 up', () => {
    const csv = betsToCsv([
      bet({ date: '2026-01-02', amount: 1490, stake: 10, odds: 150, closingOdds: 120 }),
      bet({ date: '2026-01-03', amount: 1000, stake: 10, odds: 101 }),
      bet({ date: '2026-01-04', amount: -10, stake: 10 })
    ])
    for (const format of ['american', 'decimal', 'fractional'] as const) {
      const { odds, closing, errors } = oddsOf(csv, format)
      expect(errors).toEqual([])
      expect(odds).toEqual([150, 101, null])
      expect(closing).toEqual([120, null, null])
    }
    // The export from before closing odds existed too.
    expect(oddsOf('date,status,stake,odds,amount,sport,book,bet_type,note\n2026-01-02,won,10.00,150,1490.00,,,,\n', 'american').odds).toEqual([150])
  })

  it('reads American prices from a spreadsheet number format ("150.00", "-110.00")', () => {
    const { odds, errors } = oddsOf('date,amount,odds\n2026-04-01,15,150.00\n2026-04-02,-11,-110.00\n2026-04-03,20,200\n', 'decimal')
    expect(errors).toEqual([])
    expect(odds).toEqual([2.5, 1 + 100 / 110, 3])
  })

  it('lets a header that names the format settle the closing column too', () => {
    const american = oddsOf('date,amount,american odds,closing\n2026-04-01,15,150,140\n', 'decimal')
    expect([american.odds, american.closing]).toEqual([[2.5], [2.4]])
    const decimal = oddsOf('date,amount,decimal odds,closing\n2026-04-01,1490,150,140\n', 'american')
    expect([decimal.odds, decimal.closing]).toEqual([[150], [140]])
  })

  it('does not let a cell that is no price at all tip the file either way', () => {
    // An old decimal file with one typo: 150 stays decimal, only the typo is skipped.
    const typo = parseBetsCsv('date,amount,odds\n2026-04-01,1490,150\n2026-04-02,-10,1.91\n2026-04-03,5,-2.5\n', 'american')
    expect(typo.rows.map((r) => r.odds)).toEqual([150, 1.91])
    expect(typo.skipped).toBe(1)
    // An American file with a 0 placeholder: 150 stays American.
    const placeholder = parseBetsCsv('date,amount,odds\n2026-04-01,15,150\n2026-04-02,-11,-110\n2026-04-03,5,0\n', 'decimal')
    expect(placeholder.rows.map((r) => r.odds)).toEqual([2.5, 1 + 100 / 110])
    expect(placeholder.skipped).toBe(1)
  })

  it('reads thousands separators on American prices, and a decimal comma where the file is decimal', () => {
    const signed = oddsOf('date,amount,odds\n2026-04-01,250,"+2,500"\n2026-04-02,-1,"-1,200"\n', 'decimal')
    expect(signed.odds).toEqual([26, 1 + 100 / 1200])
    expect(oddsOf('date,amount,odds\n2026-04-01,120,"1,200"\n2026-04-02,-11,-110\n', 'decimal').odds).toEqual([13, 1 + 100 / 110])
    expect(oddsOf('date,amount,odds\n2026-04-01,15,"2,500"\n2026-04-02,-10,1.91\n', 'american').odds).toEqual([2.5, 1.91])
    // Nothing else to go by: a decimal comma, as the odds box reads it.
    expect(oddsOf('date,amount,odds\n2026-04-01,15,"2,500"\n', 'american').odds).toEqual([2.5])
  })

  it('reads the minus sign sportsbook pages use, a trailing point and a plus on a decimal', () => {
    expect(oddsOf('date,amount,odds\n2026-04-01,-11,\u2212110\n').odds).toEqual([1 + 100 / 110])
    expect(oddsOf('date,amount,odds\n2026-04-01,10,2.\n2026-04-02,15,+2.5\n').odds).toEqual([2, 2.5])
  })

  it('reports a price too short to store (it would round to 1.000) instead of losing the import', () => {
    const { rows, errors, skipped } = parseBetsCsv('date,amount,odds\n2026-04-01,1,-300000\n2026-04-02,1,1/5000\n2026-04-03,1,1.91\n')
    expect(rows.map((r) => r.odds)).toEqual([1.91])
    expect(skipped).toBe(2)
    expect(errors[0]).toMatch(/Line 2: Odds must be greater than 1/)
  })

  it('rejects what is no price at all', () => {
    const { odds, errors, skipped } = (() => {
      const r = parseBetsCsv('date,amount,odds\n2026-04-01,15,+50\n2026-04-02,15,-1.5\n2026-04-03,15,abc\n2026-04-04,15,0/2\n2026-04-05,15,0.9\n2026-04-06,15,2.5\n')
      return { odds: r.rows.map((x) => x.odds), errors: r.errors, skipped: r.skipped }
    })()
    expect(odds).toEqual([2.5])
    expect(skipped).toBe(5)
    expect(errors[0]).toMatch(/"\+50" is not a price/)
  })
})

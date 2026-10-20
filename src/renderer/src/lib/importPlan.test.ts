import { describe, expect, it } from 'vitest'
import { bet } from '../test-utils'
import { parseBetsCsv } from './csv'
import { duplicateKey, fingerprint, planImport } from './importPlan'

const HEADER = 'date,status,stake,odds,closing_odds,amount,sport,book,bet_type,note'

describe('planImport', () => {
  const here = [bet({ id: 'x', date: '2026-08-02', amount: -50, stake: 50, sport: 'NBA', book: 'DK', betType: 'Spread' })]

  it('sorts rows into fresh, possible duplicates of bets here, and rejected lines, keeping each line number', () => {
    const csv = [HEADER, '2026-08-02,lost,50.00,,,-50.00,nba,dk,spread,note differs', '2026-08-03,won,10,2.5,,15,NBA,DK,Spread,', 'nope,won,1,,,1,,,,'].join('\n')
    const plan = planImport(parseBetsCsv(csv, 'decimal'), here)
    expect(plan.duplicates.map((r) => r.line)).toEqual([2])
    expect(plan.fresh.map((r) => r.line)).toEqual([3])
    expect(plan.rejected).toEqual([expect.objectContaining({ line: 4, key: 'csv.date', vars: { value: 'nope' } })])
  })

  it('matches each bet here at most once: two identical rows against one bet are one duplicate and one new bet', () => {
    const row = '2026-08-02,lost,50.00,,,-50.00,NBA,DK,Spread,'
    const plan = planImport(parseBetsCsv([HEADER, row, row].join('\n'), 'decimal'), here)
    expect(plan.duplicates).toHaveLength(1)
    expect(plan.fresh).toHaveLength(1)
    expect(plan.sameInFile).toBe(1)
  })

  it('never calls identical rows of a file duplicates of each other: both go in', () => {
    const row = '2026-08-09,won,10,2,,10,NHL,,,'
    const plan = planImport(parseBetsCsv([HEADER, row, row].join('\n'), 'decimal'), [])
    expect(plan.fresh).toHaveLength(2)
    expect(plan.duplicates).toHaveLength(0)
    expect(plan.sameInFile).toBe(1)
  })

  it('a different result, stake or odds is a different bet', () => {
    const base = { date: '2026-08-02', status: 'lost' as const, amount: -50, stake: 50, odds: null, sport: '', book: '', betType: '' }
    expect(duplicateKey(base)).not.toBe(duplicateKey({ ...base, stake: 40 }))
    expect(duplicateKey(base)).not.toBe(duplicateKey({ ...base, odds: 1.9 }))
    expect(duplicateKey(base)).not.toBe(duplicateKey({ ...base, status: 'won', amount: 50 }))
  })
})

describe('fingerprint', () => {
  it('is the same for the same text and differs for another', () => {
    expect(fingerprint('a,b\n1,2')).toBe(fingerprint('a,b\n1,2'))
    expect(fingerprint('a,b\n1,2')).not.toBe(fingerprint('a,b\n1,3'))
  })
})

describe('parseBetsCsv: every rejected line, coded', () => {
  it('lists them all, past the five the old message kept', () => {
    const lines = Array.from({ length: 8 }, (_, i) => `bad${i},1`)
    const r = parseBetsCsv(['date,amount', ...lines].join('\n'))
    expect(r.rejected).toHaveLength(8)
    expect(r.errors).toHaveLength(6)
    expect(r.rejected[7]).toMatchObject({ line: 9, key: 'csv.date' })
  })

  it('a whole-file problem has its own code', () => {
    expect(parseBetsCsv('').fileProblem).toBe('csv.fileEmpty')
    expect(parseBetsCsv('foo,bar\n1,2').fileProblem).toBe('csv.fileHeader')
    expect(parseBetsCsv('date,amount\n2026-01-01,5').fileProblem).toBeNull()
  })

  it('a row the writer would refuse carries the writer’s code', () => {
    const r = parseBetsCsv('date,status,amount\n2026-01-01,won,-5')
    expect(r.rejected[0]).toMatchObject({ line: 2, key: 'invalid.wonPositive' })
  })
})

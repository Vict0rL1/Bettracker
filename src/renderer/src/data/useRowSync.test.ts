import { describe, expect, it } from 'vitest'
import { migration008, migration009 } from './useRowSync'

describe('migration008 — what the three tables of 008 say together', () => {
  const t = (tableReady: boolean, tableMissing: boolean) => ({ tableReady, tableMissing })

  it('has 008 only on positive evidence: a read or a write of one of them went through', () => {
    expect(migration008([t(false, false), t(false, false), t(false, false)])).toEqual({ has008: false, needs008: false })
    expect(migration008([t(false, true), t(true, false), t(false, true)])).toEqual({ has008: true, needs008: false })
  })

  it('needs 008 when a read found a table missing and nothing has proved it since', () => {
    expect(migration008([t(false, true), t(false, false), t(false, false)])).toEqual({ has008: false, needs008: true })
  })
})

describe('migration009 — the expenses wait for the columns of 009', () => {
  const e = (tableReady: boolean, blocked: boolean) => ({ tableReady, blocked })

  it('is known only from a refused write of a table that is there', () => {
    expect(migration009(e(true, true), false)).toBe(true)
  })

  it('says nothing while nothing waits, or while the table itself has not been seen', () => {
    expect(migration009(e(true, false), false)).toBe(false)
    expect(migration009(e(false, false), false)).toBe(false)
    // Blocked before any read or write went through: it may be 008 that is missing.
    expect(migration009(e(false, true), false)).toBe(false)
  })

  it('is never said on top of 008: without the tables there are no columns to miss', () => {
    expect(migration009(e(true, true), true)).toBe(false)
    expect(migration009(e(false, true), true)).toBe(false)
  })
})

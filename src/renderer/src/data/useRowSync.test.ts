import { describe, expect, it } from 'vitest'
import { migration008 } from './useRowSync'

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

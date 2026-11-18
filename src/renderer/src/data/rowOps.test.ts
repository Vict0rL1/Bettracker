import { describe, expect, it } from 'vitest'
import type { ExpenseCard, ExpenseInput } from '../../../shared/types'
import { InputError } from '../lib/validate'
import { CARDS_SPEC, EXPENSES_SPEC, ROW_SPECS } from './expenseSpecs'
import { insertStamp, type PendingOp } from './offline'
import { addManyOps, addOp, answerNotice, restoreOp } from './rowOps'
import { applyRowOutbox, sortRows, type RowBase } from './rowStorage'
import type { RowTableSpec } from './rowTable'

const CARD = '6f9619ff-8b86-4011-b42d-00cf4fc964ff'
const NOW = new Date('2026-11-18T12:00:00.000Z')
const T1 = '2026-11-01T10:00:00.000Z'
const T2 = '2026-11-02T10:00:00.000Z'
const T3 = '2026-11-03T10:00:00.000Z'

/** Ids in the order they are made, so a test can tell which call made which. */
const ids = (): (() => string) & { made: number } => {
  const f = Object.assign(() => `id-${++f.made}`, { made: 0 })
  return f
}

const coffee: ExpenseInput = { date: '2026-11-17', amount: 4.499, cardId: CARD.toUpperCase(), merchant: '  Café   Central ', category: 'coffee' }
const cleanCoffee = { date: '2026-11-17', amount: 4.5, originalAmount: null, originalCurrency: null, fxRate: null, cardId: CARD, merchant: 'Café Central', category: 'coffee', note: '', source: 'manual' }

describe('addOp — one add', () => {
  it('queues the clean input under a new id, stamped now', () => {
    const op = addOp(EXPENSES_SPEC.normalize, coffee, {}, ids(), NOW)
    expect(op).toEqual({ opId: 'id-2', kind: 'add', id: 'id-1', input: cleanCoffee, queuedAt: NOW.toISOString() })
  })

  it('keeps an id it is given (a budget’s comes from what it is)', () => {
    expect(addOp(EXPENSES_SPEC.normalize, coffee, { id: 'given' }, ids(), NOW)).toMatchObject({ id: 'given', opId: 'id-1' })
  })

  it('with `after`, is stamped just past the cleared row, even when this clock is behind it (007’s tombstone lets it in)', () => {
    const later = '2026-11-18T12:00:05.000Z'
    expect(addOp(EXPENSES_SPEC.normalize, coffee, { id: 'b', after: later }, ids(), NOW).queuedAt).toBe('2026-11-18T12:00:05.001Z')
    expect(addOp(EXPENSES_SPEC.normalize, coffee, { id: 'b', after: T1 }, ids(), NOW).queuedAt).toBe(NOW.toISOString())
  })

  it('throws on bad input before making anything', () => {
    const newId = ids()
    expect(() => addOp(EXPENSES_SPEC.normalize, { date: '2026-11-17', amount: 0 }, {}, newId, NOW)).toThrow(InputError)
    expect(newId.made).toBe(0)
  })
})

describe('addManyOps — the rows of a scan', () => {
  it('queues each clean, under its own id, all with one stamp', () => {
    const ops = addManyOps(EXPENSES_SPEC.normalize, [coffee, { ...coffee, amount: -12, category: 'fuel' }], ids(), NOW)
    expect(ops).toHaveLength(2)
    expect(ops.map((o) => o.input)).toEqual([cleanCoffee, { ...cleanCoffee, amount: -12, category: 'other' }])
    expect(new Set(ops.map((o) => o.id)).size).toBe(2)
    expect(new Set(ops.flatMap((o) => [o.id, o.opId])).size).toBe(4)
    expect(ops.every((o) => o.kind === 'add' && o.queuedAt === NOW.toISOString() && o.editedAt === undefined)).toBe(true)
  })

  it('builds none when one input is bad, wherever it is', () => {
    const newId = ids()
    expect(() => addManyOps(EXPENSES_SPEC.normalize, [coffee, coffee, { date: 'yesterday', amount: 3 }], newId, NOW)).toThrow(InputError)
    expect(newId.made).toBe(0)
    expect(addManyOps(EXPENSES_SPEC.normalize, [], newId, NOW)).toEqual([])
  })
})

/** Each table with a row that sets every field away from its default, so a field lost on the way shows. */
const ROWS: [string, RowTableSpec<RowBase, unknown>, RowBase][] = [
  ['expenses', ROW_SPECS[0] as unknown as RowTableSpec<RowBase, unknown>, { id: 'e1', date: '2026-11-05', amount: -12.5, originalAmount: -8.91, originalCurrency: 'USD', fxRate: 1.40291807, cardId: CARD, merchant: 'Café Central', category: 'food', note: 'with a croissant', source: 'ai', createdAt: T1, updatedAt: T2 } as RowBase],
  ['expense-cards', ROW_SPECS[1] as unknown as RowTableSpec<RowBase, unknown>, { id: 'c1', name: 'Visa Oro', last4: '1234', kind: 'debit', archived: true, createdAt: T1, updatedAt: T2 } as RowBase],
  ['expense-budgets', ROW_SPECS[2] as unknown as RowTableSpec<RowBase, unknown>, { id: 'b1', scope: 'card', target: CARD, monthlyLimit: 250.5, createdAt: T1, updatedAt: T2 } as RowBase]
]

describe.each(ROWS)('restoreOp — the Undo of a delete: %s', (_name, spec, row) => {
  it('gives back, through toInput, exactly the row it was (no field lost or changed)', () => {
    const input = spec.toInput(row)
    expect(spec.normalize(input)).toEqual(input)
    expect(spec.fromInput(row.id, input, row.createdAt, row.updatedAt)).toEqual(row)
  })

  it('adds it again under its own id, stamped past its last stamp, keeping when it was made', () => {
    const op = restoreOp(spec, row, ids(), NOW)
    expect(op).toEqual({ opId: 'id-1', kind: 'add', id: row.id, input: spec.toInput(row), queuedAt: T1, editedAt: NOW.toISOString() })
    expect(insertStamp(op)).toBe(NOW.toISOString())
    // Shown at once as it was, with the new stamp.
    expect(applyRowOutbox(spec, [], [op])).toEqual([{ ...row, updatedAt: NOW.toISOString() }])
  })

  it('is stamped just past the row when this clock is behind it', () => {
    const ahead = { ...row, updatedAt: '2026-11-18T12:00:09.000Z' }
    expect(restoreOp(spec, ahead, ids(), NOW)).toMatchObject({ queuedAt: T1, editedAt: '2026-11-18T12:00:09.001Z' })
  })

  it('a row with no readable createdAt (an old cache) is made now', () => {
    expect(restoreOp(spec, { ...row, createdAt: '' }, ids(), NOW)).toMatchObject({ queuedAt: NOW.toISOString(), editedAt: NOW.toISOString() })
  })
})

describe('restoreOp — a card brought back keeps its place among the cards (and so its ink)', () => {
  it('comes back between the cards it was between, not last', () => {
    const card = (id: string, createdAt: string): ExpenseCard => ({ id, name: id, last4: '', kind: 'credit', archived: false, createdAt, updatedAt: createdAt })
    const [a, b, c] = [card('a', T1), card('b', T2), card('c', T3)]
    const back = applyRowOutbox(CARDS_SPEC, [a, c], [restoreOp(CARDS_SPEC, b, ids(), NOW)])
    expect(back.map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(sortRows(CARDS_SPEC, back)).toEqual(back)
  })
})

describe('answerNotice — what an answer tells the user', () => {
  const add: PendingOp<unknown> = { opId: 'o', kind: 'add', id: 'r', input: {}, queuedAt: T1 }
  const edit: PendingOp<unknown> = { opId: 'o', kind: 'update', id: 'r', input: {}, editedAt: T1 }
  const gone: PendingOp<unknown> = { opId: 'o', kind: 'delete', id: 'r' }
  const row = { id: 'r' }

  it('an edit that came back with no row lost (or its row is gone), unless a later change of the row is still queued', () => {
    expect(answerNotice(edit, null, false, false)).toBe('conflict')
    expect(answerNotice(edit, null, true, false)).toBeNull()
    expect(answerNotice(edit, row, false, false)).toBeNull()
  })

  it('a budget set again and let go by 007 is said; any other add let go is not (a resend of a deleted row)', () => {
    expect(answerNotice(add, null, false, true)).toBe('conflict')
    expect(answerNotice(add, null, false, false)).toBeNull()
    expect(answerNotice(add, row, false, true)).toBeNull()
  })

  it('a delete says nothing', () => {
    expect(answerNotice(gone, null, false, true)).toBeNull()
    expect(answerNotice(gone, null, false, false)).toBeNull()
  })
})

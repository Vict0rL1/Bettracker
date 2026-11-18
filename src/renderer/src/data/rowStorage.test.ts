import { beforeEach, describe, expect, it } from 'vitest'
import type { Expense, ExpenseInput } from '../../../shared/types'
import { BUDGETS_SPEC, CARDS_SPEC, EXPENSES_SPEC, ROW_SPECS } from './expenseSpecs'
import { clearUserData, markSignedIn, rowKeys, type PendingOp } from './offline'
import {
  applyRowOutbox,
  loadRowCache,
  loadRowOutbox,
  loadRowRefused,
  readRowOutbox,
  reconcileRow,
  saveRowCache,
  saveRowOutbox,
  saveRowRefused,
  sortRows,
  type RowBase,
  type RowStorageSpec
} from './rowStorage'

/** A spec with what the cases need of it: a row, an input, and cached shapes it must refuse. */
interface Fixture {
  spec: RowStorageSpec<RowBase, unknown>
  row: (id: string, createdAt: string, n?: number) => RowBase
  input: (n: number) => unknown
  poison: unknown[]
}

const at = (n: number): string => `2026-11-0${n}T10:00:00.000Z`

const FIXTURES: Fixture[] = [
  {
    spec: EXPENSES_SPEC as unknown as RowStorageSpec<RowBase, unknown>,
    row: (id, createdAt, n = 1) => ({ id, date: '2026-11-05', amount: n, cardId: null, merchant: '', category: 'coffee', note: '', source: 'manual', createdAt, updatedAt: createdAt }),
    input: (n) => ({ date: '2026-11-10', amount: n, cardId: null, merchant: 'Shop', category: 'food', note: '', source: 'manual' }),
    poison: [null, 'x', { date: '2026-11-05', amount: 1 }, { id: 'p', date: '2026-02-30', amount: 1 }, { id: 'p', date: '2026-11-05', amount: 0 }, { id: 'p', date: '2026-11-05', amount: 'x' }]
  },
  {
    spec: CARDS_SPEC as unknown as RowStorageSpec<RowBase, unknown>,
    row: (id, createdAt, n = 1) => ({ id, name: `Card ${n}`, last4: '', kind: 'credit', archived: false, createdAt, updatedAt: createdAt }),
    input: (n) => ({ name: `Visa ${n}`, last4: '1234', kind: 'debit', archived: false }),
    poison: [null, 3, { name: 'No id' }, { id: 'p', name: '   ' }, { id: 'p' }]
  },
  {
    spec: BUDGETS_SPEC as unknown as RowStorageSpec<RowBase, unknown>,
    row: (id, createdAt, n = 1) => ({ id, scope: 'category', target: 'coffee', monthlyLimit: n, createdAt, updatedAt: createdAt }),
    input: (n) => ({ scope: 'total', target: '', monthlyLimit: n }),
    poison: [null, [], { scope: 'total', monthlyLimit: 5 }, { id: 'p', scope: 'week', monthlyLimit: 5 }, { id: 'p', scope: 'total', monthlyLimit: 0 }, { id: 'p', scope: 'total', monthlyLimit: -1 }]
  }
]

/** Every key in storage (the test storage keeps its keys to itself: Object.keys sees none). */
const storedKeys = (): string[] => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? '')

beforeEach(() => {
  localStorage.clear()
  // A test that signs a user out leaves them so for the module (see clearUserData).
  for (const uid of ['u1', 'u2', 'u3']) markSignedIn(uid)
})

it('takes the specs with their own row and input types (strictFunctionTypes)', () => {
  // A compile-time check as much as a run-time one: these calls must type-check without a cast.
  const rows: Expense[] | null = loadRowCache('u1', EXPENSES_SPEC)
  const ops: PendingOp<ExpenseInput>[] = loadRowOutbox<ExpenseInput>('u1', 'expenses')
  saveRowCache('u1', EXPENSES_SPEC, [])
  expect(rows).toBeNull()
  expect(ops).toEqual([])
  expect(ROW_SPECS.map((s) => s.name)).toEqual(['expenses', 'expense-cards', 'expense-budgets'])
})

describe.each(FIXTURES.map((f) => [f.spec.name, f] as const))('row storage: %s', (name, f) => {
  const { spec } = f
  const keys = rowKeys('u1', spec.name)
  const add = (id: string, n: number, queuedAt = at(2)): PendingOp<unknown> => ({ opId: `add-${id}`, kind: 'add', id, input: f.input(n), queuedAt })

  it('tells a list never loaded (null) from an empty one', () => {
    expect(loadRowCache('u1', spec)).toBeNull()
    saveRowCache('u1', spec, [])
    expect(loadRowCache('u1', spec)).toEqual([])
    localStorage.setItem(keys.cache, '{"not":"a list"}')
    expect(loadRowCache('u1', spec)).toBeNull()
  })

  it('keeps each user apart, under its own keys', () => {
    const a = f.row('a', at(1))
    saveRowCache('u1', spec, [a])
    expect(loadRowCache('u1', spec)).toEqual([a])
    expect(loadRowCache('u2', spec)).toBeNull()
    expect(keys).toEqual({ cache: `bettracker:${name}:u1`, outbox: `bettracker:${name}-outbox:u1`, refused: `bettracker:${name}-refused:u1` })
    expect(JSON.parse(localStorage.getItem(`bettracker:${name}:u1`) ?? 'null')).toEqual([a])
  })

  it('drops cached rows it could not use, keeping the rest', () => {
    const good = f.row('good', at(1))
    localStorage.setItem(keys.cache, JSON.stringify([...f.poison, good]))
    expect(loadRowCache('u1', spec)).toEqual([good])
  })

  it('stores the queue as it is, and loads it with its head marked as maybe sent', () => {
    const ops = [add('a', 1), add('b', 2)]
    saveRowOutbox('u1', spec.name, ops)
    expect(readRowOutbox('u1', spec.name)).toEqual(ops)
    const loaded = loadRowOutbox('u1', spec.name)
    expect(loaded[0]).toMatchObject({ opId: 'add-a', sent: true })
    expect(loaded[1]).toEqual(ops[1])
    localStorage.setItem(keys.outbox, '"junk"')
    expect(readRowOutbox('u1', spec.name)).toEqual([])
  })

  it('keeps the refused list, and removes the key when it empties', () => {
    const list = [{ ops: [add('a', 1)], reason: 'no', at: at(3) }]
    saveRowRefused('u1', spec.name, list)
    expect(loadRowRefused('u1', spec.name)).toEqual(list)
    saveRowRefused('u1', spec.name, [])
    expect(localStorage.getItem(keys.refused)).toBeNull()
    expect(loadRowRefused('u1', spec.name)).toEqual([])
  })

  it('is wiped on sign-out, and nothing more is stored until the user signs in again', () => {
    saveRowCache('u3', spec, [f.row('a', at(1))])
    saveRowOutbox('u3', spec.name, [add('b', 1)])
    saveRowRefused('u3', spec.name, [{ ops: [add('c', 1)], reason: 'no', at: at(3) }])
    expect(storedKeys().filter((k) => k.endsWith(':u3'))).toHaveLength(3)
    clearUserData('u3')
    expect(loadRowCache('u3', spec)).toBeNull()
    expect(readRowOutbox('u3', spec.name)).toEqual([])
    expect(loadRowRefused('u3', spec.name)).toEqual([])
    saveRowCache('u3', spec, [f.row('a', at(1))])
    saveRowOutbox('u3', spec.name, [add('b', 1)])
    saveRowRefused('u3', spec.name, [{ ops: [add('c', 1)], reason: 'no', at: at(3) }])
    expect(storedKeys().filter((k) => k.endsWith(':u3'))).toEqual([])
    markSignedIn('u3')
    saveRowCache('u3', spec, [])
    expect(loadRowCache('u3', spec)).toEqual([])
  })

  it('shows queued changes over the server rows: an add, an edit, a delete; an edit of a missing row and an import are skipped', () => {
    const a = f.row('a', at(1), 1)
    const b = f.row('b', at(1), 2)
    const added = add('c', 3, at(4))
    const edit: PendingOp<unknown> = { opId: 'e', kind: 'update', id: 'a', input: f.input(7), editedAt: at(5) }
    const gone: PendingOp<unknown> = { opId: 'd', kind: 'delete', id: 'b' }
    const ghost: PendingOp<unknown> = { opId: 'g', kind: 'update', id: 'zz', input: f.input(9), editedAt: at(5) }
    const bulk: PendingOp<unknown> = { opId: 'k', kind: 'bulk-add', entries: [{ id: 'imp', input: f.input(8) }], queuedAt: at(5) }
    const shown = applyRowOutbox(spec, [a, b], [added, edit, gone, ghost, bulk])
    expect(shown.map((r) => r.id).sort()).toEqual(['a', 'c'])
    const c = shown.find((r) => r.id === 'c')
    expect(c).toEqual(spec.fromInput('c', f.input(3), at(4), at(4)))
    expect(c).toMatchObject({ createdAt: at(4), updatedAt: at(4) })
    const editedA = shown.find((r) => r.id === 'a')
    expect(editedA).toEqual(spec.withInput(a, f.input(7), at(5)))
    expect(editedA).toMatchObject({ createdAt: at(1), updatedAt: at(5) })
    // An add with an edit folded in carries the edit's time.
    const folded = applyRowOutbox(spec, [], [{ ...(add('f', 1, at(2)) as Extract<PendingOp<unknown>, { kind: 'add' }>), input: f.input(6), editedAt: at(6) }])
    expect(folded[0]).toMatchObject({ id: 'f', createdAt: at(2), updatedAt: at(6) })
    // An Undo's delete with a stamp takes only the row that still carries it.
    expect(applyRowOutbox(spec, [a], [{ opId: 'u', kind: 'delete', id: 'a', ifStamp: at(9) }]).map((r) => r.id)).toEqual(['a'])
  })

  it('folds what the server answered into its copy', () => {
    const a = f.row('a', at(1), 1)
    const b = f.row('b', at(2), 2)
    const back = f.row('c', at(3), 3)
    // An add: the row the server returned.
    expect(reconcileRow(spec, [a, b], add('c', 3), back)).toEqual([a, b, back])
    // An edit: replaced by id; none returned (a newer edit won, or the row is gone): left as the server had it.
    const edited = { ...a, updatedAt: at(7) }
    expect(reconcileRow(spec, [a, b], { opId: 'e', kind: 'update', id: 'a', input: f.input(1), editedAt: at(7) }, edited)).toEqual([edited, b])
    const same = reconcileRow(spec, [a, b], { opId: 'e', kind: 'update', id: 'a', input: f.input(1), editedAt: at(7) }, null)
    expect(same).toEqual([a, b])
    // A delete: gone, unless the server answered with a row (an Undo's that left it there).
    expect(reconcileRow(spec, [a, b], { opId: 'd', kind: 'delete', id: 'a' }, null)).toEqual([b])
    expect(reconcileRow(spec, [a, b], { opId: 'd', kind: 'delete', id: 'a', ifStamp: at(9) }, a)).toEqual([a, b])
  })

  it('orders by when each was made, then id', () => {
    const rows = [f.row('c', at(2)), f.row('b', at(1)), f.row('a', at(2))]
    expect(sortRows(spec, rows).map((r) => r.id)).toEqual(['b', 'a', 'c'])
  })
})

describe('expenses order', () => {
  it('goes by date first, then by when each was made, then id', () => {
    const e = (id: string, date: string, createdAt: string): Expense => ({ id, date, amount: 1, cardId: null, merchant: '', category: 'other', note: '', source: 'manual', createdAt, updatedAt: createdAt })
    const rows = [e('a', '2026-11-03', at(1)), e('b', '2026-11-01', at(5)), e('c', '2026-11-01', at(2)), e('d', '2026-11-01', at(2))]
    expect(sortRows(EXPENSES_SPEC, rows).map((r) => r.id)).toEqual(['c', 'd', 'b', 'a'])
  })
})

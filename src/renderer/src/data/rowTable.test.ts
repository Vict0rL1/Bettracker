import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Same stand-in builder as moves.test.ts: awaiting the chain yields the next
 * queued reply, so a duplicate insert followed by the reads of the row
 * already there each get their own answer.
 */
const state = vi.hoisted(() => ({
  /** What auth.getSession() answers: signed in unless a test says otherwise. */
  session: { data: { session: { user: { id: 'user-1' } } as unknown }, error: null as Error | null },
  replies: [] as { data: unknown; error: { message: string; code?: string } | null; count?: number | null; status?: number }[],
  calls: [] as { method: string; args: unknown[] }[]
}))

vi.mock('../lib/supabase', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'select', 'insert', 'update', 'delete', 'eq', 'lte', 'order', 'range', 'single', 'maybeSingle', 'channel', 'on', 'subscribe', 'removeChannel']) {
    chain[m] = (...args: unknown[]) => {
      state.calls.push({ method: m, args })
      return chain
    }
  }
  chain.then = (resolve: (v: unknown) => void) => resolve(state.replies.shift() ?? { data: null, error: null, count: null })
  return {
    supabase: {
      ...chain,
      auth: { getSession: async () => state.session }
    }
  }
})

import { InputError } from '../lib/validate'
import { MigrationNeededError, SignedOutError } from './errors'
import { budgetsTable, cardsTable, expensesTable } from './expenses'
import type { PendingOp } from './offline'
import type { RowBase } from './rowStorage'
import type { RowTable } from './rowTable'

const calls = (method: string) => state.calls.filter((c) => c.method === method)
const call = (method: string) => calls(method)[0]

const CARD = '6f9619ff-8b86-d011-b42d-00cf4fc964ff'
const OLD = '2026-11-01T10:00:00.000Z'
const STAMP = '2026-11-02T10:00:00.000Z'
const NEW = '2026-11-03T10:00:00.000Z'
const DUP = { message: 'duplicate key value violates unique constraint "x_pkey"', code: '23505' }

/** One table, as the cases need it: an input, what it writes, a server row and the app row it reads as. */
interface Fixture {
  table: RowTable<RowBase, unknown>
  pg: string
  channel: string
  order: string[]
  input: unknown
  bad: unknown
  columns: Record<string, unknown>
  row: (over?: Record<string, unknown>) => Record<string, unknown>
  app: (over?: Record<string, unknown>) => RowBase
}

const FIXTURES: Fixture[] = [
  {
    table: expensesTable as unknown as RowTable<RowBase, unknown>,
    pg: 'expenses',
    channel: 'expenses-sync',
    order: ['date', 'created_at', 'id'],
    input: { date: '2026-11-17', amount: 4.499, cardId: CARD.toUpperCase(), merchant: ' Café  Central ', category: 'coffee', note: '', source: 'ai' },
    bad: { date: '2026-11-17', amount: 0 },
    // The three columns of migration 009 go with every write, null for an expense in the user's own currency.
    columns: { date: '2026-11-17', amount: 4.5, original_amount: null, original_currency: null, fx_rate: null, card_id: CARD, merchant: 'Café Central', category: 'coffee', note: '', source: 'ai' },
    row: (over = {}) => ({ id: 'r1', user_id: 'user-1', date: '2026-11-17', amount: '4.50', card_id: CARD, merchant: 'Café Central', category: 'coffee', note: null, source: 'ai', created_at: 'C', updated_at: STAMP, ...over }),
    app: (over = {}) =>
      ({ id: 'r1', date: '2026-11-17', amount: 4.5, originalAmount: null, originalCurrency: null, fxRate: null, cardId: CARD, merchant: 'Café Central', category: 'coffee', note: '', source: 'ai', createdAt: 'C', updatedAt: STAMP, ...over }) as RowBase
  },
  {
    table: cardsTable as unknown as RowTable<RowBase, unknown>,
    pg: 'expense_cards',
    channel: 'expense-cards-sync',
    order: ['created_at', 'id'],
    input: { name: ' Visa ', last4: '1234' },
    bad: { name: '' },
    columns: { name: 'Visa', last4: '1234', kind: 'credit', archived: false },
    row: (over = {}) => ({ id: 'r1', user_id: 'user-1', name: 'Visa', last4: '1234', kind: 'credit', archived: false, created_at: 'C', updated_at: STAMP, ...over }),
    app: (over = {}) => ({ id: 'r1', name: 'Visa', last4: '1234', kind: 'credit', archived: false, createdAt: 'C', updatedAt: STAMP, ...over }) as RowBase
  },
  {
    table: budgetsTable as unknown as RowTable<RowBase, unknown>,
    pg: 'expense_budgets',
    channel: 'expense-budgets-sync',
    order: ['created_at', 'id'],
    input: { scope: 'category', target: 'coffee', monthlyLimit: 40.004 },
    bad: { scope: 'category', target: 'coffee', monthlyLimit: 0 },
    columns: { scope: 'category', target: 'coffee', monthly_limit: 40 },
    row: (over = {}) => ({ id: 'r1', user_id: 'user-1', scope: 'category', target: 'coffee', monthly_limit: '40.00', created_at: 'C', updated_at: STAMP, ...over }),
    app: (over = {}) => ({ id: 'r1', scope: 'category', target: 'coffee', monthlyLimit: 40, createdAt: 'C', updatedAt: STAMP, ...over }) as RowBase
  }
]

beforeEach(() => {
  state.session = { data: { session: { user: { id: 'user-1' } } }, error: null }
  state.calls = []
  state.replies = []
})

describe.each(FIXTURES.map((f) => [f.pg, f] as const))('row table: %s', (pg, f) => {
  const t = f.table

  describe('fetchAll', () => {
    it('reads every row of its table in a stable order, page by page, coercing numeric strings', async () => {
      const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => f.row({ id: `r${from + i}` }))
      state.replies = [
        { data: page(1000, 0), error: null, count: 1001 },
        { data: page(1, 1000), error: null, count: 1001 }
      ]
      const rows = await t.fetchAll()
      expect(rows).toHaveLength(1001)
      expect(rows[0]).toEqual(f.app({ id: 'r0' }))
      expect(call('from')?.args).toEqual([pg])
      expect(call('select')?.args).toEqual(['*', { count: 'exact' }])
      expect(calls('order').map((c) => c.args[0])).toEqual([...f.order, ...f.order])
      expect(calls('order').every((c) => (c.args[1] as { ascending: boolean }).ascending)).toBe(true)
      expect(calls('range').map((c) => c.args)).toEqual([
        [0, 999],
        [1000, 1999]
      ])
    })

    it('reads a missing table (008 not run) as the migration hint', async () => {
      state.replies = [{ data: null, error: { message: `Could not find the table 'public.${pg}' in the schema cache`, code: 'PGRST205' } }]
      await expect(t.fetchAll()).rejects.toBeInstanceOf(MigrationNeededError)
    })

    it('without a session, or with another account’s, asks nothing', async () => {
      state.session = { data: { session: null }, error: null }
      await expect(t.fetchAll()).rejects.toBeInstanceOf(SignedOutError)
      state.session = { data: { session: { user: { id: 'someone-else' } } }, error: null }
      await expect(t.fetchAll('user-1')).rejects.toBeInstanceOf(SignedOutError)
      expect(state.calls).toEqual([])
    })
  })

  describe('add', () => {
    it('inserts the clean input with the device id, the user, created_at and the stamp as updated_at', async () => {
      state.replies = [{ data: f.row(), error: null }]
      expect(await t.add(f.input, 'r1', STAMP)).toEqual(f.app())
      expect(call('from')?.args).toEqual([pg])
      expect(call('insert')?.args[0]).toEqual({ id: 'r1', user_id: 'user-1', ...f.columns, created_at: STAMP, updated_at: STAMP })
      expect(calls('update')).toHaveLength(0)
    })

    it('writes the device’s created_at when given (the optimistic row’s)', async () => {
      state.replies = [{ data: [f.row()], error: null }]
      await t.add(f.input, 'r1', STAMP, undefined, OLD)
      expect(call('insert')?.args[0]).toMatchObject({ created_at: OLD, updated_at: STAMP })
    })

    it('refuses bad input before any request', async () => {
      await expect(t.add(f.bad, 'r1', STAMP)).rejects.toBeInstanceOf(InputError)
      expect(state.calls).toEqual([])
    })

    it('reads an empty answer as a row 007 let go (deleted since): null', async () => {
      state.replies = [{ data: [], error: null }]
      expect(await t.add(f.input, 'r1', STAMP)).toBeNull()
    })

    it('on a duplicate id, adopts the row there when it carries this stamp (an earlier attempt landed), never updating it', async () => {
      state.replies = [{ data: null, error: DUP }, { data: f.row(), error: null }]
      expect(await t.add(f.input, 'r1', STAMP)).toEqual(f.app())
      expect(calls('eq').at(-1)?.args).toEqual(['id', 'r1'])
      expect(calls('update')).toHaveLength(0)
    })

    it('on a duplicate id, adopts a newer row as it is', async () => {
      state.replies = [{ data: null, error: DUP }, { data: f.row({ updated_at: NEW }), error: null }]
      expect(await t.add(f.input, 'r1', STAMP)).toEqual(f.app({ updatedAt: NEW }))
      expect(calls('update')).toHaveLength(0)
    })

    it('on a duplicate id with an older row, applies this add as the later edit, under the conflict rule', async () => {
      state.replies = [{ data: null, error: DUP }, { data: f.row({ updated_at: OLD }), error: null }, { data: f.row({ updated_at: STAMP }), error: null }]
      expect(await t.add(f.input, 'r1', STAMP)).toEqual(f.app())
      expect(call('update')?.args[0]).toEqual({ ...f.columns, updated_at: STAMP })
      expect(calls('eq').at(-1)?.args).toEqual(['id', 'r1'])
      expect(call('lte')?.args).toEqual(['updated_at', STAMP])
    })

    it('…and when that update answers nothing (newer still by now), resolves with the row it read back', async () => {
      state.replies = [{ data: null, error: DUP }, { data: f.row({ updated_at: OLD }), error: null }, { data: null, error: null }]
      expect(await t.add(f.input, 'r1', STAMP)).toEqual(f.app({ updatedAt: OLD }))
    })

    it('throws when the row there can’t be read back (tried again later)', async () => {
      state.replies = [{ data: null, error: DUP }, { data: null, error: { message: 'upstream timeout', code: '57014' }, status: 504 }]
      await expect(t.add(f.input, 'r1', STAMP)).rejects.toThrow(/upstream timeout/)
    })

    it('throws when the update that applies this later add fails (tried again later)', async () => {
      state.replies = [{ data: null, error: DUP }, { data: f.row({ updated_at: OLD }), error: null }, { data: null, error: { message: 'upstream timeout', code: '57014' }, status: 504 }]
      await expect(t.add(f.input, 'r1', STAMP)).rejects.toThrow(/upstream timeout/)
      expect(calls('update')).toHaveLength(1)
    })

    it('turns a missing table into the migration hint', async () => {
      state.replies = [{ data: null, error: { message: `Could not find the table 'public.${pg}' in the schema cache`, code: 'PGRST205' } }]
      await expect(t.add(f.input, 'r1', STAMP)).rejects.toBeInstanceOf(MigrationNeededError)
    })

    if (pg !== 'expense_budgets') {
      it('throws the duplicate error (refused) when no row has that id', async () => {
        state.replies = [{ data: null, error: DUP }, { data: null, error: null }]
        await expect(t.add(f.input, 'r1', STAMP)).rejects.toThrow(/duplicate key/)
        expect(calls('select')).toHaveLength(2) // the insert's, then the read back by id
      })
    }
  })

  describe('update', () => {
    it('applies the edit only where the row is not newer, with the edit time as updated_at', async () => {
      state.replies = [{ data: f.row({ updated_at: NEW }), error: null }]
      expect(await t.update('r1', f.input, NEW)).toEqual(f.app({ updatedAt: NEW }))
      expect(call('update')?.args[0]).toEqual({ ...f.columns, updated_at: NEW })
      expect(call('eq')?.args).toEqual(['id', 'r1'])
      expect(call('lte')?.args).toEqual(['updated_at', NEW])
    })

    it('is null when a newer edit won or the row is gone', async () => {
      state.replies = [{ data: null, error: null }]
      expect(await t.update('r1', f.input, NEW)).toBeNull()
    })

    it('refuses bad input before any request', async () => {
      await expect(t.update('r1', f.bad, NEW)).rejects.toBeInstanceOf(InputError)
      expect(state.calls).toEqual([])
    })
  })

  describe('remove', () => {
    it('deletes by id', async () => {
      state.replies = [{ data: null, error: null, count: 1 }]
      expect(await t.remove('r1')).toBeNull()
      expect(call('delete')?.args).toEqual([{ count: 'exact' }])
      expect(calls('eq').map((c) => c.args)).toEqual([['id', 'r1']])
    })

    it('throws when the delete fails', async () => {
      state.replies = [{ data: null, error: { message: 'upstream timeout', code: '57014' }, status: 504 }]
      await expect(t.remove('r1')).rejects.toThrow(/upstream timeout/)
    })

    it('with a stamp, throws when the row can’t be read back after nothing was deleted', async () => {
      state.replies = [{ data: null, error: null, count: 0 }, { data: null, error: { message: 'upstream timeout', code: '57014' }, status: 504 }]
      await expect(t.remove('r1', STAMP)).rejects.toThrow(/upstream timeout/)
    })

    it('with a stamp, only the row that still carries it; else the row as it is now', async () => {
      state.replies = [{ data: null, error: null, count: 0 }, { data: f.row({ updated_at: NEW }), error: null }]
      expect(await t.remove('r1', STAMP)).toEqual(f.app({ updatedAt: NEW }))
      expect(calls('eq').map((c) => c.args)).toEqual([
        ['id', 'r1'],
        ['updated_at', STAMP],
        ['id', 'r1']
      ])
    })
  })

  describe('send', () => {
    it('sends an add stamped with its last folded edit, created when it was queued', async () => {
      state.replies = [{ data: f.row(), error: null }]
      const op: PendingOp<unknown> = { opId: 'o', kind: 'add', id: 'r1', input: f.input, queuedAt: OLD, editedAt: STAMP }
      await t.send(op, 'user-1')
      expect(call('insert')?.args[0]).toMatchObject({ id: 'r1', created_at: OLD, updated_at: STAMP })
    })

    it('sends an add never edited stamped when it was queued', async () => {
      state.replies = [{ data: f.row(), error: null }]
      await t.send({ opId: 'o', kind: 'add', id: 'r1', input: f.input, queuedAt: OLD })
      expect(call('insert')?.args[0]).toMatchObject({ created_at: OLD, updated_at: OLD })
    })

    it('sends an edit and a delete', async () => {
      state.replies = [{ data: f.row(), error: null }]
      await t.send({ opId: 'o', kind: 'update', id: 'r1', input: f.input, editedAt: NEW })
      expect(call('lte')?.args).toEqual(['updated_at', NEW])
      state.calls = []
      state.replies = [{ data: null, error: null, count: 1 }]
      expect(await t.send({ opId: 'o', kind: 'delete', id: 'r1' })).toBeNull()
      expect(call('delete')).toBeDefined()
    })

    it('refuses an import (never built for these tables) without a request', async () => {
      await expect(t.send({ opId: 'o', kind: 'bulk-add', entries: [{ id: 'r1', input: f.input }], queuedAt: OLD })).rejects.toThrow(`${pg} rows are never imported`)
      expect(calls('from')).toHaveLength(0)
    })

    it('waits for a sign-in (SignedOutError) without asking anything, also for another account', async () => {
      state.session = { data: { session: null }, error: null }
      await expect(t.send({ opId: 'o', kind: 'delete', id: 'r1' })).rejects.toBeInstanceOf(SignedOutError)
      state.session = { data: { session: { user: { id: 'someone-else' } } }, error: null }
      await expect(t.send({ opId: 'o', kind: 'add', id: 'r1', input: f.input, queuedAt: OLD }, 'user-1')).rejects.toBeInstanceOf(SignedOutError)
      expect(calls('from')).toHaveLength(0)
    })
  })

  it('subscribes to its own channel, for this user’s rows only', () => {
    const off = t.subscribe('user-1', () => undefined)
    expect(call('channel')?.args).toEqual([f.channel])
    expect(call('on')?.args.slice(0, 2)).toEqual(['postgres_changes', { event: '*', schema: 'public', table: pg, filter: 'user_id=eq.user-1' }])
    off()
    expect(calls('removeChannel')).toHaveLength(1)
  })
})

describe('budgets: an add that meets the same budget under another id', () => {
  const OTHER = { id: 'b-other', user_id: 'user-1', scope: 'total', target: '', monthly_limit: '100.00', created_at: 'C', updated_at: OLD }
  const input = { scope: 'total' as const, target: '', monthlyLimit: 250 }

  it('finds it by scope and target, and applies this later add to that row', async () => {
    state.replies = [{ data: null, error: { message: 'duplicate key value violates unique constraint "expense_budgets_one_per_target"', code: '23505' } }, { data: null, error: null }, { data: OTHER, error: null }, { data: { ...OTHER, monthly_limit: '250.00', updated_at: STAMP }, error: null }]
    const out = await budgetsTable.add(input, 'b-mine', STAMP)
    expect(out).toMatchObject({ id: 'b-other', monthlyLimit: 250, updatedAt: STAMP })
    expect(calls('eq').map((c) => c.args)).toEqual([
      ['id', 'b-mine'],
      ['scope', 'total'],
      ['target', ''],
      ['id', 'b-other']
    ])
    expect(call('update')?.args[0]).toEqual({ scope: 'total', target: '', monthly_limit: 250, updated_at: STAMP })
  })

  it('adopts it as it is when it is newer', async () => {
    state.replies = [{ data: null, error: DUP }, { data: null, error: null }, { data: { ...OTHER, updated_at: NEW }, error: null }]
    expect(await budgetsTable.add(input, 'b-mine', STAMP)).toMatchObject({ id: 'b-other', monthlyLimit: 100 })
    expect(calls('update')).toHaveLength(0)
  })

  it('throws the duplicate error (refused) when nothing is found either way', async () => {
    state.replies = [{ data: null, error: DUP }, { data: null, error: null }, { data: null, error: null }]
    await expect(budgetsTable.add(input, 'b-mine', STAMP)).rejects.toThrow(/duplicate key/)
  })

  it('throws when the lookup by scope and target fails', async () => {
    state.replies = [{ data: null, error: DUP }, { data: null, error: null }, { data: null, error: { message: 'upstream timeout', code: '57014' }, status: 504 }]
    await expect(budgetsTable.add(input, 'b-mine', STAMP)).rejects.toThrow(/upstream timeout/)
  })
})

describe('expenses paid in another currency (migration 009)', () => {
  const usd = { date: '2026-11-13', amount: 16.84, originalAmount: 12, originalCurrency: 'USD', fxRate: 1.4034, merchant: 'Apple.com', category: 'subscriptions' }
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'r1',
    user_id: 'user-1',
    date: '2026-11-13',
    amount: '16.84',
    original_amount: '12.00',
    original_currency: 'USD',
    fx_rate: '1.40340000',
    card_id: null,
    merchant: 'Apple.com',
    category: 'subscriptions',
    note: '',
    source: 'manual',
    created_at: 'C',
    updated_at: STAMP,
    ...over
  })

  it('sends what was paid, its currency and the rate with an add, and reads them back as numbers', async () => {
    state.replies = [{ data: [row()], error: null }]
    const out = await expensesTable.add(usd, 'r1', STAMP)
    expect(call('insert')?.args[0]).toMatchObject({ amount: 16.84, original_amount: 12, original_currency: 'USD', fx_rate: 1.4034 })
    expect(out).toMatchObject({ amount: 16.84, originalAmount: 12, originalCurrency: 'USD', fxRate: 1.4034 })
  })

  it('an edit back to the user’s own currency clears the three (they are always sent)', async () => {
    state.replies = [{ data: row({ original_amount: null, original_currency: null, fx_rate: null }), error: null }]
    const out = await expensesTable.update('r1', { date: '2026-11-13', amount: 16.84 }, NEW)
    expect(call('update')?.args[0]).toEqual({
      date: '2026-11-13',
      amount: 16.84,
      original_amount: null,
      original_currency: null,
      fx_rate: null,
      card_id: null,
      merchant: '',
      category: 'other',
      note: '',
      source: 'manual',
      updated_at: NEW
    })
    expect(out).toMatchObject({ originalAmount: null, originalCurrency: null, fxRate: null })
  })

  it('reads a row from a database still on 008 (no such keys) as an expense in the user’s own currency', async () => {
    const { original_amount: _a, original_currency: _c, fx_rate: _r, ...before009 } = row()
    state.replies = [{ data: [before009], error: null, count: 1 }]
    expect(await expensesTable.fetchAll()).toEqual([expect.objectContaining({ amount: 16.84, originalAmount: null, originalCurrency: null, fxRate: null })])
  })

  it('never reads half an original: a row whose three don’t make sense has none', async () => {
    state.replies = [
      {
        data: [row({ id: 'a', fx_rate: null }), row({ id: 'b', original_currency: 'usd' }), row({ id: 'c', original_amount: '0.00' }), row({ id: 'd', fx_rate: '0' }), row({ id: 'e', original_amount: 'x' })],
        error: null,
        count: 5
      }
    ]
    const got = await expensesTable.fetchAll()
    expect(got).toHaveLength(5)
    for (const e of got) expect(e).toMatchObject({ amount: 16.84, originalAmount: null, originalCurrency: null, fxRate: null })
  })

  it('a database still on 008 refuses the write as "behind" (the change waits, it is not dropped)', async () => {
    state.replies = [{ data: null, error: { message: "Could not find the 'original_amount' column of 'expenses' in the schema cache", code: 'PGRST204' }, status: 400 }]
    await expect(expensesTable.add(usd, 'r1', STAMP)).rejects.toBeInstanceOf(MigrationNeededError)
    // An expense in the user's own currency names the columns too (as nulls), so it waits as well.
    state.replies = [{ data: null, error: { message: "Could not find the 'fx_rate' column of 'expenses' in the schema cache", code: 'PGRST204' }, status: 400 }]
    await expect(expensesTable.update('r1', { date: '2026-11-13', amount: 3 }, NEW)).rejects.toBeInstanceOf(MigrationNeededError)
  })

  it('refuses a bad original before any request', async () => {
    await expect(expensesTable.add({ ...usd, fxRate: 0 }, 'r1', STAMP)).rejects.toBeInstanceOf(InputError)
    await expect(expensesTable.add({ ...usd, originalCurrency: null }, 'r1', STAMP)).rejects.toBeInstanceOf(InputError)
    expect(calls('insert')).toHaveLength(0)
  })
})

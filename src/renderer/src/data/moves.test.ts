import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Same stand-in builder as bets.test.ts, except that awaiting the chain
 * yields the next queued reply, as in settings.test.ts: a duplicate insert is
 * followed by a read of the row already there, and each needs its own answer.
 */
const state = vi.hoisted(() => ({
  replies: [] as { data: unknown; error: { message: string; code?: string } | null; count?: number | null }[],
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
      auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } }, error: null }) }
    }
  }
})

import { addMove, deleteMove, getMoves, sendMoveOp, subscribeToMoves, updateMove } from './moves'
import { MigrationNeededError } from './errors'

const calls = (method: string) => state.calls.filter((c) => c.method === method)
const call = (method: string) => calls(method)[0]

const ROW = { id: 'm1', user_id: 'user-1', date: '2026-03-01', amount: '-120.50', note: 'rent', created_at: 'C', updated_at: 'S' }
const NO_TABLE = { message: "Could not find the table 'public.bankroll_moves' in the schema cache", code: 'PGRST205' }

beforeEach(() => {
  state.calls = []
  state.replies = []
})

describe('getMoves', () => {
  it('reads every move of the table in date order, coercing numeric strings', async () => {
    state.replies = [{ data: [ROW, { ...ROW, id: 'm2', amount: '500', note: null }], error: null }]
    expect(await getMoves()).toEqual([
      { id: 'm1', date: '2026-03-01', amount: -120.5, note: 'rent', createdAt: 'C', updatedAt: 'S' },
      { id: 'm2', date: '2026-03-01', amount: 500, note: '', createdAt: 'C', updatedAt: 'S' }
    ])
    expect(call('from')?.args).toEqual(['bankroll_moves'])
    expect(calls('order').map((c) => c.args[0])).toEqual(['date', 'created_at', 'id'])
    expect(calls('range').map((c) => c.args)).toEqual([[0, 999]])
  })

  it('reads page by page until the counted total is in', async () => {
    const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ ...ROW, id: `m${from + i}` }))
    state.replies = [
      { data: page(1000, 0), error: null, count: 1001 },
      { data: page(1, 1000), error: null, count: 1001 }
    ]
    expect(await getMoves()).toHaveLength(1001)
    expect(calls('range').map((c) => c.args)).toEqual([
      [0, 999],
      [1000, 1999]
    ])
  })

  it('reads a missing table (005 not run) as the migration hint', async () => {
    state.replies = [{ data: null, error: NO_TABLE }]
    await expect(getMoves()).rejects.toBeInstanceOf(MigrationNeededError)
  })
})

describe('addMove', () => {
  it('inserts with the device id, the user, the signed amount and the stamp as updated_at', async () => {
    state.replies = [{ data: ROW, error: null }]
    const out = await addMove({ date: '2026-03-01', amount: -120.499, note: '  rent ' }, 'm1', 'Q')
    expect(call('insert')?.args[0]).toEqual({ id: 'm1', user_id: 'user-1', date: '2026-03-01', amount: -120.5, note: 'rent', updated_at: 'Q' })
    expect(out.amount).toBe(-120.5)
  })

  it('returns the row already there when an earlier attempt landed (23505), never overwriting it', async () => {
    state.replies = [
      { data: null, error: { message: 'duplicate key value violates unique constraint "bankroll_moves_pkey"', code: '23505' } },
      { data: { ...ROW, note: 'edited elsewhere' }, error: null }
    ]
    const out = await addMove({ date: '2026-03-01', amount: -120.5 }, 'm1', 'Q')
    expect(out.note).toBe('edited elsewhere')
    expect(calls('eq').at(-1)?.args).toEqual(['id', 'm1'])
    expect(calls('insert')).toHaveLength(1)
    expect(calls('update')).toHaveLength(0)
  })

  it('throws the duplicate error when the row cannot be read back', async () => {
    state.replies = [{ data: null, error: { message: 'duplicate key value violates unique constraint "bankroll_moves_pkey"', code: '23505' } }, { data: null, error: null }]
    await expect(addMove({ date: '2026-03-01', amount: 5 }, 'm1', 'Q')).rejects.toThrow(/duplicate key/)
  })

  it('turns a missing table into the migration hint', async () => {
    state.replies = [{ data: null, error: NO_TABLE }]
    await expect(addMove({ date: '2026-03-01', amount: 5 }, 'm1', 'Q')).rejects.toBeInstanceOf(MigrationNeededError)
  })

  it('validates before touching the network', async () => {
    await expect(addMove({ date: '2026-03-01', amount: 0.004 }, 'm1', 'Q')).rejects.toThrow(/zero/)
    await expect(addMove({ date: 'nope', amount: 5 }, 'm1', 'Q')).rejects.toThrow(/calendar date/)
    expect(state.calls).toHaveLength(0)
  })
})

describe('updateMove — last write wins by edit time', () => {
  it('writes the edit time as updated_at, only where the row is not newer', async () => {
    state.replies = [{ data: { ...ROW, amount: '300', updated_at: 'E' }, error: null }]
    const out = await updateMove('m1', { date: '2026-03-02', amount: 300, note: 'x' }, 'E')
    expect(call('update')?.args[0]).toEqual({ date: '2026-03-02', amount: 300, note: 'x', updated_at: 'E' })
    expect(call('eq')?.args).toEqual(['id', 'm1'])
    expect(call('lte')?.args).toEqual(['updated_at', 'E'])
    expect(call('maybeSingle')).toBeDefined()
    expect(out).toMatchObject({ amount: 300, updatedAt: 'E' })
  })

  it('returns null when no row matched: a newer edit landed, or the move is gone', async () => {
    state.replies = [{ data: null, error: null }]
    expect(await updateMove('m1', { date: '2026-03-02', amount: 300 }, 'E')).toBeNull()
  })
})

describe('deleteMove', () => {
  it('deletes by id and says whether a row went', async () => {
    state.replies = [{ data: null, error: null, count: 1 }]
    expect(await deleteMove('m1')).toBe(true)
    expect(call('delete')?.args).toEqual([{ count: 'exact' }])
    expect(call('eq')?.args).toEqual(['id', 'm1'])
    state.replies = [{ data: null, error: null, count: 0 }]
    expect(await deleteMove('m1')).toBe(false)
  })
})

describe('sendMoveOp — one queued op, as it goes out', () => {
  const input = { date: '2026-03-01', amount: 500 }

  it('stamps an add with the last edit folded into it, else when it was queued', async () => {
    state.replies = [{ data: ROW, error: null }]
    await sendMoveOp({ opId: 'o', kind: 'add', id: 'm1', input, queuedAt: 'Q', editedAt: 'E' })
    expect(call('insert')?.args[0]).toMatchObject({ id: 'm1', updated_at: 'E' })
    state.calls = []
    state.replies = [{ data: ROW, error: null }]
    const out = await sendMoveOp({ opId: 'o', kind: 'add', id: 'm1', input, queuedAt: 'Q' })
    expect(call('insert')?.args[0]).toMatchObject({ id: 'm1', updated_at: 'Q' })
    expect(out?.id).toBe('m1')
  })

  it('sends an edit with its edit time, and a delete with no row back', async () => {
    state.replies = [{ data: ROW, error: null }]
    await sendMoveOp({ opId: 'o', kind: 'update', id: 'm1', input, editedAt: 'E' })
    expect(call('lte')?.args).toEqual(['updated_at', 'E'])
    state.calls = []
    state.replies = [{ data: null, error: null, count: 1 }]
    expect(await sendMoveOp({ opId: 'o', kind: 'delete', id: 'm1' })).toBeNull()
    expect(call('delete')).toBeDefined()
  })

  it('refuses an import, which is never built for moves, without a request', async () => {
    await expect(sendMoveOp({ opId: 'o', kind: 'bulk-add', entries: [{ id: 'x', input }], queuedAt: 'Q' })).rejects.toThrow(/never imported/)
    expect(state.calls).toHaveLength(0)
  })
})

describe('subscribeToMoves', () => {
  it('listens on its own channel, for this user only', () => {
    const stop = subscribeToMoves('user-1', () => {})
    expect(call('channel')?.args).toEqual(['moves-sync'])
    expect(call('on')?.args[1]).toEqual({ event: '*', schema: 'public', table: 'bankroll_moves', filter: 'user_id=eq.user-1' })
    stop()
    expect(call('removeChannel')).toBeDefined()
  })
})

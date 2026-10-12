import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A stand-in for the Supabase query builder: every method records its call
 * and returns the chain, and awaiting the chain yields whatever `state.result`
 * holds. Enough to check what the data layer sends and how it reads replies.
 */
const state = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as { message: string; code?: string } | null, count: null as number | null },
  /** Answers for the next requests, in order; `result` once they run out. */
  queued: [] as { data: unknown; error: { message: string; code?: string } | null; count: number | null }[],
  calls: [] as { method: string; args: unknown[] }[]
}))

vi.mock('../lib/supabase', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'select', 'insert', 'update', 'upsert', 'delete', 'eq', 'lte', 'order', 'range', 'single', 'maybeSingle']) {
    chain[m] = (...args: unknown[]) => {
      state.calls.push({ method: m, args })
      return chain
    }
  }
  chain.then = (resolve: (v: unknown) => void) => resolve(state.queued.shift() ?? state.result)
  return {
    supabase: {
      ...chain,
      auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } }, error: null }) }
    }
  }
})

import { addBet, addBets, getBets, sendOp, updateBet, updateBetLegacy } from './bets'
import { MigrationNeededError } from './errors'

const call = (method: string) => state.calls.find((c) => c.method === method)

beforeEach(() => {
  state.calls = []
  state.result = { data: null, error: null, count: null }
  state.queued = []
})

describe('updateBet — last write wins by edit time', () => {
  const input = { date: '2026-03-01', amount: 20, stake: 10 }

  it('writes the edit time as updated_at and only where the row is not newer', async () => {
    state.result = { data: { id: 'a', date: '2026-03-01', amount: '20', stake: '10', status: 'won', note: '', created_at: 'c', updated_at: 'E' }, error: null, count: null }
    const out = await updateBet('a', input, 'E')
    expect(call('update')?.args[0]).toMatchObject({ updated_at: 'E', amount: 20, stake: 10, status: 'won' })
    expect(call('eq')?.args).toEqual(['id', 'a'])
    expect(call('lte')?.args).toEqual(['updated_at', 'E'])
    expect(out?.updatedAt).toBe('E')
  })

  it('returns null when no row matched — a newer edit already landed, or the bet is gone', async () => {
    state.result = { data: null, error: null, count: null }
    expect(await updateBet('a', input, 'E')).toBeNull()
  })

  it('validates before touching the network', async () => {
    await expect(updateBet('a', { date: 'nope', amount: 1 }, 'E')).rejects.toThrow(/calendar date/)
    expect(state.calls).toHaveLength(0)
  })
})

describe('inserts carry the time they were queued', () => {
  // The conflict check compares the row's updated_at with the device time of
  // an edit. Left to the server's now(), an insert can land "after" an edit
  // the user made while it was on the wire, and that edit would be refused.
  it('addBet writes the queued time as updated_at', async () => {
    state.result = { data: { id: 'id-1', date: '2026-03-01', amount: '5', status: 'won', note: '', created_at: 'c', updated_at: 'Q' }, error: null, count: null }
    await addBet({ date: '2026-03-01', amount: 5 }, 'id-1', 'Q')
    expect(call('insert')?.args[0]).toMatchObject({ id: 'id-1', updated_at: 'Q' })
  })

  it('addBets writes it on every imported row', async () => {
    state.result = { data: null, error: null, count: 2 }
    await addBets(
      [
        { id: 'x', input: { date: '2026-03-01', amount: 5 } },
        { id: 'y', input: { date: '2026-03-02', amount: -5 } }
      ],
      'Q'
    )
    expect(call('upsert')?.args[0]).toEqual([expect.objectContaining({ id: 'x', updated_at: 'Q' }), expect.objectContaining({ id: 'y', updated_at: 'Q' })])
  })
})

describe('updateBetLegacy — an edit queued by a version from before 003', () => {
  it('sends only the fields that version knew, never status, odds or closing odds', async () => {
    state.result = { data: { id: 'a', date: '2026-03-01', amount: null, status: 'pending', odds: '2.1', note: 'fixed', created_at: 'c', updated_at: 'L' }, error: null, count: null }
    const out = await updateBetLegacy('a', { date: '2026-03-01', amount: 0, note: 'fixed' }, 'L')
    expect(call('update')?.args[0]).toEqual({ date: '2026-03-01', amount: 0, note: 'fixed', updated_at: 'L' })
    expect(call('lte')?.args).toEqual(['updated_at', 'L'])
    expect(out).toMatchObject({ status: 'pending', odds: 2.1 })
  })

  it('carries stake and tags when that version had them', async () => {
    state.result = { data: null, error: null, count: null }
    await updateBetLegacy('a', { date: '2026-03-01', amount: -10, stake: 10, note: '', sport: 'NBA', book: 'DK', betType: 'Spread' }, 'L')
    expect(call('update')?.args[0]).toEqual({ date: '2026-03-01', amount: -10, stake: 10, note: '', sport: 'NBA', book: 'DK', bet_type: 'Spread', updated_at: 'L' })
  })

  it('validates before touching the network', async () => {
    await expect(updateBetLegacy('a', { date: 'nope', amount: 1 }, 'L')).rejects.toThrow(/calendar date/)
    await expect(updateBetLegacy('a', { date: '2026-03-01', amount: Number.NaN }, 'L')).rejects.toThrow(/finite/)
    expect(state.calls).toHaveLength(0)
  })
})

describe('sendOp — one queued op, as it goes out', () => {
  const row = { id: 'a', date: '2026-03-01', amount: '5', status: 'won', note: '', created_at: 'c', updated_at: 'E' }

  it('stamps an add with the time of its content: the last edit folded into it, else when it was queued', async () => {
    state.result = { data: row, error: null, count: null }
    await sendOp({ opId: 'o', kind: 'add', id: 'a', input: { date: '2026-03-01', amount: 5 }, queuedAt: 'Q', editedAt: 'E' })
    expect(call('insert')?.args[0]).toMatchObject({ id: 'a', updated_at: 'E' })
    state.calls = []
    await sendOp({ opId: 'o', kind: 'add', id: 'a', input: { date: '2026-03-01', amount: 5 }, queuedAt: 'Q' })
    expect(call('insert')?.args[0]).toMatchObject({ id: 'a', updated_at: 'Q' })
  })

  it('sends a legacy edit the way that version did, and any other edit in full', async () => {
    state.result = { data: row, error: null, count: null }
    await sendOp({ opId: 'o', kind: 'update', id: 'a', input: { date: '2026-03-01', amount: 5, note: '' }, editedAt: 'L', legacy: true })
    expect(call('update')?.args[0]).toEqual({ date: '2026-03-01', amount: 5, note: '', updated_at: 'L' })
    state.calls = []
    const out = await sendOp({ opId: 'o', kind: 'update', id: 'a', input: { date: '2026-03-01', amount: 5, note: '' }, editedAt: 'E' })
    expect(call('update')?.args[0]).toMatchObject({ amount: 5, status: 'won', updated_at: 'E' })
    expect(out?.id).toBe('a')
  })

  it('stamps every row of an import with its queued time, and returns no row for it or for a delete', async () => {
    state.result = { data: null, error: null, count: 1 }
    expect(await sendOp({ opId: 'o', kind: 'bulk-add', entries: [{ id: 'x', input: { date: '2026-03-01', amount: 5 } }], queuedAt: 'Q' })).toBeNull()
    expect((call('upsert')?.args[0] as { updated_at: string }[])[0].updated_at).toBe('Q')
    state.calls = []
    state.result = { data: null, error: null, count: null }
    expect(await sendOp({ opId: 'o', kind: 'delete', id: 'a' })).toBeNull()
    expect(call('delete')).toBeDefined()
    expect(call('eq')?.args).toEqual(['id', 'a'])
  })
})

describe('reading every row, page by page', () => {
  const rows = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ id: `r${from + i}`, date: '2026-03-01', amount: '1', status: 'won', note: '', created_at: 'c', updated_at: 'u' }))
  const ranges = () => state.calls.filter((c) => c.method === 'range').map((c) => c.args)

  it('keeps asking until the counted total is in, past the 1,000 rows one answer holds', async () => {
    state.queued = [
      { data: rows(1000), error: null, count: 1150 },
      { data: rows(150, 1000), error: null, count: 1150 }
    ]
    const bets = await getBets()
    expect(bets).toHaveLength(1150)
    expect(bets[1149].id).toBe('r1149')
    expect(ranges()).toEqual([
      [0, 999],
      [1000, 1999]
    ])
    // Ordered on something unique, so pages neither skip nor repeat a row.
    expect(state.calls.filter((c) => c.method === 'order').map((c) => c.args[0])).toEqual(['date', 'created_at', 'id', 'date', 'created_at', 'id'])
  })

  it('without a count, stops at the first short page', async () => {
    state.queued = [
      { data: rows(1000), error: null, count: null },
      { data: rows(3, 1000), error: null, count: null }
    ]
    expect(await getBets()).toHaveLength(1003)
    expect(ranges()).toHaveLength(2)
  })

  it('asks once for a history that fits in one page', async () => {
    state.result = { data: rows(12), error: null, count: 12 }
    expect(await getBets()).toHaveLength(12)
    expect(ranges()).toEqual([[0, 999]])
  })

  it('fails the whole read when a later page fails, rather than returning part of it', async () => {
    state.queued = [
      { data: rows(1000), error: null, count: 1500 },
      { data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' }, count: null }
    ]
    await expect(getBets()).rejects.toThrow(/timeout/)
  })
})

describe('reading rows', () => {
  it('coerces numeric strings and derives a status when the column is absent (pre-003 database)', async () => {
    state.result = {
      data: [
        { id: 'a', date: '2026-03-01', amount: '12.50', note: null, created_at: 'c', updated_at: 'u' },
        { id: 'b', date: '2026-03-02', amount: '-4', stake: '4', odds: '1.950', status: 'lost', note: 'x', created_at: 'c', updated_at: 'u' }
      ],
      error: null,
      count: null
    }
    const [a, b] = await getBets()
    expect(a).toMatchObject({ amount: 12.5, stake: null, odds: null, status: 'won', note: '' })
    expect(b).toMatchObject({ amount: -4, stake: 4, odds: 1.95, status: 'lost' })
  })

  it('reads a pending row as having no amount', async () => {
    state.result = { data: [{ id: 'p', date: '2026-03-01', amount: null, status: 'pending', note: null, created_at: 'c', updated_at: 'u' }], error: null, count: null }
    const [p] = await getBets()
    expect(p.status).toBe('pending')
    expect(p.amount).toBeNull()
  })
})

describe('missing migration', () => {
  it('turns a PostgREST unknown-column error into the migration hint', async () => {
    state.result = { data: null, error: { message: "Could not find the 'odds' column of 'entries' in the schema cache", code: 'PGRST204' }, count: null }
    await expect(addBet({ date: '2026-03-01', amount: 5 }, 'id-1')).rejects.toBeInstanceOf(MigrationNeededError)
  })

  it('reads a second bet on one day, before migration 001, as a missing migration', async () => {
    state.result = { data: null, error: { message: 'duplicate key value violates unique constraint "entries_user_id_date_key"', code: '23505' }, count: null }
    await expect(addBet({ date: '2026-03-01', amount: 5 }, 'id-1')).rejects.toBeInstanceOf(MigrationNeededError)
  })

  it('sends odds and status on insert', async () => {
    state.result = { data: { id: 'id-1', date: '2026-03-01', amount: null, stake: '30', odds: '2.1', status: 'pending', note: '', created_at: 'c', updated_at: 'u' }, error: null, count: null }
    const out = await addBet({ date: '2026-03-01', stake: 30, odds: 2.1, status: 'pending' }, 'id-1')
    expect(call('insert')?.args[0]).toMatchObject({ id: 'id-1', user_id: 'user-1', amount: null, stake: 30, odds: 2.1, status: 'pending' })
    expect(out.status).toBe('pending')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A stand-in for the Supabase query builder: every method records its call
 * and returns the chain, and awaiting the chain yields whatever `state.result`
 * holds. Enough to check what the data layer sends and how it reads replies.
 */
const state = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as { message: string; code?: string } | null, count: null as number | null },
  calls: [] as { method: string; args: unknown[] }[]
}))

vi.mock('../lib/supabase', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'select', 'insert', 'update', 'upsert', 'delete', 'eq', 'lte', 'order', 'single', 'maybeSingle']) {
    chain[m] = (...args: unknown[]) => {
      state.calls.push({ method: m, args })
      return chain
    }
  }
  chain.then = (resolve: (v: unknown) => void) => resolve(state.result)
  return {
    supabase: {
      ...chain,
      auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } }, error: null }) }
    }
  }
})

import { addBet, getBets, updateBet, updateBetLegacy } from './bets'
import { MigrationNeededError } from './errors'

const call = (method: string) => state.calls.find((c) => c.method === method)

beforeEach(() => {
  state.calls = []
  state.result = { data: null, error: null, count: null }
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

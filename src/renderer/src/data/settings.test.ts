import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Same stand-in builder as bets.test.ts, except that awaiting the chain
 * yields the next queued reply — saveSettings makes up to three requests in a
 * row (update, then select, then insert) and each needs its own answer.
 */
const state = vi.hoisted(() => ({
  replies: [] as { data: unknown; error: { message: string; code?: string } | null }[],
  calls: [] as { method: string; args: unknown[] }[]
}))

vi.mock('../lib/supabase', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'select', 'insert', 'update', 'eq', 'lte', 'single', 'maybeSingle']) {
    chain[m] = (...args: unknown[]) => {
      state.calls.push({ method: m, args })
      return chain
    }
  }
  chain.then = (resolve: (v: unknown) => void) => resolve(state.replies.shift() ?? { data: null, error: null })
  return {
    supabase: {
      ...chain,
      auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } }, error: null }) }
    }
  }
})

import { getSettings, saveSettings } from './settings'

const calls = (method: string) => state.calls.filter((c) => c.method === method)

const ROW = { user_id: 'user-1', odds_format: 'decimal', unit_size: '25', show_units: true, starting_bankroll: null, default_stake: '10', loss_limit: null, updated_at: 'E' }

beforeEach(() => {
  state.calls = []
  state.replies = []
})

describe('getSettings', () => {
  it('maps the row, coercing numeric strings', async () => {
    state.replies = [{ data: ROW, error: null }]
    expect(await getSettings()).toEqual({
      oddsFormat: 'decimal',
      unitSize: 25,
      showUnits: true,
      startingBankroll: null,
      defaultStake: 10,
      lossLimit: null,
      updatedAt: 'E'
    })
  })

  it('is null for a user who never saved a setting', async () => {
    state.replies = [{ data: null, error: null }]
    expect(await getSettings()).toBeNull()
  })

  it('falls back to the default odds format on an unknown value', async () => {
    state.replies = [{ data: { ...ROW, odds_format: 'martian' }, error: null }]
    expect((await getSettings())?.oddsFormat).toBe('american')
  })
})

describe('saveSettings — last write wins by edit time', () => {
  it('updates with the edit time as updated_at, only where the row is not newer', async () => {
    state.replies = [{ data: { ...ROW, odds_format: 'fractional' }, error: null }]
    const out = await saveSettings({ oddsFormat: 'fractional' }, 'E')
    expect(calls('update')[0]?.args[0]).toEqual({ odds_format: 'fractional', updated_at: 'E' })
    expect(calls('eq')[0]?.args).toEqual(['user_id', 'user-1'])
    expect(calls('lte')[0]?.args).toEqual(['updated_at', 'E'])
    expect(out?.oddsFormat).toBe('fractional')
    expect(calls('insert')).toHaveLength(0)
  })

  it('inserts the row on a first-ever save', async () => {
    state.replies = [
      { data: null, error: null }, // update matched nothing
      { data: null, error: null }, // no row exists
      { data: { ...ROW, default_stake: '50' }, error: null }
    ]
    const out = await saveSettings({ defaultStake: 50 }, 'E')
    expect(calls('insert')[0]?.args[0]).toEqual({ user_id: 'user-1', default_stake: 50, updated_at: 'E' })
    expect(out?.defaultStake).toBe(50)
  })

  it('returns null when a newer edit from another device already landed', async () => {
    state.replies = [
      { data: null, error: null }, // update refused by the lte check
      { data: { updated_at: 'F' }, error: null } // ...because the row is newer
    ]
    expect(await saveSettings({ defaultStake: 50 }, 'E')).toBeNull()
    expect(calls('insert')).toHaveLength(0)
  })

  it('treats losing the race to insert the first row as a conflict', async () => {
    state.replies = [
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } }
    ]
    expect(await saveSettings({ defaultStake: 50 }, 'E')).toBeNull()
  })

  it('only sends the fields in the patch, keeping explicit nulls', async () => {
    state.replies = [{ data: ROW, error: null }]
    await saveSettings({ unitSize: null, showUnits: false }, 'E')
    expect(calls('update')[0]?.args[0]).toEqual({ unit_size: null, show_units: false, updated_at: 'E' })
  })
})

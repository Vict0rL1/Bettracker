import { beforeEach, describe, expect, it } from 'vitest'
import type { BetEntry } from '../../../shared/types'
import { entry } from '../test-utils'
import {
  applyOutbox,
  clearUserData,
  enqueueOp,
  hydrateEntry,
  loadCache,
  loadOutbox,
  opSize,
  reconcile,
  saveCache,
  saveOutbox,
  sortEntries,
  type PendingOp
} from './offline'

const add = (id: string, over: Partial<BetEntry> = {}): PendingOp => ({
  opId: `op-${id}`,
  kind: 'add',
  id,
  input: { date: over.date ?? '2026-01-01', amount: over.amount ?? 10, stake: over.stake ?? null },
  queuedAt: '2026-01-01T10:00:00.000Z'
})

const update = (id: string, amount: number): PendingOp => ({
  opId: `op-u-${id}`,
  kind: 'update',
  id,
  input: { date: '2026-01-01', amount, stake: null }
})

const del = (id: string): PendingOp => ({ opId: `op-d-${id}`, kind: 'delete', id })

const bulk = (ids: string[]): PendingOp => ({
  opId: 'op-bulk',
  kind: 'bulk-add',
  entries: ids.map((id) => ({ id, input: { date: '2026-02-01', amount: 5, stake: 5 } })),
  queuedAt: '2026-02-01T10:00:00.000Z'
})

beforeEach(() => localStorage.clear())

describe('hydrateEntry', () => {
  it('fills in fields a cache from an older version never stored', () => {
    const old = { id: 'a', date: '2026-01-01', amount: 12, note: 'x', createdAt: 'c', updatedAt: 'u' }
    // Missing stake must land on null, not undefined — undefined would read as
    // "has a stake" downstream and poison ROI with NaN.
    expect(hydrateEntry(old)).toEqual({
      id: 'a',
      date: '2026-01-01',
      amount: 12,
      stake: null,
      note: 'x',
      sport: '',
      book: '',
      betType: '',
      createdAt: 'c',
      updatedAt: 'u'
    })
  })

  it('rejects a non-finite stake', () => {
    expect(hydrateEntry({ id: 'a', date: '2026-01-01', stake: Number.NaN }).stake).toBeNull()
  })

  it('keeps a real stake, including zero', () => {
    expect(hydrateEntry({ id: 'a', date: '2026-01-01', stake: 0 }).stake).toBe(0)
  })
})

describe('cache and outbox persistence', () => {
  it('round-trips the cache per user', () => {
    const rows = [entry({ id: 'a', amount: 5, stake: 10 })]
    saveCache('u1', rows)
    expect(loadCache('u1')).toEqual(rows)
    expect(loadCache('u2')).toBeNull()
  })

  it('hydrates rows written by an older version', () => {
    localStorage.setItem('bettracker:cache:u1', JSON.stringify([{ id: 'a', date: '2026-01-01', amount: 3 }]))
    expect(loadCache('u1')?.[0]).toMatchObject({ stake: null, sport: '', betType: '' })
  })

  it('returns an empty outbox when nothing is stored', () => {
    expect(loadOutbox('u1')).toEqual([])
  })

  it('wipes both on sign-out', () => {
    saveCache('u1', [entry({})])
    saveOutbox('u1', [add('a')])
    clearUserData('u1')
    expect(loadCache('u1')).toBeNull()
    expect(loadOutbox('u1')).toEqual([])
  })
})

describe('sortEntries', () => {
  it('orders by date, then creation, then id', () => {
    const rows = [
      entry({ id: 'c', date: '2026-01-02', createdAt: 'T1' }),
      entry({ id: 'a', date: '2026-01-01', createdAt: 'T2' }),
      entry({ id: 'b', date: '2026-01-01', createdAt: 'T1' })
    ]
    expect(sortEntries(rows).map((e) => e.id)).toEqual(['b', 'a', 'c'])
  })
})

describe('applyOutbox', () => {
  it('shows a pending add before it reaches the server', () => {
    const rows = applyOutbox([], [add('new', { amount: 40, stake: 20 })])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'new', amount: 40, stake: 20, createdAt: '2026-01-01T10:00:00.000Z' })
  })

  it('layers an update onto a server row', () => {
    const server = [entry({ id: 'a', amount: 10, note: 'old', sport: 'NBA' })]
    const rows = applyOutbox(server, [update('a', 99)])
    expect(rows[0].amount).toBe(99)
    // An update carries the whole entry, so absent tags clear rather than linger.
    expect(rows[0].sport).toBe('')
  })

  it('ignores an update for a row that is gone', () => {
    expect(applyOutbox([], [update('missing', 5)])).toEqual([])
  })

  it('hides a pending delete', () => {
    expect(applyOutbox([entry({ id: 'a' })], [del('a')])).toEqual([])
  })

  it('shows every row of a pending import', () => {
    expect(applyOutbox([], [bulk(['x', 'y'])]).map((e) => e.id)).toEqual(['x', 'y'])
  })

  it('applies ops in order', () => {
    const rows = applyOutbox([], [add('a', { amount: 1 }), update('a', 7), del('a')])
    expect(rows).toEqual([])
  })
})

describe('enqueueOp', () => {
  it('rewrites a not-yet-synced add rather than queueing a second op', () => {
    const out = enqueueOp([add('a', { amount: 10 })], update('a', 55))
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('add')
    expect(out[0]).toMatchObject({ input: { amount: 55 } })
  })

  it('collapses repeated edits of one entry into a single update', () => {
    const out = enqueueOp(enqueueOp([], update('a', 1)), update('a', 2))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ input: { amount: 2 } })
  })

  it('cancels an add outright when it is deleted before syncing', () => {
    expect(enqueueOp([add('a')], del('a'))).toEqual([])
  })

  it('drops pending edits when a synced entry is deleted', () => {
    const out = enqueueOp([update('a', 5)], del('a'))
    expect(out).toEqual([del('a')])
  })

  it('keeps ops for other entries untouched', () => {
    const out = enqueueOp([add('a'), add('b')], del('a'))
    expect(out.map((o) => (o.kind === 'bulk-add' ? 'bulk' : o.id))).toEqual(['b'])
  })

  it('replays an import as-is and applies a later edit on top', () => {
    const out = enqueueOp([bulk(['x'])], update('x', 42))
    expect(out).toHaveLength(2)
    expect(out[0].kind).toBe('bulk-add')
    expect(out[1].kind).toBe('update')
  })

  it('never drops an import when one of its rows is deleted', () => {
    const out = enqueueOp([bulk(['x', 'y'])], del('x'))
    expect(out.map((o) => o.kind)).toEqual(['bulk-add', 'delete'])
  })
})

describe('opSize', () => {
  it('counts rows, not ops', () => {
    expect(opSize(add('a'))).toBe(1)
    expect(opSize(bulk(['x', 'y', 'z']))).toBe(3)
  })
})

describe('reconcile', () => {
  it('replaces the optimistic row with what the server returned', () => {
    const server = [entry({ id: 'a', amount: 1 })]
    const saved = entry({ id: 'a', amount: 1, createdAt: '2026-01-01T00:00:00Z' })
    expect(reconcile(server, add('a'), saved)).toEqual([saved])
  })

  it('removes a deleted row', () => {
    expect(reconcile([entry({ id: 'a' })], del('a'), null)).toEqual([])
  })

  it('leaves the server state alone when there is no returned row', () => {
    const server = [entry({ id: 'a' })]
    expect(reconcile(server, update('a', 5), null)).toEqual(server)
  })

  it('folds an import in without waiting for a refetch', () => {
    const rows = reconcile([entry({ id: 'old', date: '2026-01-01' })], bulk(['x', 'y']), null)
    expect(rows.map((e) => e.id)).toEqual(['old', 'x', 'y'])
  })

  it('does not duplicate rows when an import is replayed', () => {
    const first = reconcile([], bulk(['x']), null)
    expect(reconcile(first, bulk(['x']), null)).toHaveLength(1)
  })
})

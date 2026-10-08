import { beforeEach, describe, expect, it } from 'vitest'
import type { Bet } from '../../../shared/types'
import { bet } from '../test-utils'
import {
  applyOutbox,
  clearUserData,
  enqueueOp,
  hydrateBet,
  loadCache,
  loadOutbox,
  opSize,
  reconcile,
  saveCache,
  saveOutbox,
  sortBets,
  type PendingOp
} from './offline'

const add = (id: string, over: Partial<Bet> = {}): PendingOp => ({
  opId: `op-${id}`,
  kind: 'add',
  id,
  input: { date: over.date ?? '2026-01-01', amount: over.amount ?? 10, stake: over.stake ?? null },
  queuedAt: '2026-01-01T10:00:00.000Z'
})

const update = (id: string, amount: number, editedAt = '2026-01-02T10:00:00.000Z'): PendingOp => ({
  opId: `op-u-${id}-${editedAt}`,
  kind: 'update',
  id,
  input: { date: '2026-01-01', amount, stake: null },
  editedAt
})

const del = (id: string): PendingOp => ({ opId: `op-d-${id}`, kind: 'delete', id })

const bulk = (ids: string[]): PendingOp => ({
  opId: 'op-bulk',
  kind: 'bulk-add',
  entries: ids.map((id) => ({ id, input: { date: '2026-02-01', amount: 5, stake: 5 } })),
  queuedAt: '2026-02-01T10:00:00.000Z'
})

beforeEach(() => localStorage.clear())

describe('hydrateBet', () => {
  it('fills in fields a cache from an older version never stored', () => {
    const old = { id: 'a', date: '2026-01-01', amount: 12, note: 'x', createdAt: 'c', updatedAt: 'u' }
    // Missing stake must land on null, not undefined — undefined would read as
    // "has a stake" downstream and poison ROI with NaN. Missing status is what
    // the amount implies, as the 003 migration backfills it.
    expect(hydrateBet(old)).toEqual({
      id: 'a',
      date: '2026-01-01',
      amount: 12,
      stake: null,
      odds: null,
      status: 'won',
      note: 'x',
      sport: '',
      book: '',
      betType: '',
      createdAt: 'c',
      updatedAt: 'u'
    })
  })

  it('derives lost and push the same way', () => {
    expect(hydrateBet({ id: 'a', date: '2026-01-01', amount: -3 }).status).toBe('lost')
    expect(hydrateBet({ id: 'a', date: '2026-01-01', amount: 0 }).status).toBe('push')
  })

  it('treats a row with no amount at all as pending', () => {
    const b = hydrateBet({ id: 'a', date: '2026-01-01' })
    expect(b.status).toBe('pending')
    expect(b.amount).toBeNull()
  })

  it('keeps a stored status even when it disagrees with the amount, and blanks a pending amount', () => {
    expect(hydrateBet({ id: 'a', date: '2026-01-01', amount: 7, status: 'void' }).status).toBe('void')
    const p = hydrateBet({ id: 'a', date: '2026-01-01', amount: 7, status: 'pending' })
    expect(p.amount).toBeNull()
  })

  it('rejects a non-finite stake or odds', () => {
    const b = hydrateBet({ id: 'a', date: '2026-01-01', stake: Number.NaN, odds: Number.POSITIVE_INFINITY })
    expect(b.stake).toBeNull()
    expect(b.odds).toBeNull()
  })

  it('keeps a real stake, including zero, and real odds', () => {
    const b = hydrateBet({ id: 'a', date: '2026-01-01', stake: 0, odds: 1.91 })
    expect(b.stake).toBe(0)
    expect(b.odds).toBe(1.91)
  })
})

describe('cache and outbox persistence', () => {
  it('round-trips the cache per user', () => {
    const rows = [bet({ id: 'a', amount: 5, stake: 10, odds: 2 })]
    saveCache('u1', rows)
    expect(loadCache('u1')).toEqual(rows)
    expect(loadCache('u2')).toBeNull()
  })

  it('hydrates rows written by an older version', () => {
    localStorage.setItem('bettracker:cache:u1', JSON.stringify([{ id: 'a', date: '2026-01-01', amount: 3 }]))
    expect(loadCache('u1')?.[0]).toMatchObject({ stake: null, odds: null, status: 'won', sport: '', betType: '' })
  })

  it('returns an empty outbox when nothing is stored', () => {
    expect(loadOutbox('u1')).toEqual([])
  })

  it('wipes both on sign-out', () => {
    saveCache('u1', [bet({})])
    saveOutbox('u1', [add('a')])
    clearUserData('u1')
    expect(loadCache('u1')).toBeNull()
    expect(loadOutbox('u1')).toEqual([])
  })
})

describe('sortBets', () => {
  it('orders by date, then creation, then id', () => {
    const rows = [
      bet({ id: 'c', date: '2026-01-02', createdAt: 'T1' }),
      bet({ id: 'a', date: '2026-01-01', createdAt: 'T2' }),
      bet({ id: 'b', date: '2026-01-01', createdAt: 'T1' })
    ]
    expect(sortBets(rows).map((b) => b.id)).toEqual(['b', 'a', 'c'])
  })
})

describe('applyOutbox', () => {
  it('shows a pending add before it reaches the server', () => {
    const rows = applyOutbox([], [add('new', { amount: 40, stake: 20 })])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'new', amount: 40, stake: 20, status: 'won', createdAt: '2026-01-01T10:00:00.000Z' })
  })

  it('shows a queued pending bet with no amount', () => {
    const op: PendingOp = { opId: 'o', kind: 'add', id: 'p', input: { date: '2026-01-01', status: 'pending', stake: 25 }, queuedAt: 'Q' }
    const [row] = applyOutbox([], [op])
    expect(row.status).toBe('pending')
    expect(row.amount).toBeNull()
    expect(row.stake).toBe(25)
  })

  it('layers an update onto a server row and stamps it with the edit time', () => {
    const server = [bet({ id: 'a', amount: 10, note: 'old', sport: 'NBA', updatedAt: 'T0' })]
    const rows = applyOutbox(server, [update('a', 99, 'T9')])
    expect(rows[0].amount).toBe(99)
    expect(rows[0].status).toBe('won')
    expect(rows[0].updatedAt).toBe('T9')
    // An update carries the whole bet, so absent tags clear rather than linger.
    expect(rows[0].sport).toBe('')
  })

  it('settles a pending row through an update', () => {
    const server = [bet({ id: 'a', status: 'pending', stake: 50 })]
    const op: PendingOp = {
      opId: 'o',
      kind: 'update',
      id: 'a',
      input: { date: '2026-01-01', status: 'lost', amount: -50, stake: 50 },
      editedAt: 'T1'
    }
    const [row] = applyOutbox(server, [op])
    expect(row.status).toBe('lost')
    expect(row.amount).toBe(-50)
  })

  it('ignores an update for a row that is gone', () => {
    expect(applyOutbox([], [update('missing', 5)])).toEqual([])
  })

  it('hides a pending delete', () => {
    expect(applyOutbox([bet({ id: 'a' })], [del('a')])).toEqual([])
  })

  it('shows every row of a pending import', () => {
    expect(applyOutbox([], [bulk(['x', 'y'])]).map((b) => b.id)).toEqual(['x', 'y'])
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

  it('collapses repeated edits of one bet into a single update, keeping the latest edit time', () => {
    const out = enqueueOp(enqueueOp([], update('a', 1, 'T1')), update('a', 2, 'T2'))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'update', input: { amount: 2 }, editedAt: 'T2' })
  })

  it('cancels an add outright when it is deleted before syncing', () => {
    expect(enqueueOp([add('a')], del('a'))).toEqual([])
  })

  it('drops pending edits when a synced bet is deleted', () => {
    const out = enqueueOp([update('a', 5)], del('a'))
    expect(out).toEqual([del('a')])
  })

  it('keeps ops for other bets untouched', () => {
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
    const server = [bet({ id: 'a', amount: 1 })]
    const saved = bet({ id: 'a', amount: 1, createdAt: '2026-01-01T00:00:00Z' })
    expect(reconcile(server, add('a'), saved)).toEqual([saved])
  })

  it('removes a deleted row', () => {
    expect(reconcile([bet({ id: 'a' })], del('a'), null)).toEqual([])
  })

  it('leaves the server state alone when an update was refused (lost the conflict)', () => {
    // The refresh that follows the drain brings the winning version; nothing
    // here may guess at it.
    const server = [bet({ id: 'a', amount: 5, note: 'theirs' })]
    expect(reconcile(server, update('a', 9), null)).toEqual(server)
  })

  it('folds an import in without waiting for a refetch', () => {
    const rows = reconcile([bet({ id: 'old', date: '2026-01-01' })], bulk(['x', 'y']), null)
    expect(rows.map((b) => b.id)).toEqual(['old', 'x', 'y'])
  })

  it('does not duplicate rows when an import is replayed', () => {
    const first = reconcile([], bulk(['x']), null)
    expect(reconcile(first, bulk(['x']), null)).toHaveLength(1)
  })
})

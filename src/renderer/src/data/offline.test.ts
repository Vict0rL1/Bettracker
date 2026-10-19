import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type BankrollMove, type Bet } from '../../../shared/types'
import { bet } from '../test-utils'
import {
  afterSettingsAnswer,
  applyMoveOutbox,
  applyOutbox,
  clearUserData,
  readOutbox,
  enqueueOp,
  headAsSent,
  insertStamp,
  hydrateBet,
  hydrateMove,
  loadCache,
  loadMoveCache,
  loadMoveOutbox,
  loadOutbox,
  loadSettingsCache,
  loadSettingsOutbox,
  opSize,
  reconcile,
  reconcileMove,
  editSettings,
  landImport,
  markHeadSent,
  markSignedIn,
  requeueOp,
  keepRefused,
  requeueRefused,
  saveCache,
  saveMoveCache,
  saveMoveOutbox,
  saveOutbox,
  saveSettingsCache,
  saveSettingsOutbox,
  sortBets,
  sortMoves,
  type MoveOp,
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

/** An import whose first `done` rows the server has confirmed. */
const imported = (ids: string[], done: number) => ({ ...(bulk(ids) as Extract<PendingOp, { kind: 'bulk-add' }>), done })

beforeEach(() => {
  localStorage.clear()
  // A test that signs a user out leaves them so for the module (see clearUserData).
  for (const uid of ['u1', 'u2', 'u3']) markSignedIn(uid)
})

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
      closingOdds: null,
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

  // Failing to store a cache is fine (the server has it); failing to store a
  // queue is not, and it used to be swallowed as if it had worked.
  it('a cache that can’t be stored is let go; a queue that can’t be stored says so', () => {
    const setItem = localStorage.setItem.bind(localStorage)
    localStorage.setItem = () => {
      throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })
    }
    try {
      expect(() => saveCache('u1', [bet({})])).not.toThrow()
      expect(() => saveOutbox('u1', [add('a')])).toThrow(/could not store/)
      expect(() => saveMoveOutbox('u1', [])).toThrow(/could not store/)
      expect(() => saveSettingsOutbox('u1', { patch: { unitSize: 25 }, editedAt: 'E' })).toThrow(/could not store/)
    } finally {
      localStorage.setItem = setItem
    }
  })

  it('reads the queue exactly as stored for a change under its lock: the head is not marked sent', () => {
    saveOutbox('u1', [add('a')])
    expect(readOutbox('u1')[0].sent).toBeUndefined()
    expect(loadOutbox('u1')[0].sent).toBe(true)
  })

  it('wipes both on sign-out', () => {
    saveCache('u1', [bet({})])
    saveOutbox('u1', [add('a')])
    clearUserData('u1')
    expect(loadCache('u1')).toBeNull()
    expect(loadOutbox('u1')).toEqual([])
  })

  // A sync still out when the user signed out wrote their copy back once it
  // ended: the data sign-out had just removed from the device.
  it('stores nothing more of a user who signed out, until they sign in again', () => {
    clearUserData('u3')
    saveCache('u3', [bet({})])
    saveOutbox('u3', [add('a')])
    saveSettingsCache('u3', DEFAULT_SETTINGS)
    saveSettingsOutbox('u3', { patch: { defaultStake: 10 }, editedAt: 'E' })
    saveMoveCache('u3', [])
    saveMoveOutbox('u3', [{ opId: 'm', kind: 'delete', id: 'x' }])
    expect(loadCache('u3')).toBeNull()
    expect(loadOutbox('u3')).toEqual([])
    expect(loadSettingsCache('u3')).toBeNull()
    expect(loadSettingsOutbox('u3')).toBeNull()
    expect(loadMoveCache('u3')).toBeNull()
    expect(loadMoveOutbox('u3')).toEqual([])
    markSignedIn('u3')
    saveCache('u3', [bet({})])
    expect(loadCache('u3')).toHaveLength(1)
  })
})

describe('settings cache and outbox', () => {
  const full = { ...DEFAULT_SETTINGS, oddsFormat: 'decimal' as const, defaultStake: 25, updatedAt: 'E' }

  it('round-trips the settings row per user', () => {
    saveSettingsCache('u1', full)
    expect(loadSettingsCache('u1')).toEqual(full)
    expect(loadSettingsCache('u2')).toBeNull()
  })

  it('fills in settings a cache from an older version never stored', () => {
    localStorage.setItem('bettracker:settings:u1', JSON.stringify({ oddsFormat: 'fractional', updatedAt: 'E' }))
    expect(loadSettingsCache('u1')).toEqual({ ...DEFAULT_SETTINGS, oddsFormat: 'fractional', updatedAt: 'E' })
  })

  it('holds at most one pending patch, and null clears it', () => {
    expect(loadSettingsOutbox('u1')).toBeNull()
    saveSettingsOutbox('u1', { patch: { defaultStake: 10 }, editedAt: 'E' })
    expect(loadSettingsOutbox('u1')).toEqual({ patch: { defaultStake: 10 }, editedAt: 'E' })
    saveSettingsOutbox('u1', null)
    expect(loadSettingsOutbox('u1')).toBeNull()
    expect(localStorage.getItem('bettracker:settings-outbox:u1')).toBeNull()
  })

  it('is wiped on sign-out with the rest', () => {
    saveSettingsCache('u1', full)
    saveSettingsOutbox('u1', { patch: { defaultStake: 10 }, editedAt: 'E' })
    clearUserData('u1')
    expect(loadSettingsCache('u1')).toBeNull()
    expect(loadSettingsOutbox('u1')).toBeNull()
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

describe('loadOutbox — queues written by older versions', () => {
  it('marks an edit queued before migration 003 as legacy, with the time the queue is loaded', () => {
    // Exactly what the version deployed before migration 003 stored.
    const legacy = [
      { opId: 'o1', kind: 'add', id: 'a', input: { date: '2026-08-01', amount: 20, note: 'x' }, queuedAt: '2026-08-01T10:00:00.000Z' },
      { opId: 'o2', kind: 'update', id: 'b', input: { date: '2026-08-02', amount: -15, note: '' } },
      { opId: 'o3', kind: 'delete', id: 'c' }
    ]
    localStorage.setItem('bettracker:outbox:legacy', JSON.stringify(legacy))
    const ops = loadOutbox('legacy', '2026-10-09T12:00:00.000Z')
    expect(ops[0]).toEqual({ ...legacy[0], sent: true })
    expect(ops[1]).toEqual({ ...legacy[1], editedAt: '2026-10-09T12:00:00.000Z', legacy: true })
    expect(ops[2]).toEqual(legacy[2])
  })

  it('leaves an edit that has its time alone', () => {
    saveOutbox('u-now', [del('x'), update('a', 5, 'T1')])
    expect(loadOutbox('u-now', 'LATER')[1]).toEqual(update('a', 5, 'T1'))
  })

  it('headAsSent marks only the head, and only when it is not marked yet', () => {
    expect(headAsSent([]).length).toBe(0)
    const ops = headAsSent([del('a'), del('b')])
    expect(ops.map((o) => o.sent)).toEqual([true, undefined])
    const already = [{ ...del('a'), sent: true as const }]
    expect(headAsSent(already)[0]).toBe(already[0])
  })

  it('takes the head of the queue as sent: it may have gone out with its answer lost', () => {
    // That version kept no `sent`: the add at the head may already be on the server.
    saveOutbox('u-lost', [add('a', { amount: 1 }), add('b', { amount: 2 })])
    const ops = loadOutbox('u-lost')
    expect(ops.map((o) => o.sent)).toEqual([true, undefined])
    // So deleting it sends a delete rather than cancelling the add, and an
    // edit of it goes out after it rather than into it.
    expect(enqueueOp(ops, del('a')).map((o) => o.kind)).toEqual(['add', 'add', 'delete'])
    expect(enqueueOp(ops, update('a', 9, 'T9')).map((o) => o.kind)).toEqual(['add', 'add', 'update'])
    // The ops behind it never went out: those still fold and cancel.
    expect(enqueueOp(ops, del('b')).map((o) => o.opId)).toEqual([ops[0].opId])
  })

  it('shows a legacy edit as the database applies it: only its fields, status by the 003 rule', () => {
    const pending = bet({ id: 'p', status: 'pending', stake: 25, odds: 2.1, closingOdds: 2, sport: 'NBA' })
    const won = bet({ id: 'w', amount: 15, stake: 10, odds: 2.5, closingOdds: 2.4, sport: 'NFL' })
    const view = applyOutbox(
      [pending, won],
      [
        // A note fixed on a bet that version shows as $0: still pending, odds and tags kept.
        { opId: 'l1', kind: 'update', id: 'p', input: { date: pending.date, amount: 0, note: 'fixed' }, editedAt: 'L', legacy: true },
        // A win edited into a loss, with stake (a 002-era version): lost, odds kept.
        { opId: 'l2', kind: 'update', id: 'w', input: { date: won.date, amount: -10, stake: 10, note: '' }, editedAt: 'L', legacy: true }
      ]
    )
    expect(view.find((b) => b.id === 'p')).toMatchObject({ status: 'pending', amount: null, odds: 2.1, closingOdds: 2, stake: 25, sport: 'NBA', note: 'fixed' })
    expect(view.find((b) => b.id === 'w')).toMatchObject({ status: 'lost', amount: -10, odds: 2.5, closingOdds: 2.4, sport: 'NFL' })
  })

  it('makes a legacy edit a full edit once a new edit is folded into it', () => {
    const legacyOp: PendingOp = { opId: 'l1', kind: 'update', id: 'a', input: { date: '2026-01-01', amount: 0, note: 'x' }, editedAt: 'L', legacy: true }
    const out = enqueueOp([legacyOp], update('a', 7, 'T9'))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'update', input: { amount: 7 }, editedAt: 'T9' })
    expect((out[0] as { legacy?: true }).legacy).toBeUndefined()
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

  it('restores a deleted bet by re-adding it after the queued delete (Undo, offline)', () => {
    const server = [bet({ id: 'a', amount: 7 })]
    const out = enqueueOp([del('a')], add('a', { amount: 7 }))
    expect(out.map((o) => o.kind)).toEqual(['delete', 'add'])
    expect(applyOutbox(server, out).map((b) => [b.id, b.amount])).toEqual([['a', 7]])
    // Undoing the deletion of a bet that never reached the server simply adds it again.
    expect(enqueueOp(enqueueOp([add('a')], del('a')), add('a')).map((o) => o.kind)).toEqual(['add'])
  })

  it('deleting a restored bet again keeps a delete for the server, rather than cancelling the whole pair', () => {
    const out = enqueueOp([del('a'), add('a', { amount: 7 })], del('a'))
    expect(out).toEqual([del('a')])
    expect(applyOutbox([bet({ id: 'a', amount: 7 })], out)).toEqual([])
    // A second delete of the same synced bet is not queued twice.
    expect(enqueueOp([del('a')], del('a'))).toEqual([del('a')])
  })

  describe('once an op has been sent', () => {
    // Sent: its request went out (and may be out still, or may have failed),
    // so it may be on the server whatever the answer.
    const sent = <T extends PendingOp>(op: T): T => ({ ...op, sent: true })

    it('queues an edit behind a sent add, instead of rewriting it', () => {
      const a = sent(add('a', { amount: 10 }))
      expect(enqueueOp([a], update('a', 55))).toEqual([a, update('a', 55)])
    })

    it('queues a newer edit behind a sent edit, and folds later ones into that newer one', () => {
      const u = sent(update('a', 1, 'T1'))
      const out = enqueueOp([u], update('a', 2, 'T2'))
      expect(out).toEqual([u, update('a', 2, 'T2')])
      const later = enqueueOp(out, update('a', 3, 'T3'))
      expect(later).toHaveLength(2)
      expect(later[0]).toBe(u)
      expect(later[1]).toMatchObject({ kind: 'update', input: { amount: 3 }, editedAt: 'T3' })
    })

    it('folds an edit into the last op for the bet, never an earlier one', () => {
      // The sent add failed and stays queued, with an edit already behind it.
      const queue = [sent(add('a', { amount: 10 })), update('a', 20, 'T2')]
      const out = enqueueOp(queue, update('a', 30, 'T3'))
      expect(out[0]).toBe(queue[0])
      expect(out[1]).toMatchObject({ kind: 'update', input: { amount: 30 }, editedAt: 'T3' })
      expect(applyOutbox([], out).map((b) => b.amount)).toEqual([30])
    })

    it('cannot cancel a sent add: the delete is queued after it', () => {
      const a = sent(add('a'))
      expect(enqueueOp([a, add('b')], del('a'))).toEqual([a, add('b'), del('a')])
    })

    it('keeps a sent edit when its bet is deleted, and drops the ones still waiting', () => {
      const u = sent(update('a', 1, 'T1'))
      expect(enqueueOp([u, add('c'), update('a', 2, 'T2')], del('a'))).toEqual([u, add('c'), del('a')])
    })

    it('leaves the queue alone for other bets', () => {
      const a = sent(add('a'))
      const out = enqueueOp([a, add('b')], update('b', 9))
      expect(out[0]).toBe(a)
      expect(out[1]).toMatchObject({ kind: 'add', id: 'b', input: { amount: 9 } })
      expect(out).toHaveLength(2)
    })

    it('stamps an add with the last edit folded into it, for the insert and the optimistic row', () => {
      const out = enqueueOp([add('a')], update('a', 9, 'T9'))
      expect(out[0]).toMatchObject({ kind: 'add', queuedAt: '2026-01-01T10:00:00.000Z', editedAt: 'T9' })
      expect(insertStamp(out[0] as Extract<PendingOp, { kind: 'add' }>)).toBe('T9')
      expect(insertStamp(add('b') as Extract<PendingOp, { kind: 'add' }>)).toBe('2026-01-01T10:00:00.000Z')
      expect(applyOutbox([], out)[0]).toMatchObject({ createdAt: '2026-01-01T10:00:00.000Z', updatedAt: 'T9' })
    })
  })
})

// "Send again" queued the refused edit as a new one, and enqueueOp folded it
// into the newer edit queued since: the older content, with its older time,
// replaced the newer edit.
describe('requeueOp: a refused change sent again', () => {
  const T10 = '2026-01-02T10:00:00.000Z'
  const T11 = '2026-01-02T11:00:00.000Z'

  it('an edit with a newer edit of its bet queued adds nothing, even once that one went out', () => {
    const newer = update('a', 99, T11)
    expect(requeueOp([newer], update('a', 1, T10))).toEqual([newer])
    const out = { ...newer, sent: true as const }
    expect(requeueOp([out], update('a', 1, T10))).toEqual([out])
  })

  it('nor with the bet deleted since, or added again by an Undo since', () => {
    expect(requeueOp([del('a')], update('a', 1, T10))).toEqual([del('a')])
    const undo = { ...add('a'), queuedAt: T11 }
    expect(requeueOp([undo], update('a', 1, T10))).toEqual([undo])
  })

  it('otherwise it is queued as a new change: folded into an older edit not yet sent, or after the rest', () => {
    const older = update('a', 5, '2026-01-02T09:00:00.000Z')
    expect(requeueOp([older], update('a', 1, T10))).toEqual([{ ...older, input: { date: '2026-01-01', amount: 1, stake: null }, editedAt: T10 }])
    expect(requeueOp([update('b', 7, T11)], update('a', 1, T10)).map((o) => o.opId)).toEqual([update('b', 7, T11).opId, update('a', 1, T10).opId])
    expect(requeueOp([], add('a'))).toEqual([add('a')])
  })
})

describe('keepRefused: one entry per refused op', () => {
  const T = '2026-01-01T10:00:00.000Z'

  it('adds an entry, and writes the same op’s entry again rather than twice', () => {
    const once = keepRefused([], [add('a')], 'refused', T)
    expect(once).toEqual([{ ops: [add('a')], reason: 'refused', at: T }])
    // Replayed (see store.ts), or written again with an edit folded in.
    expect(keepRefused(once, [add('a')], 'refused', T)).toEqual(once)
    expect(keepRefused(once, [add('a'), update('a', 5)], 'refused', T, true)).toEqual([{ ops: [add('a'), update('a', 5)], reason: 'refused', at: T }])
  })

  it('does not bring back, written again, an entry sent again or let go meanwhile', () => {
    const other = keepRefused([], [add('b')], 'refused', T)
    expect(keepRefused(other, [add('a'), update('a', 5)], 'refused', T, true)).toEqual(other)
  })
})

describe('requeueRefused: refused changes sent again, each as it was queued', () => {
  const fresh = (ops: PendingOp[]) => ops.map((o) => ({ ...o, opId: `again-${o.opId}` }))

  it('an add with its delete behind it is nothing', () => {
    expect(requeueRefused([update('b', 1)], [fresh([add('a'), del('a')])])).toEqual([update('b', 1)])
  })

  it('an add with an edit behind it goes as one add, with the edit', () => {
    const out = requeueRefused([], [fresh([add('a', { amount: 10 }), update('a', 55)])])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'add', id: 'a', input: { amount: 55 } })
  })

  it('a refused edit still gives way to a newer edit queued since', () => {
    const newer = update('a', 99, '2026-01-02T11:00:00.000Z')
    expect(requeueRefused([newer], [fresh([update('a', 1, '2026-01-02T10:00:00.000Z')])])).toEqual([newer])
  })
})

describe('markHeadSent: the head marked as gone out, decided once', () => {
  it('marks the op that led the queue when it first ran, also when replayed on a queue led by another', () => {
    const change = markHeadSent<PendingOp>()
    expect(change([add('a'), add('b')]).map((o) => o.sent)).toEqual([true, undefined])
    // Replayed later (storage full, see store.ts) on a queue whose head was sent since.
    expect(change([add('b'), add('a')]).map((o) => [o.opId, o.sent])).toEqual([
      ['op-b', undefined],
      ['op-a', true]
    ])
  })
})

// A settings edit kept in a window whose storage was full, replayed later
// over a newer edit of the same field stored by another window, undid it.
describe('editSettings: field by field, the newer edit wins', () => {
  it('merges an edit into what is pending, with the time of each field', () => {
    expect(editSettings(null, { unitSize: 25 }, 'T1')).toEqual({ patch: { unitSize: 25 }, editedAt: 'T1', fieldEditedAt: { unitSize: 'T1' } })
  })

  it('an older edit does not undo a newer one of the same field, and still sets the others', () => {
    const stored = { patch: { defaultStake: 20 }, editedAt: 'T2', fieldEditedAt: { defaultStake: 'T2' } }
    expect(editSettings(stored, { defaultStake: 10, oddsFormat: 'decimal' }, 'T1')).toEqual({
      patch: { defaultStake: 20, oddsFormat: 'decimal' },
      editedAt: 'T2',
      fieldEditedAt: { defaultStake: 'T2', oddsFormat: 'T1' }
    })
  })

  it('a patch stored by an older version counts its fields as edited when it was', () => {
    const legacy = { patch: { defaultStake: 20 }, editedAt: 'T2' }
    expect(editSettings(legacy, { defaultStake: 10 }, 'T1').patch).toEqual({ defaultStake: 20 })
    expect(editSettings(legacy, { defaultStake: 30 }, 'T3').patch).toEqual({ defaultStake: 30 })
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

  // A row an earlier attempt stored may have been edited on another device
  // since: the server kept that (the retry inserts only missing rows), and so
  // does the device.
  it('keeps a row the server already had when an import is replayed, as the server has it', () => {
    const edited = bet({ id: 'x', note: 'edited elsewhere', updatedAt: 'T9' })
    const rows = reconcile([edited], bulk(['x', 'y']), null)
    expect(rows.find((b) => b.id === 'x')).toEqual(edited)
    expect(rows.map((b) => b.id).sort()).toEqual(['x', 'y'])
  })
})

describe('deposits and withdrawals', () => {
  const mv = (over: Partial<BankrollMove> & { id: string }): BankrollMove => ({ date: '2026-03-01', amount: 100, note: '', createdAt: 'C', updatedAt: 'U', ...over })
  type AddMoveOp = Extract<MoveOp, { kind: 'add' }>
  const addMove = (id: string, amount: number, over: Partial<AddMoveOp> = {}): AddMoveOp => ({
    opId: `op-${id}`,
    kind: 'add',
    id,
    input: { date: '2026-03-02', amount, note: 'n' },
    queuedAt: 'Q',
    ...over
  })
  const editMove = (id: string, amount: number, editedAt = 'E'): MoveOp => ({ opId: `op-u-${id}`, kind: 'update', id, input: { date: '2026-03-05', amount, note: 'edited' }, editedAt })
  const delMove = (id: string): MoveOp => ({ opId: `op-d-${id}`, kind: 'delete', id })

  describe('hydrateMove', () => {
    it('keeps a good row and fills what is missing with empty text', () => {
      expect(hydrateMove({ id: 'm', date: '2026-03-01', amount: -120.5 })).toEqual({ id: 'm', date: '2026-03-01', amount: -120.5, note: '', createdAt: '', updatedAt: '' })
      expect(hydrateMove(mv({ id: 'm', note: 'payday' }))).toEqual(mv({ id: 'm', note: 'payday' }))
    })

    it('drops a row that would poison the bankroll', () => {
      expect(hydrateMove(null)).toBeNull()
      expect(hydrateMove('m')).toBeNull()
      expect(hydrateMove({ date: '2026-03-01', amount: 5 })).toBeNull() // no id
      expect(hydrateMove({ id: 7, date: '2026-03-01', amount: 5 })).toBeNull()
      expect(hydrateMove({ id: 'm', date: '2026-02-30', amount: 5 })).toBeNull()
      expect(hydrateMove({ id: 'm', amount: 5 })).toBeNull()
      expect(hydrateMove({ id: 'm', date: '2026-03-01', amount: 0 })).toBeNull()
      expect(hydrateMove({ id: 'm', date: '2026-03-01', amount: Number.NaN })).toBeNull()
      expect(hydrateMove({ id: 'm', date: '2026-03-01', amount: '5' })).toBeNull()
      expect(hydrateMove({ id: 'm', date: '2026-03-01' })).toBeNull()
    })
  })

  describe('cache and outbox', () => {
    it('is null, not empty, on a device that never loaded the moves', () => {
      expect(loadMoveCache('u1')).toBeNull()
      saveMoveCache('u1', [])
      expect(loadMoveCache('u1')).toEqual([])
    })

    it('round-trips per user, dropping rows it cannot use', () => {
      const rows = [mv({ id: 'a' }), mv({ id: 'b', amount: -40 })]
      saveMoveCache('u1', rows)
      expect(loadMoveCache('u1')).toEqual(rows)
      expect(loadMoveCache('u2')).toBeNull()
      localStorage.setItem('bettracker:moves:u3', JSON.stringify([mv({ id: 'a' }), { id: 'bad', date: 'x', amount: 5 }, { id: 'c', date: '2026-03-01', amount: 9 }]))
      expect(loadMoveCache('u3')?.map((m) => m.id)).toEqual(['a', 'c'])
    })

    it('reads a stored value that is not a list as never loaded', () => {
      localStorage.setItem('bettracker:moves:u1', JSON.stringify({ id: 'a' }))
      expect(loadMoveCache('u1')).toBeNull()
    })

    it('takes the head of a stored queue as sent', () => {
      expect(loadMoveOutbox('u1')).toEqual([])
      saveMoveOutbox('u1', [addMove('a', 50), addMove('b', -20)])
      expect(loadMoveOutbox('u1').map((o) => o.sent)).toEqual([true, undefined])
    })

    it('keeps its own keys, apart from the bets and the settings', () => {
      saveMoveCache('u1', [mv({ id: 'a' })])
      saveMoveOutbox('u1', [addMove('b', 5)])
      expect(localStorage.getItem('bettracker:moves:u1')).not.toBeNull()
      expect(localStorage.getItem('bettracker:moves-outbox:u1')).not.toBeNull()
      expect(loadCache('u1')).toBeNull()
      expect(loadOutbox('u1')).toEqual([])
    })

    it('is wiped on sign-out with the rest', () => {
      saveMoveCache('u1', [mv({ id: 'a' })])
      saveMoveOutbox('u1', [addMove('b', 5)])
      clearUserData('u1')
      expect(localStorage.getItem('bettracker:moves:u1')).toBeNull()
      expect(localStorage.getItem('bettracker:moves-outbox:u1')).toBeNull()
      expect(loadMoveCache('u1')).toBeNull()
    })
  })

  it('sortMoves orders by date, then creation, then id', () => {
    const rows = [mv({ id: 'c', date: '2026-03-02', createdAt: 'T1' }), mv({ id: 'b', createdAt: 'T2' }), mv({ id: 'z', createdAt: 'T1' }), mv({ id: 'a', createdAt: 'T1' })]
    expect(sortMoves(rows).map((m) => m.id)).toEqual(['a', 'z', 'b', 'c'])
  })

  describe('applyMoveOutbox', () => {
    it('shows a queued add, created when queued and stamped with the time of its content', () => {
      expect(applyMoveOutbox([], [addMove('a', 250)])).toEqual([{ id: 'a', date: '2026-03-02', amount: 250, note: 'n', createdAt: 'Q', updatedAt: 'Q' }])
      expect(applyMoveOutbox([], [addMove('a', 250, { editedAt: 'E' })])[0]).toMatchObject({ createdAt: 'Q', updatedAt: 'E' })
      expect(applyMoveOutbox([], [{ ...addMove('a', -5), input: { date: '2026-03-02', amount: -5 } }])[0].note).toBe('')
    })

    it('lays an edit over the row, stamped with the edit time, and skips one whose row is gone', () => {
      const server = [mv({ id: 'a', amount: 100, note: 'old', createdAt: 'C0' })]
      expect(applyMoveOutbox(server, [editMove('a', -60, 'E9')])).toEqual([{ id: 'a', date: '2026-03-05', amount: -60, note: 'edited', createdAt: 'C0', updatedAt: 'E9' }])
      expect(applyMoveOutbox(server, [editMove('missing', 5)])).toEqual(server)
    })

    it('hides a queued delete, applies ops in order and sorts the result', () => {
      const server = [mv({ id: 'b', date: '2026-03-03' }), mv({ id: 'a', date: '2026-03-01' })]
      expect(applyMoveOutbox(server, [delMove('a')]).map((m) => m.id)).toEqual(['b'])
      expect(applyMoveOutbox(server, []).map((m) => m.id)).toEqual(['a', 'b'])
      expect(applyMoveOutbox([], [addMove('x', 5), editMove('x', 7), delMove('x')])).toEqual([])
    })

    it('ignores an import, which is never built for moves', () => {
      const bulk: MoveOp = { opId: 'imp', kind: 'bulk-add', entries: [{ id: 'x', input: { date: '2026-03-01', amount: 5 } }], queuedAt: 'Q' }
      expect(applyMoveOutbox([mv({ id: 'a' })], [bulk]).map((m) => m.id)).toEqual(['a'])
    })
  })

  describe('reconcileMove', () => {
    it('puts the row the server returned in place of the optimistic one, sorted', () => {
      const saved = mv({ id: 'a', date: '2026-03-01', updatedAt: 'S' })
      const server = [mv({ id: 'b', date: '2026-03-04' }), mv({ id: 'a', date: '2026-03-09' })]
      expect(reconcileMove(server, addMove('a', 100), saved)).toEqual([saved, server[0]])
      expect(reconcileMove([], editMove('n', 3), mv({ id: 'n' })).map((m) => m.id)).toEqual(['n'])
    })

    it('removes a deleted row', () => {
      expect(reconcileMove([mv({ id: 'a' }), mv({ id: 'b' })], delMove('a'), null).map((m) => m.id)).toEqual(['b'])
    })

    it('leaves the server state alone when an edit returned no row', () => {
      const server = [mv({ id: 'a', note: 'theirs' })]
      expect(reconcileMove(server, editMove('a', 9), null)).toEqual(server)
    })
  })
})

describe('applyOutbox — an import that partly landed', () => {
  it('shows a row the server already has as the server has it, and the rest from the import', () => {
    const edited = bet({ id: 'x', note: 'edited elsewhere', updatedAt: 'T9' })
    const view = applyOutbox([edited], [bulk(['x', 'y'])])
    expect(view.find((b) => b.id === 'x')).toEqual(edited)
    expect(view.map((b) => b.id).sort()).toEqual(['x', 'y'])
  })

  // A confirmed row the server no longer has was deleted on another device:
  // the import showed it again.
  it('shows nothing of the rows the server confirmed: those are the server’s', () => {
    const view = applyOutbox([bet({ id: 'y' })], [imported(['x', 'y', 'z'], 2)])
    expect(view.map((b) => b.id).sort()).toEqual(['y', 'z'])
  })
})

describe('landImport: rows the server confirmed, into its copy', () => {
  it('adds the confirmed rows it lacks, and leaves the rows it has as they are', () => {
    const edited = bet({ id: 'x', note: 'edited elsewhere' })
    const rows = landImport([edited], imported(['x', 'y', 'z'], 0), 0, 2)
    expect(rows.map((b) => b.id).sort()).toEqual(['x', 'y'])
    expect(rows.find((b) => b.id === 'x')).toEqual(edited)
  })

  it('on the answer, adds only what this attempt sent: an earlier attempt’s rows are the server’s already', () => {
    expect(reconcile([], imported(['x', 'y', 'z'], 2), null).map((b) => b.id)).toEqual(['z'])
  })
})

describe('settings: what an answer leaves pending', () => {
  const sent = { patch: { unitSize: 25, lossLimit: 100 }, editedAt: 'E1' }

  it('nothing, when nothing was edited while it was out', () => {
    expect(afterSettingsAnswer(sent, sent)).toBeNull()
    expect(afterSettingsAnswer({ ...sent }, sent)).toBeNull()
    expect(afterSettingsAnswer(null, sent)).toBeNull()
  })

  it('the fields edited since, with the newest edit time', () => {
    expect(afterSettingsAnswer({ patch: { unitSize: 25, lossLimit: 200, oddsFormat: 'decimal' }, editedAt: 'E2' }, sent)).toEqual({
      patch: { lossLimit: 200, oddsFormat: 'decimal' },
      editedAt: 'E2'
    })
  })

  it('a field set to null since is an edit too', () => {
    expect(afterSettingsAnswer({ patch: { unitSize: null, lossLimit: 100 }, editedAt: 'E2' }, sent)).toEqual({ patch: { unitSize: null }, editedAt: 'E2' })
  })

  // Set back to the value that went while it was out, and that answer lost
  // to a newer edit elsewhere: the newest edit of all was dropped.
  it('a field set again since, even to the value that went, stays', () => {
    const current = { patch: { unitSize: 25, lossLimit: 100 }, editedAt: 'E3', fieldEditedAt: { unitSize: 'E3', lossLimit: 'E1' } }
    expect(afterSettingsAnswer(current, sent)).toEqual({ patch: { unitSize: 25 }, editedAt: 'E3', fieldEditedAt: { unitSize: 'E3' } })
  })
})


import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type BetInput, type Settings, type SettingsPatch } from '../../../shared/types'
import { batchStatus, type BatchLive } from '../lib/batchStatus'
import { appendConfirmed, changesSince, KEEP_MS, lockName, MAX_ENTRIES, sharedLog, type ConfirmedLogState } from './confirmed'
import { pushSettings } from './drain'
import {
  addAnswer,
  chunkAnswer,
  foldBatchEvent,
  forgetImports,
  freshImports,
  HistoryFullError,
  opsAsEvents,
  prepare,
  recordBatchEvent,
  settingsAnswer,
  undoAnswer,
  undoOrigin,
  type ImportBatch,
  type SettingsField
} from './imports'
import { afterSettingsAnswer, editSettings, enqueueOp, pendingWrite, supersededBy, type MoveOp, type PendingOp, type PendingSettings } from './offline'
import {
  checkSettings,
  continueOperation,
  queueParts,
  redoBatch,
  resumeOperations,
  retrySettingsOf,
  startOperation,
  undoSettingsLog,
  undoSettingsPlan,
  withoutFields,
  type OperationPorts
} from './operations'
import { oneAtATime } from './oneAtATime'
import { evictExpendable } from './store'
import { addsQueued, queuedByBatch, removalsQueued, settledHere } from './useOpQueue'
import { settingsOutcomes } from './useSettings'

const U = 'u-nov5'
const S = '2026-11-05T10:00:00.000Z'
const T2 = '2026-11-05T10:20:00.000Z'
const T3 = '2026-11-05T10:30:00.000Z'
const input = (n: number): BetInput => ({ date: `2026-08-0${n}`, amount: 10 * n, stake: 10, odds: 2, note: `bet ${n}` })

/** The app's ports, over in-memory queues: what was queued, and how often each was asked. */
function fakePorts(over: Partial<{ active: () => boolean; failAdd: boolean; holdAdd: boolean; holdRemove: boolean; holdSettings: boolean; pending: PendingSettings | null }> = {}) {
  const bets: PendingOp[] = []
  const moves: MoveOp[] = []
  let pending: PendingSettings | null = over.pending ?? null
  const calls = { betsAdd: 0, movesAdd: 0, betsRemove: 0, movesRemove: 0, settings: 0 }
  const ports: OperationPorts = {
    userId: U,
    active: over.active ?? (() => true),
    history: {
      fresh: () => freshImports(U),
      change: async (id, fn) => {
        const { changeImport } = await import('./imports')
        return changeImport(U, id, fn)
      }
    },
    bets: {
      queue: async () => bets,
      add: async (payload, o) => {
        calls.betsAdd++
        if (over.failAdd) throw new Error('Amount must be a finite number')
        if (addsQueued(bets, o.batch, o.stamp)) return { saved: true, queued: false }
        bets.push({ opId: `imp-${calls.betsAdd}`, kind: 'bulk-add', entries: payload.map((p) => ({ id: p.id, input: p.input })), queuedAt: o.stamp, batch: o.batch })
        return { saved: !over.holdAdd, queued: true }
      },
      remove: async (targets, batch) => {
        calls.betsRemove++
        for (const t of targets) bets.push({ opId: `del-${t.id}`, kind: 'delete', id: t.id, ifStamp: t.stamp, batch })
        return { saved: !over.holdRemove }
      }
    },
    moves: {
      queue: async () => moves,
      add: async (payload, o) => {
        calls.movesAdd++
        if (addsQueued(moves, o.batch, o.stamp)) return { saved: true, queued: false }
        for (const p of payload) moves.push({ opId: `add-${p.id}`, kind: 'add', id: p.id, input: p.input, queuedAt: o.stamp, batch: o.batch })
        return { saved: true, queued: true }
      },
      remove: async (targets, batch) => {
        calls.movesRemove++
        for (const t of targets) moves.push({ opId: `del-${t.id}`, kind: 'delete', id: t.id, ifStamp: t.stamp, batch })
        return { saved: !over.holdRemove }
      }
    },
    settings: {
      pending: async () => pending,
      write: async (patch, o) => {
        calls.settings++
        if (o.once && pendingWrite(pending, o.origin, o.editedAt)) return true
        pending = editSettings(pending, patch, o.editedAt, o.guard, o.origin)
        return !over.holdSettings
      }
    }
  }
  return { ports, bets, moves, calls, pending: () => pending }
}

const restore = (over: Partial<ImportBatch> = {}): ImportBatch => ({
  id: 'R',
  kind: 'restore',
  at: S,
  file: 'backup.json',
  fingerprint: 'fp',
  ids: ['b1', 'b2'],
  moveIds: ['m1'],
  stamp: S,
  parts: {
    bets: { phase: 'prepared', payload: [{ id: 'b1', input: input(1) }, { id: 'b2', input: input(2) }] },
    moves: { phase: 'prepared', payload: [{ id: 'm1', input: { date: '2026-07-31', amount: 500, note: 'opening' } }] }
  },
  restore: {
    skippedBets: 0,
    skippedMoves: 0,
    skippedDuplicates: 0,
    settings: { before: { oddsFormat: 'decimal' }, after: { oddsFormat: 'american' }, editedAt: S, phase: 'prepared' },
    failed: [],
    held: []
  },
  ...over
})

const live = (q: { bets: readonly PendingOp<unknown>[]; moves: readonly PendingOp<unknown>[] }, over: Partial<BatchLive> = {}): BatchLive => ({
  bets: queuedByBatch(q.bets).get('R') ?? { adds: 0, removals: 0 },
  moves: queuedByBatch(q.moves).get('R') ?? { adds: 0, removals: 0 },
  betsHeld: false,
  movesHeld: false,
  refused: false,
  settingsOrigins: {},
  settingsHeld: false,
  ...over
})

const entryOf = async (id = 'R'): Promise<ImportBatch> => (await freshImports(U)).find((b) => b.id === id) as ImportBatch

/** Storage refuses what is written under keys `refused` picks, while `fn` runs. */
async function refusing<R>(refused: (key: string) => boolean, fn: () => Promise<R>): Promise<R> {
  const setItem = localStorage.setItem
  localStorage.setItem = function (key: string, value: string) {
    if (refused(key)) throw new DOMException('full', 'QuotaExceededError')
    return setItem.call(this, key, value)
  }
  try {
    return await fn()
  } finally {
    localStorage.setItem = setItem
  }
}

beforeEach(() => {
  localStorage.clear()
  forgetImports(U)
})

describe('1 · a restore interrupted is resumed, once, and says only what the server said', () => {
  it('a reload after it was written down but before anything was queued: the next start queues every part, once', async () => {
    const { ports, bets, moves, calls, pending } = fakePorts()
    // The window wrote the operation down, then went (reload) before queueing.
    await prepare(U, restore())
    const before = batchStatus(await entryOf(), live({ bets, moves }))
    expect(before.bets.state).toBe('preparing')
    expect(before.complete).toBe(false)
    expect(before.actions).toContain('resume')

    await resumeOperations(ports)
    expect(bets).toHaveLength(1)
    expect(moves).toHaveLength(1)
    expect(Object.values(pending()?.fieldOrigin ?? {})).toEqual(['R'])
    const after = await entryOf()
    expect(after.parts?.bets).toEqual({ phase: 'queued' })
    expect(after.restore?.settings?.phase).toBe('queued')
    // Started again (another reload): nothing is queued twice.
    await resumeOperations(ports)
    expect(bets).toHaveLength(1)
    expect(moves).toHaveLength(1)
    expect(calls.settings).toBe(1)
  })

  it('a reload between parts: what was queued stays once, what was not is queued', async () => {
    const { ports, bets, moves } = fakePorts()
    await prepare(U, restore({ parts: { bets: { phase: 'queued' }, moves: restore().parts!.moves } }))
    bets.push({ opId: 'x', kind: 'bulk-add', entries: [{ id: 'b1', input: input(1) }, { id: 'b2', input: input(2) }], queuedAt: S, batch: 'R' })
    await resumeOperations(ports)
    expect(bets).toHaveLength(1)
    expect(moves.map((o) => (o.kind === 'bulk-add' ? '' : o.id))).toEqual(['m1'])
  })

  it('queued, but the mark was lost: marked, not queued again', async () => {
    const { ports, bets, calls } = fakePorts()
    await prepare(U, restore({ parts: { bets: restore().parts!.bets } }))
    bets.push({ opId: 'x', kind: 'bulk-add', entries: [{ id: 'b1', input: input(1) }, { id: 'b2', input: input(2) }], queuedAt: S, batch: 'R' })
    await resumeOperations(ports)
    expect(calls.betsAdd).toBe(0)
    expect((await entryOf()).parts?.bets?.phase).toBe('queued')
  })

  it('queued, sent and answered (out of the queue), but the mark was lost: never queued again', async () => {
    const { ports, bets, calls } = fakePorts()
    await prepare(U, restore({ parts: { bets: restore().parts!.bets }, made: ['b1'] }))
    await resumeOperations(ports)
    expect(calls.betsAdd).toBe(0)
    expect(bets).toHaveLength(0)
    // b2 has no answer: never "added" because the queue is empty.
    const st = batchStatus(await entryOf(), live({ bets, moves: [] }))
    expect(st.bets).toMatchObject({ made: 1, unknown: 1, state: 'unknown' })
    expect(st.actions).toContain('check')
  })

  it('a row that can not be queued stops its part, says why, and offers to pick the file again', async () => {
    const { ports } = fakePorts({ failAdd: true })
    await startOperation(ports, restore({ restore: { ...restore().restore!, settings: undefined } }))
    const b = await entryOf()
    expect(b.parts?.bets).toEqual({ phase: 'failed', error: 'Amount must be a finite number' })
    const st = batchStatus(b, live({ bets: [], moves: [] }))
    expect(st.bets).toMatchObject({ state: 'failed', failed: 2 })
    expect(st.actions).toContain('pickAgain')
  })

  it('storage refusing the queue: held (only in this window), and Save again is offered', async () => {
    const { ports, bets } = fakePorts({ holdAdd: true })
    await startOperation(ports, restore({ restore: { ...restore().restore!, settings: undefined } }))
    expect((await entryOf()).parts?.bets?.phase).toBe('held')
    const st = batchStatus(await entryOf(), live({ bets, moves: [] }, { betsHeld: true }))
    expect(st.bets.state).toBe('held')
    expect(st.actions).toContain('saveAgain')
  })

  it('no room for the history: nothing is started, nothing queued', async () => {
    const { ports, bets } = fakePorts()
    await refusing(
      (key) => key.startsWith('bettracker:imports:'),
      () => expect(startOperation(ports, restore())).rejects.toBeInstanceOf(HistoryFullError)
    )
    expect(bets).toHaveLength(0)
  })

  it('another account in meanwhile: nothing of this one is queued', async () => {
    const { ports, bets, moves } = fakePorts({ active: () => false })
    await prepare(U, restore())
    await resumeOperations(ports)
    expect(bets).toHaveLength(0)
    expect(moves).toHaveLength(0)
  })

  it('what the server said of each row: added, already there, skipped, refused; told twice counts once', async () => {
    await prepare(U, restore({ parts: { bets: { phase: 'queued' }, moves: { phase: 'queued' } } }))
    const op = { opId: 'x', kind: 'bulk-add' as const, entries: [{ id: 'b1', input: input(1) }, { id: 'b2', input: input(2) }], queuedAt: S, batch: 'R' }
    await recordBatchEvent(U, chunkAnswer(op, 'bets', { made: ['b1'], present: ['b2'] }))
    await recordBatchEvent(U, chunkAnswer(op, 'bets', { made: ['b1'], present: ['b2'] }))
    const add = { opId: 'm', kind: 'add' as const, id: 'm1', input: { date: '2026-07-31', amount: 500 }, queuedAt: S, batch: 'R' }
    await recordBatchEvent(U, addAnswer(add, 'moves', null)!)
    const st = batchStatus(await entryOf(), live({ bets: [], moves: [] }))
    expect(st.bets).toMatchObject({ made: 1, present: 1, state: 'done' })
    expect(st.moves).toMatchObject({ absent: 1, state: 'done' })
    expect(st.skippedLater).toBe(false)
  })

  it('an add answered with a row of its own stamp was made by it; another stamp, already there; none, skipped', () => {
    const add = { opId: 'a', kind: 'add' as const, id: 'x', input: input(1), queuedAt: S, batch: 'R' }
    expect(addAnswer(add, 'bets', { updatedAt: '2026-11-05T10:00:00+00:00' })).toMatchObject({ made: ['x'] })
    expect(addAnswer(add, 'bets', { updatedAt: T2 })).toMatchObject({ present: ['x'], made: [] })
    expect(addAnswer(add, 'bets', null)).toMatchObject({ absent: ['x'] })
    // Not a batch's: nobody to tell.
    expect(addAnswer({ ...add, batch: undefined }, 'bets', null)).toBeNull()
  })

  it('an Undo interrupted between its tables: each table queued once, the rest after the reload', async () => {
    const { ports, bets, moves, calls } = fakePorts()
    const undone = restore({
      parts: { bets: { phase: 'queued' }, moves: { phase: 'queued' } },
      made: ['b1', 'b2'],
      madeMoves: ['m1'],
      undone: true,
      undo: { at: T2, stamp: S, phase: 'prepared', bets: ['b1', 'b2'], moves: ['m1'], changedHere: 0, goneHere: 0, removed: [], kept: [] }
    })
    await prepare(U, undone)
    // The bets' removals went out before the reload; the moves' did not.
    bets.push({ opId: 'd1', kind: 'delete', id: 'b1', ifStamp: S, batch: 'R' }, { opId: 'd2', kind: 'delete', id: 'b2', ifStamp: S, batch: 'R' })
    await resumeOperations(ports)
    expect(calls.betsRemove).toBe(0)
    expect(moves.map((o) => o.kind)).toEqual(['delete'])
    expect((await entryOf()).undo?.phase).toBe('queued')
    // Answers: one removed, one kept (changed since), one refused.
    await recordBatchEvent(U, undoAnswer({ opId: 'd1', kind: 'delete', id: 'b1', ifStamp: S, batch: 'R' }, 'bets', null)!)
    await recordBatchEvent(U, undoAnswer({ opId: 'd2', kind: 'delete', id: 'b2', ifStamp: S, batch: 'R' }, 'bets', { updatedAt: T2 })!)
    await recordBatchEvent(U, { kind: 'rejected', batch: 'R', table: 'moves', undo: true, stamp: S, ids: ['m1'], reason: 'no' })
    const st = batchStatus(await entryOf(), live({ bets: [], moves: [] }, { refused: true }))
    expect(st.undo).toMatchObject({ removed: 1, kept: 1, failed: 1, failedOpen: true, state: 'refused' })
    expect(st.actions).toEqual(['sendAgain'])
    // Let go from the notice: settled, said as it is.
    expect(batchStatus(await entryOf(), live({ bets: [], moves: [] })).undo).toMatchObject({ failedOpen: false, state: 'done' })
  })

  it('an Undo waits for the batch: while a part is not queued yet, Resume, never Undo', async () => {
    await prepare(U, restore())
    const st = batchStatus(await entryOf(), live({ bets: [], moves: [] }))
    expect(st.actions).toEqual(['resume'])
  })
})

describe('1 · generations: a batch undone and put back is a new one; late answers of the old one are dropped', () => {
  it('an answer for another stamp does not count for the batch as it is now', () => {
    const now = restore({ stamp: T3, parts: { bets: { phase: 'queued' } } })
    const op = { opId: 'x', kind: 'bulk-add' as const, entries: [{ id: 'b1', input: input(1) }], queuedAt: S, batch: 'R' }
    expect(foldBatchEvent([now], chunkAnswer(op, 'bets', { made: ['b1'] }))[0].made).toBeUndefined()
    expect(foldBatchEvent([now], chunkAnswer({ ...op, queuedAt: T3 }, 'bets', { made: ['b1'] }))[0].made).toEqual(['b1'])
  })

  it('an Undo of the Undo re-queues its own rows even when an earlier generation answers late', async () => {
    const { ports, bets } = fakePorts()
    await prepare(U, restore({ parts: { bets: { phase: 'queued' } }, made: ['b1', 'b2'], undone: true, undo: { at: T2, stamp: S, phase: 'queued', bets: ['b1', 'b2'], moves: [], changedHere: 0, goneHere: 0, removed: ['b1', 'b2'], kept: [] } }))
    await continueOperation(ports, 'R', (b) => redoBatch(b, { stamp: T3, now: T3, bets: [{ id: 'b1', input: input(1) }, { id: 'b2', input: input(2) }], moves: [], reverted: [] }))
    // The earlier generation's answer comes late: dropped.
    await recordBatchEvent(U, chunkAnswer({ opId: 'old', kind: 'bulk-add', entries: [], queuedAt: S, batch: 'R' }, 'bets', { made: ['b1'] }))
    expect(bets.map((o) => (o.kind === 'bulk-add' ? o.queuedAt : ''))).toEqual([T3])
    const b = await entryOf()
    expect(b.made).toEqual([])
    expect(b.parts?.bets?.phase).toBe('queued')
  })

  it('an Undo’s delete is about its own generation: an earlier one’s ops for the row are not its business', () => {
    const q: PendingOp[] = [
      // The first generation's add went out, its answer lost; its Undo's delete queued; then put back (T3).
      { opId: 'add1', kind: 'add', id: 'M', input: input(1), queuedAt: S, batch: 'R', sent: true },
      { opId: 'del1', kind: 'delete', id: 'M', ifStamp: S, batch: 'R' },
      { opId: 'add2', kind: 'add', id: 'M', input: input(1), queuedAt: T3, batch: 'R' }
    ]
    // The second Undo cancels the unsent re-add, and leaves the first generation's ops alone.
    expect(enqueueOp(q, { opId: 'del2', kind: 'delete', id: 'M', ifStamp: T3, batch: 'R' }).map((o) => o.opId)).toEqual(['add1', 'del1'])
  })

  it('an Undo whose own re-add was cancelled here is told removed; one kept by an edit folded in, kept', async () => {
    const q: PendingOp[] = [
      { opId: 'add1', kind: 'add', id: 'M', input: input(1), queuedAt: S, batch: 'R', sent: true },
      { opId: 'del1', kind: 'delete', id: 'M', ifStamp: S, batch: 'R' },
      { opId: 'a', kind: 'add', id: 'N', input: input(2), queuedAt: T3, editedAt: '2026-11-05T10:40:00.000Z', batch: 'R' }
    ]
    const told: unknown[] = []
    await settledHere(q, [{ id: 'M', stamp: T3 }, { id: 'N', stamp: T3 }], 'R', 'moves', async (e) => void told.push(e))
    expect(told).toEqual([
      { kind: 'undo', batch: 'R', table: 'moves', stamp: T3, id: 'M', removed: true },
      { kind: 'undo', batch: 'R', table: 'moves', stamp: T3, id: 'N', removed: false }
    ])
  })

  it('what is queued, by generation: adds by stamp, removals by row and stamp', () => {
    const q: PendingOp[] = [
      { opId: 'b', kind: 'bulk-add', entries: [{ id: 'b1', input: input(1) }], queuedAt: S, batch: 'R' },
      { opId: 'd', kind: 'delete', id: 'b1', ifStamp: S, batch: 'R' }
    ]
    expect(addsQueued(q, 'R', S)).toBe(true)
    expect(addsQueued(q, 'R', T3)).toBe(false)
    expect(removalsQueued(q, 'R', [{ id: 'b1', stamp: S }])).toBe(true)
    expect(removalsQueued(q, 'R', [{ id: 'b1', stamp: T3 }])).toBe(false)
  })

  it('refused ops tell their batch, by generation; sent again, they are back in the queue', () => {
    const ops: PendingOp[] = [
      { opId: 'b', kind: 'bulk-add', entries: [{ id: 'b1', input: input(1) }, { id: 'b2', input: input(2) }], queuedAt: S, done: 1, batch: 'R' },
      { opId: 'd', kind: 'delete', id: 'x', ifStamp: S, batch: 'R' },
      { opId: 'u', kind: 'update', id: 'z', input: input(3), editedAt: S }
    ]
    const events = opsAsEvents('rejected', 'bets', ops, 'violates check constraint')
    expect(events).toEqual([
      { kind: 'rejected', batch: 'R', table: 'bets', stamp: S, ids: ['b2'], reason: 'violates check constraint' },
      { kind: 'rejected', batch: 'R', table: 'bets', undo: true, stamp: S, ids: ['x'], reason: 'violates check constraint' }
    ])
    let list = events.reduce((acc, e) => foldBatchEvent(acc, e), [restore({ undo: { at: S, stamp: S, bets: ['x'], moves: [], changedHere: 0, goneHere: 0, removed: [], kept: [] } })])
    expect(list[0].rejected).toEqual(['b2'])
    expect(list[0].reason).toBe('violates check constraint')
    expect(list[0].undo?.failed).toEqual(['x'])
    list = opsAsEvents('requeued', 'bets', ops).reduce((acc, e) => foldBatchEvent(acc, e), list)
    expect(list[0].rejected).toEqual([])
    expect(list[0].undo?.failed).toEqual([])
  })
})

describe('2 · settings restored: reported as the server answered', () => {
  const sent = (patch: SettingsPatch, origin = 'R', at = S): PendingSettings => editSettings(null, patch, at, undefined, origin)

  it('saved: a field the row holds as written is confirmed, another value kept; beaten: kept; refused: rejected with why', () => {
    const p = sent({ oddsFormat: 'american', unitSize: 25 })
    const row = { ...DEFAULT_SETTINGS, oddsFormat: 'american', unitSize: 10, updatedAt: S } as Settings
    expect(settingsOutcomes(p, { stop: 'saved', row })).toEqual([{ origin: 'R', editedAt: S, confirmed: ['oddsFormat'], kept: ['unitSize'], rejected: [] }])
    expect(settingsOutcomes(p, { stop: 'conflict' })).toEqual([{ origin: 'R', editedAt: S, confirmed: [], kept: ['oddsFormat', 'unitSize'], rejected: [] }])
    expect(settingsOutcomes(p, { stop: 'rejected', error: new Error('nope') })).toEqual([
      { origin: 'R', editedAt: S, confirmed: [], kept: [], rejected: ['oddsFormat', 'unitSize'], reason: 'nope' }
    ])
  })

  it('a field the user set (no origin) is nobody’s to hear; two operations, each hears its own', () => {
    let p = sent({ oddsFormat: 'american' })
    p = editSettings(p, { unitSize: 5 }, T2)
    p = editSettings(p, { lossLimit: 50 }, T2, undefined, undoOrigin('Q'))
    const out = settingsOutcomes(p, { stop: 'conflict' })
    expect(out.map((e) => [e.origin, e.kept])).toEqual([
      ['R', ['oddsFormat']],
      [undoOrigin('Q'), ['lossLimit']]
    ])
  })

  it('the answer is told before the patch is settled: a reload in between tells it again, never loses it', async () => {
    const order: string[] = []
    await pushSettings({
      pending: () => sent({ oddsFormat: 'american' }),
      save: async () => ({ ...DEFAULT_SETTINGS, updatedAt: S }),
      answered: () => void order.push('answered'),
      settle: () => void order.push('settled')
    })
    expect(order).toEqual(['answered', 'settled'])
  })

  it('origins stay with what is left pending, and go with what was answered', () => {
    let p = sent({ oddsFormat: 'american', unitSize: 25 })
    const out = p
    p = editSettings(p, { unitSize: 30 }, T2)
    const left = afterSettingsAnswer(p, out)
    expect(left?.patch).toEqual({ unitSize: 30 })
    expect(left?.fieldOrigin).toBeUndefined()
  })

  it('a later edit here before the write went out: that operation’s field is replaced, a later change won', () => {
    const p = sent({ oddsFormat: 'american', unitSize: 25 })
    expect(supersededBy(p, { unitSize: 30 }, T2)).toEqual([{ origin: 'R', editedAt: S, fields: ['unitSize'] }])
    // Its own write again (a retry), or an older edit: nothing replaced.
    expect(supersededBy(p, { unitSize: 30 }, T2, 'R')).toEqual([])
    expect(supersededBy(p, { unitSize: 30 }, '2026-11-05T09:00:00.000Z')).toEqual([])
  })

  it('a write pending already (its origin, its time) is not written again: only the mark was lost', async () => {
    const { ports, calls } = fakePorts({ pending: sent({ oddsFormat: 'american' }) })
    await prepare(U, restore({ parts: {} }))
    await resumeOperations(ports)
    expect(calls.settings).toBe(0)
    expect((await entryOf()).restore?.settings?.phase).toBe('queued')
  })

  it('a field with a change of its own pending here is left to it, and said kept, by a guarded write', async () => {
    const mine = editSettings(null, { oddsFormat: 'fractional' }, T2)
    const { ports, pending } = fakePorts({ pending: mine })
    await prepare(U, restore({ parts: {}, restore: { ...restore().restore!, settings: { before: { oddsFormat: 'decimal' }, after: { oddsFormat: 'american' }, editedAt: T3, guard: { oddsFormat: 'decimal' }, write: ['oddsFormat'], phase: 'prepared' } } }))
    await resumeOperations(ports)
    expect(pending()?.patch).toEqual({ oddsFormat: 'fractional' })
    expect((await entryOf()).restore?.settings).toMatchObject({ kept: ['oddsFormat'], phase: 'queued' })
  })

  it('refused, and after a reload: still refused (failed for the batch), and Try the settings again writes only those, guarded', async () => {
    await prepare(U, restore({ parts: {}, ids: [], moveIds: [], restore: { ...restore().restore!, settings: { before: { oddsFormat: 'decimal', unitSize: 10 }, after: { oddsFormat: 'american', unitSize: 25 }, editedAt: S, phase: 'queued' } } }))
    await recordBatchEvent(U, settingsAnswer({ origin: 'R', editedAt: S, confirmed: ['unitSize'], kept: [], rejected: ['oddsFormat'], reason: 'check constraint' }))
    const st = batchStatus(await entryOf(), live({ bets: [], moves: [] }))
    expect(st.settings).toMatchObject({ confirmed: ['unitSize'], rejected: ['oddsFormat'], reason: 'check constraint', state: 'refused' })
    expect(st.complete).toBe(false)
    expect(st.actions).toEqual(['retrySettings'])
    const { ports, pending } = fakePorts()
    await continueOperation(ports, 'R', (b) => retrySettingsOf(b, T3))
    expect(pending()?.patch).toEqual({ oddsFormat: 'american' })
    expect(pending()?.guard).toEqual({ oddsFormat: 'decimal' })
    expect(pending()?.fieldEditedAt).toEqual({ oddsFormat: T3 })
  })

  it('an edit with no origin, or another operation’s answer, never completes or resets a restore’s settings', () => {
    const b = restore({ parts: {}, restore: { ...restore().restore!, settings: { ...restore().restore!.settings!, phase: 'queued' } } })
    const other = foldBatchEvent([b], settingsAnswer({ origin: 'Q', editedAt: S, confirmed: ['oddsFormat'], kept: [], rejected: [] }))[0]
    expect(other.restore?.settings?.confirmed).toBeUndefined()
    const st = batchStatus(other, live({ bets: [], moves: [] }, { settingsOrigins: { oddsFormat: undefined } }))
    expect(st.settings.state).toBe('unknown')
  })

  it('settingsAnswer: a restore’s answer and its Undo’s, each with the generation it was written with', () => {
    expect(settingsAnswer({ origin: 'R', editedAt: S, confirmed: ['oddsFormat'], kept: [], rejected: [] })).toEqual({
      kind: 'settings',
      batch: 'R',
      undo: false,
      editedAt: S,
      confirmed: ['oddsFormat'],
      kept: [],
      rejected: []
    })
    expect(settingsAnswer({ origin: undoOrigin('R'), confirmed: [], kept: ['lossLimit'], rejected: ['oddsFormat'], reason: 'check' })).toEqual({
      kind: 'settings',
      batch: 'R',
      undo: true,
      confirmed: [],
      kept: ['lossLimit'],
      rejected: ['oddsFormat'],
      reason: 'check'
    })
  })

  it('a late answer to the write from before an Undo of the Undo does not settle the new write', async () => {
    const before = { oddsFormat: 'decimal' as const, lossLimit: null }
    const after = { oddsFormat: 'american' as const, lossLimit: 50 }
    await prepare(U, restore({ parts: {}, ids: [], moveIds: [], restore: { ...restore().restore!, settings: { before, after, editedAt: S, phase: 'queued' } } }))
    const { changeImport } = await import('./imports')
    await changeImport(U, 'R', (b) =>
      redoBatch({ ...b, undone: true, undo: { at: T2, stamp: S, bets: [], moves: [], removed: [], kept: [], changedHere: 0, goneHere: 0, phase: 'queued' } }, { stamp: T3, now: T3, bets: [], moves: [], reverted: ['lossLimit'] })
    )
    await recordBatchEvent(U, settingsAnswer({ origin: 'R', editedAt: S, confirmed: ['oddsFormat', 'lossLimit'], kept: [], rejected: [] }))
    expect((await entryOf()).restore?.settings?.confirmed ?? []).not.toContain('lossLimit')
    await recordBatchEvent(U, settingsAnswer({ origin: 'R', editedAt: T3, confirmed: ['lossLimit'], kept: [], rejected: [] }))
    expect((await entryOf()).restore?.settings?.confirmed).toContain('lossLimit')
  })
})

describe('2 · Check again, and what an Undo does with each setting', () => {
  const s = { before: { oddsFormat: 'decimal' as const, lossLimit: null }, after: { oddsFormat: 'american' as const, lossLimit: 50 } }
  const row = (over: Record<string, unknown>) => ({ oddsFormat: 'decimal', lossLimit: null, ...over })

  it('a restore: the backup’s value is there; another value, kept; the old one, not on the server — whatever the row’s time', () => {
    expect(checkSettings(s, row({ oddsFormat: 'american' }), ['oddsFormat'], false, {})).toEqual({ confirmed: ['oddsFormat'], kept: [], missing: [] })
    expect(checkSettings(s, row({ oddsFormat: 'fractional' }), ['oddsFormat'], false, {})).toEqual({ confirmed: [], kept: ['oddsFormat'], missing: [] })
    expect(checkSettings(s, row({}), ['oddsFormat', 'lossLimit'], false, {})).toEqual({ confirmed: [], kept: [], missing: ['oddsFormat', 'lossLimit'] })
    // No row: the defaults (american is the default odds format).
    expect(checkSettings(s, null, ['oddsFormat'], false, DEFAULT_SETTINGS as unknown as Record<string, unknown>)).toEqual({ confirmed: ['oddsFormat'], kept: [], missing: [] })
  })

  it('an Undo: the old value is back; the backup’s still there, not put back; anything else, someone’s choice', () => {
    expect(checkSettings(s, row({}), ['oddsFormat'], true, {})).toEqual({ confirmed: ['oddsFormat'], kept: [], missing: [] })
    expect(checkSettings(s, row({ oddsFormat: 'american' }), ['oddsFormat'], true, {})).toEqual({ confirmed: [], kept: [], missing: ['oddsFormat'] })
    expect(checkSettings(s, row({ oddsFormat: 'fractional' }), ['oddsFormat'], true, {})).toEqual({ confirmed: [], kept: ['oddsFormat'], missing: [] })
  })

  it('not on the server: finished, said as not added, trying again offered (never done by itself)', () => {
    const b = restore({ parts: {}, ids: [], moveIds: [], restore: { ...restore().restore!, settings: { ...s, editedAt: S, phase: 'queued', confirmed: ['lossLimit'], missing: ['oddsFormat'] } } })
    const st = batchStatus(b, live({ bets: [], moves: [] }))
    expect(st.settings).toMatchObject({ state: 'done', gap: true })
    expect(st).toMatchObject({ complete: true, skippedLater: false, notAdded: 1, addedAny: true, nothingToUndo: false })
    expect(st.actions).toEqual(['retrySettings'])
  })

  it('an Undo’s settings write lost: Check again says not put back, offers the retry, and the retry writes it with its guard', async () => {
    const undone = restore({
      parts: {},
      ids: [],
      moveIds: [],
      undone: true,
      restore: { ...restore().restore!, settings: { ...s, editedAt: S, phase: 'queued', confirmed: ['oddsFormat', 'lossLimit'] } },
      undo: { at: T2, stamp: S, phase: 'queued', bets: [], moves: [], removed: [], kept: [], changedHere: 0, goneHere: 0, settings: { asked: ['oddsFormat', 'lossLimit'], keptHere: [], editedAt: T2, phase: 'held' } }
    })
    expect(batchStatus(undone, live({ bets: [], moves: [] })).undo?.settings?.unknown).toEqual(['oddsFormat', 'lossLimit'])
    const found = checkSettings(s, row({ oddsFormat: 'american', lossLimit: 50 }), ['oddsFormat', 'lossLimit'], true, {})
    const [checked] = foldBatchEvent([undone], { kind: 'settings', batch: 'R', undo: true, editedAt: T2, ...found })
    const st = batchStatus(checked, live({ bets: [], moves: [] }))
    expect(st.undo?.settings).toMatchObject({ missing: ['oddsFormat', 'lossLimit'], gap: true, state: 'done' })
    expect(st.actions).toEqual(['retrySettings'])
    await prepare(U, retrySettingsOf(checked, T3))
    const { ports, pending } = fakePorts()
    await queueParts(ports, 'R')
    expect(pending()?.patch).toEqual({ oddsFormat: 'decimal', lossLimit: null })
    expect(pending()?.guard).toEqual({ oddsFormat: 'american', lossLimit: 50 })
  })

  it('what an Undo does with each setting, and how it is written down', () => {
    expect(undoSettingsPlan(s, { oddsFormat: 'american', lossLimit: 50 })).toEqual({ reverted: ['oddsFormat', 'lossLimit'], keptHere: [], already: [] })
    // Never confirmed as replaced, still the old value: nothing to put back, and no "later change".
    expect(undoSettingsPlan(s, { oddsFormat: 'decimal', lossLimit: 50 })).toEqual({ reverted: ['lossLimit'], keptHere: [], already: ['oddsFormat'] })
    // Replaced, then set back by hand: a later change, kept.
    expect(undoSettingsPlan({ ...s, confirmed: ['oddsFormat'] }, { oddsFormat: 'decimal', lossLimit: 50 })).toEqual({ reverted: ['lossLimit'], keptHere: ['oddsFormat'], already: [] })
    expect(undoSettingsLog(s, { oddsFormat: 'decimal', lossLimit: null }, T2).settings).toEqual({ asked: [], keptHere: [], already: ['oddsFormat', 'lossLimit'], editedAt: T2, phase: 'queued' })
    expect(undoSettingsLog(undefined, {}, T2)).toEqual({ reverted: [], keptHere: [], already: [] })
  })

  it('an Undo of the Undo writes again only what the Undo put back; what it left alone keeps what was known', () => {
    const b = restore({ restore: { ...restore().restore!, settings: { before: { oddsFormat: 'decimal', unitSize: 10 }, after: { oddsFormat: 'american', unitSize: 25 }, editedAt: S, kept: ['unitSize'], confirmed: ['oddsFormat'] } } })
    const redone = redoBatch(b, { stamp: T3, now: T3, bets: [], moves: [], reverted: ['oddsFormat'] })
    expect(redone.restore?.settings).toMatchObject({ confirmed: [], kept: ['unitSize'], write: ['oddsFormat'], editedAt: T3, guard: { oddsFormat: 'decimal', unitSize: 10 } })
    // A field the Undo found already as before stays open (asked again), never "kept".
    const already = redoBatch(
      restore({ undone: true, undo: { at: T2, stamp: S, bets: [], moves: [], removed: [], kept: [], changedHere: 0, goneHere: 0, settings: { asked: ['lossLimit'], keptHere: [], already: ['oddsFormat'] } }, restore: { ...restore().restore!, settings: { ...s, editedAt: S } } }),
      { stamp: T3, now: T3, bets: [], moves: [], reverted: ['lossLimit'] }
    )
    expect(already.restore?.settings?.kept ?? []).not.toContain('oddsFormat')
    expect(withoutFields({ confirmed: ['oddsFormat'], rejected: ['unitSize'], reason: 'r', missing: ['lossLimit'] }, ['unitSize'])).toEqual({ confirmed: ['oddsFormat'], kept: [], missing: ['lossLimit'] })
  })

  it('an undone restore’s settings are no longer wanted: not retried; only its Undo’s are', () => {
    const undone = restore({ undone: true, restore: { ...restore().restore!, settings: { ...s, editedAt: S, missing: ['oddsFormat'] } }, undo: { at: T2, stamp: S, bets: [], moves: [], removed: [], kept: [], changedHere: 0, goneHere: 0, settings: { asked: [], keptHere: [], already: ['oddsFormat'] } } })
    expect(batchStatus(undone, live({ bets: [], moves: [] })).actions).toEqual([])
    expect(retrySettingsOf(undone, T3)).toBe(undone)
  })
})

describe('3 · reads in other windows: a read the log can not vouch for is read again, never installed', () => {
  const noVersions = (): Promise<null> => Promise.resolve(null)
  type Bus = Map<string, Set<(e: MessageEvent) => void>>
  const busOf = (): Bus => new Map()
  const channelOn = (bus: Bus) => (name: string) => {
    const self = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      postMessage: (data: unknown) => {
        for (const fn of bus.get(name) ?? []) if (fn !== handler) fn({ data } as MessageEvent)
      },
      close: () => void bus.get(name)?.delete(handler)
    }
    const handler = (e: MessageEvent): void => self.onmessage?.(e)
    bus.set(name, new Set([...(bus.get(name) ?? []), handler]))
    return self
  }
  const key = `bettracker:confirmed-bets:${U}`
  const two = (clock: { t: number }, bus: Bus | null = null) => {
    const opts = (win: string) => ({ now: () => clock.t, win, versions: noVersions, channel: bus ? channelOn(bus) : null })
    return { here: sharedLog<number>(key, opts('here')), there: sharedLog<number>(key, opts('there')) }
  }
  const apply = (rows: readonly number[], c: number): number[] => [...rows, c]

  it('within what is kept: the other window’s changes since are laid over, in order, and installed', async () => {
    const clock = { t: 1000 }
    const { here, there } = two(clock)
    await there.record(1)
    const read = await here.begin()
    await there.record(2)
    await here.record(99)
    await there.record(3)
    let installed: number[] = []
    expect(await read.finish([0], apply, (r) => (installed = r))).toBe(true)
    expect(installed).toEqual([0, 2, 3])
  })

  it(`more than ${MAX_ENTRIES} confirmations since it went out: not installed`, async () => {
    const clock = { t: 1000 }
    const { here, there } = two(clock)
    const read = await here.begin()
    for (let i = 0; i < MAX_ENTRIES + 1; i++) await there.record(i)
    let installed = false
    expect(await read.finish([], apply, () => (installed = true))).toBe(false)
    expect(installed).toBe(false)
  })

  it(`exactly ${MAX_ENTRIES}: every one is still kept, so it is installed`, async () => {
    const clock = { t: 1000 }
    const { here, there } = two(clock)
    const read = await here.begin()
    for (let i = 0; i < MAX_ENTRIES; i++) await there.record(i)
    expect(await read.finish([], apply, () => undefined)).toBe(true)
  })

  it('a confirmation let go for its age raises the floor: a read from before it is read again', async () => {
    const clock = { t: 1000 }
    const { here, there } = two(clock)
    const read = await here.begin()
    await there.record(1)
    clock.t += KEEP_MS + 1
    await there.record(2)
    expect(await read.finish([], apply, () => undefined)).toBe(false)
  })

  it('the log cleared to make room (a new epoch), or a chunk too big to keep: read again', async () => {
    const clock = { t: 1000 }
    const { here, there } = two(clock)
    const read = await here.begin()
    localStorage.removeItem(key)
    await there.record(1)
    expect(await read.finish([], apply, () => undefined)).toBe(false)
    const again = await here.begin()
    await there.record(null as unknown as number)
    expect(await again.finish([], apply, () => undefined)).toBe(false)
  })

  it('a window that can not write its confirmation down says so: every read out, in any window, is read again', async () => {
    const clock = { t: 1000 }
    const bus = busOf()
    const { here, there } = two(clock, bus)
    let gaps = 0
    here.onGap(() => gaps++)
    const read = await here.begin()
    expect(await refusing((k) => k === key, () => there.record(5))).toBe(false)
    expect(gaps).toBe(1)
    expect(await read.finish([], apply, () => undefined)).toBe(false)
  })

  it('closed and used again (React’s StrictMode runs effects twice): it still hears the other windows', async () => {
    const clock = { t: 1000 }
    const bus = busOf()
    const { here, there } = two(clock, bus)
    here.close()
    let gaps = 0
    here.onGap(() => gaps++)
    await refusing((k) => k === key, () => there.record(5))
    expect(gaps).toBe(1)
  })

  it('two windows writing at once: every entry kept, every number given once', async () => {
    const clock = { t: 1000 }
    const { here, there } = two(clock)
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? here : there).record(i)))
    const state = JSON.parse(localStorage.getItem(key) ?? 'null') as ConfirmedLogState<number>
    expect(state.entries.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(state.entries.map((e) => e.change).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  it('appendConfirmed and changesSince, by themselves', () => {
    let state: ConfirmedLogState<number> = { epoch: '', seq: 0, floor: 0, entries: [] }
    state = appendConfirmed(state, { at: 1, win: 'a', change: 1 }, () => 'E')
    state = appendConfirmed(state, { at: 2, win: 'b', change: 2 }, () => 'X')
    expect(state.epoch).toBe('E')
    expect(changesSince(state, { epoch: 'E', seq: 0 }, 'a')).toEqual([2])
    expect(changesSince(state, { epoch: 'other', seq: 0 }, 'a')).toBeNull()
  })

  it('making room takes the log, never its lock’s version (a holder would wait for a version that is not coming)', () => {
    localStorage.setItem(key, '{}')
    localStorage.setItem(`${lockName(key)}:version`, '7')
    evictExpendable()
    expect(localStorage.getItem(key)).toBeNull()
    expect(localStorage.getItem(`${lockName(key)}:version`)).toBe('7')
  })

  it('one read at a time: calls while one is out share one more read after it', async () => {
    let runs = 0
    let release: () => void = () => undefined
    const read = oneAtATime(async () => {
      runs++
      await new Promise<void>((r) => (release = r))
    })
    const first = read()
    const a = read()
    const b = read()
    expect(a).toBe(b)
    release()
    await first
    await Promise.resolve()
    release()
    await a
    expect(runs).toBe(2)
  })
})

describe('4 · what the history and the details say', () => {
  const quiet = live({ bets: [], moves: [] })
  const imp = (made: string[], missing: string[], present: string[] = [], extra: Partial<ImportBatch> = {}): ImportBatch =>
    ({ id: 'I', at: S, file: 'a.csv', fingerprint: 'fp-i', ids: [...made, ...missing, ...present], moveIds: [], stamp: S, parts: { bets: { phase: 'queued' } }, made, missing, present, ...extra }) as ImportBatch

  it('"nothing added" only when none of it reached the server; a mixed batch is "part"', () => {
    expect(batchStatus(imp(['a'], ['b']), quiet)).toMatchObject({ complete: true, notAdded: 1, addedAny: true, nothingToUndo: false })
    expect(batchStatus(imp([], ['a', 'b']), quiet)).toMatchObject({ complete: true, notAdded: 2, addedAny: false, nothingToUndo: true })
    expect(batchStatus(imp([], ['a'], ['b']), quiet)).toMatchObject({ notAdded: 1, addedAny: true, nothingToUndo: false })
    // Not finished (a row with no answer yet): it may be there, so Undo stays.
    expect(batchStatus({ ...imp([], ['a']), ids: ['a', 'b'] }, quiet)).toMatchObject({ complete: false, nothingToUndo: false })
  })

  it('refused and let go: settled, a gap, "not added"; still in the refused list: Send again', () => {
    const b = imp([], [], [], { ids: ['a', 'b'], rejected: ['a', 'b'] })
    expect(batchStatus(b, quiet)).toMatchObject({ complete: true, notAdded: 2, nothingToUndo: true })
    expect(batchStatus(b, quiet).bets.gap).toBe(true)
    const open = batchStatus(b, { ...quiet, refused: true })
    expect(open.bets).toMatchObject({ state: 'refused', rejectedOpen: true, gap: false })
    expect(open.actions).toEqual(['sendAgain'])
  })

  it('deposits on the server count: a restore whose bets were all refused but whose deposit is there keeps its Undo', () => {
    const r = (over: Partial<ImportBatch>) => batchStatus(restore({ parts: { bets: { phase: 'queued' }, moves: { phase: 'queued' } }, restore: { ...restore().restore!, settings: undefined }, rejected: ['b1', 'b2'], ...over }), quiet)
    expect(r({ madeMoves: ['m1'] })).toMatchObject({ complete: true, notAdded: 2, addedAny: true, nothingToUndo: false })
    expect(r({ presentMoves: ['m1'] })).toMatchObject({ addedAny: true, nothingToUndo: false })
    expect(r({ missingMoves: ['m1'] })).toMatchObject({ addedAny: false, nothingToUndo: true })
  })

  it('an entry from before this version: no answer was kept, and it does not say all of it is on the server', () => {
    const old = { id: 'old', at: S, file: 'old.csv', fingerprint: 'f', ids: ['a', 'b'] } as ImportBatch
    expect(batchStatus(old, live({ bets: [], moves: [] }))).toMatchObject({ complete: true, untracked: 2, actions: [] })
  })

  it('skipped by the server, or kept by a later change: finished, said as skipped', () => {
    expect(batchStatus(imp([], [], [], { ids: ['a', 'b'], made: ['a'], absent: ['b'] }), quiet)).toMatchObject({ complete: true, skippedLater: true, notAdded: 0 })
  })

  it('an undone batch: only its Undo can still need something', () => {
    const u = imp(['a'], [], [], { undone: true, undo: { at: T2, stamp: S, bets: ['a'], moves: [], removed: [], kept: [], changedHere: 0, goneHere: 0, phase: 'queued' } })
    const st = batchStatus(u, quiet)
    expect(st.undo).toMatchObject({ unknown: 1, state: 'unknown' })
    expect(st.actions).toEqual(['check'])
    expect(st.notAdded).toBe(0)
  })
})

/** The fields a test names: typed for SettingsField lists. */
export type { SettingsField }

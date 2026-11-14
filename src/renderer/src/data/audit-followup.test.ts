import { beforeEach, describe, expect, it } from 'vitest'
import type { Bet, Settings } from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/types'
import { batchStatus, type BatchLive } from '../lib/batchStatus'
import { planRestore, settingsChange, type Backup } from '../lib/backup'
import { planImport } from '../lib/importPlan'
import { bet } from '../test-utils'
import { sharedLog } from './confirmed'
import { drainOutbox, type DrainHooks } from './drain'
import type { ImportBatch } from './imports'
import {
  afterSettingsAnswer,
  applyMoveOutbox,
  applyOutbox,
  editSettings,
  enqueueOp,
  readdStamp,
  reconcile,
  sameStamp,
  settingsJournalPrefix,
  type MoveOp,
  type PendingOp
} from './offline'
import { journalEntry, newerSettings, replayJournals } from './settingsJournal'
import { queueStore, StorageWriteError } from './store'
import { queuedByBatch, settledHere } from './useOpQueue'
import type { BatchEvent } from './imports'

/**
 * Regression tests for the follow-up audit of df13583. Each block states the
 * outcome the app must give; before the fix each of these failed.
 */

const S = '2026-11-02T10:00:00.000Z'
const input = { date: '2026-11-01', amount: 5 }

beforeEach(() => localStorage.clear())

describe('restore and Undo: only what the batch wrote, and nobody changed since', () => {
  const undo = (id: string, ifStamp = S): PendingOp => ({ opId: `u-${id}`, kind: 'delete', id, ifStamp, batch: 'B' })

  it('on screen, an Undo hides a row that still carries the batch stamp, and leaves one edited since or never written by it', () => {
    const server = [bet({ id: 'mine', updatedAt: '2026-11-02T10:00:00+00:00' }), bet({ id: 'edited', updatedAt: '2026-11-02T11:00:00Z' }), bet({ id: 'theirs', updatedAt: '2026-10-01T00:00:00Z' })]
    const shown = applyOutbox(server, [undo('mine'), undo('edited'), undo('theirs')])
    expect(shown.map((b) => b.id).sort()).toEqual(['edited', 'theirs'])
  })

  it('in the queue, an Undo leaves alone a row with a change queued since (an edit of a restored deposit)', () => {
    const restored: MoveOp = { opId: 'a', kind: 'add', id: 'm', input: { date: '2026-11-01', amount: 50 }, queuedAt: S, batch: 'B' }
    const edited = enqueueOp([restored], { opId: 'e', kind: 'update', id: 'm', input: { date: '2026-11-01', amount: 60 }, editedAt: '2026-11-02T10:05:00Z' })
    // The edit folded into the add (never sent): its stamp is the edit's now.
    expect(enqueueOp(edited, { opId: 'u', kind: 'delete', id: 'm', ifStamp: S, batch: 'B' })).toEqual(edited)
    // Unchanged and never sent: the Undo cancels the add outright.
    expect(enqueueOp([restored], { opId: 'u', kind: 'delete', id: 'm', ifStamp: S, batch: 'B' })).toEqual([])
    // Sent (it may be on the server): the delete goes behind it, with the stamp.
    const sent = { ...restored, sent: true as const }
    expect(enqueueOp([sent], { opId: 'u', kind: 'delete', id: 'm', ifStamp: S, batch: 'B' }).map((o) => o.opId)).toEqual(['a', 'u'])
    expect(applyMoveOutbox([], [sent, { opId: 'u', kind: 'delete', id: 'm', ifStamp: S, batch: 'B' }])).toEqual([])
  })

  it('a row the server kept comes back as it is now, not removed', () => {
    const kept = bet({ id: 'x', note: 'edited elsewhere' })
    expect(reconcile([bet({ id: 'x' })], undo('x'), kept)).toEqual([kept])
    expect(reconcile([bet({ id: 'x' })], undo('x'), null)).toEqual([])
  })

  it('an Undo of a delete is stamped after what it brings back, even from a clock that ran ahead', () => {
    const now = new Date('2026-11-02T10:00:00Z')
    expect(readdStamp([{ updatedAt: '2026-11-01T00:00:00Z' }], now)).toBe('2026-11-02T10:00:00.000Z')
    expect(readdStamp([{ updatedAt: '2026-11-03T00:00:00Z' }], now)).toBe('2026-11-03T00:00:00.001Z')
    expect(sameStamp('2026-11-02T10:00:00.123Z', '2026-11-02T10:00:00.123+00:00')).toBe(true)
    expect(sameStamp('2026-11-02T10:00:00.123Z', '')).toBe(false)
  })

  it('an Undo that never needs the server (its add had not gone out) says what it did at once', async () => {
    const told: BatchEvent[] = []
    // The queue the Undo's deletes were queued onto.
    const queue: PendingOp[] = [
      // Cancelled outright: its add had not gone out.
      { opId: 'a1', kind: 'add', id: 'cancelled', input, queuedAt: S, batch: 'B' },
      // Kept: an edit folded into its add since keeps it.
      { opId: 'a2', kind: 'add', id: 'kept', input, queuedAt: S, editedAt: 'later', batch: 'B' },
      // Its add went out: the delete goes to the server, whose answer will tell.
      { opId: 'a3', kind: 'add', id: 'sent', input, queuedAt: S, batch: 'B', sent: true },
      // In an import still queued: its delete goes after it.
      { opId: 'imp', kind: 'bulk-add', entries: [{ id: 'imported', input }], queuedAt: S, batch: 'B' }
    ]
    await settledHere(
      queue,
      [
        { id: 'cancelled', stamp: S },
        { id: 'kept', stamp: S },
        { id: 'sent', stamp: S },
        { id: 'imported', stamp: S }
      ],
      'B',
      'moves',
      async (e) => void told.push(e)
    )
    expect(told).toEqual([
      { kind: 'undo', batch: 'B', table: 'moves', stamp: S, id: 'cancelled', removed: true },
      { kind: 'undo', batch: 'B', table: 'moves', stamp: S, id: 'kept', removed: false }
    ])
  })

  it('the queued count of a batch is its rows still to go', () => {
    const q: PendingOp[] = [
      { opId: 'imp', kind: 'bulk-add', entries: [{ id: 'a', input }, { id: 'b', input }, { id: 'c', input }], queuedAt: S, done: 1, batch: 'B' },
      { opId: 'old', kind: 'bulk-add', entries: [{ id: 'd', input }], queuedAt: S },
      undo('z')
    ]
    // An import's rows not yet confirmed, and an Undo's removals, each counted for what it is.
    expect(Object.fromEntries(queuedByBatch(q))).toEqual({ B: { adds: 2, removals: 1 }, old: { adds: 1, removals: 0 } })
  })
})

describe('restore plan: made again before it is applied', () => {
  const backup = (bets: Bet[]): Backup => ({
    format: 'bettracker-backup',
    version: 1,
    exportedAt: S,
    account: { id: 'u1', email: null },
    bets,
    moves: [],
    settings: { oddsFormat: 'decimal', unitSize: 10, showUnits: false, startingBankroll: 1000, defaultStake: null, lossLimit: null }
  })
  const here = (bets: Bet[], settings: Settings = DEFAULT_SETTINGS) => ({ userId: 'u1', bets, moves: [], settings })
  let n = 0
  const ids = () => `new-${n++}`

  it('is the same plan when nothing changed, and a different one when a bet of the backup appeared meanwhile', () => {
    const a = bet({ id: '00000000-0000-4000-8000-000000000001' })
    const b = bet({ id: '00000000-0000-4000-8000-000000000002' })
    const first = planRestore(backup([a, b]), here([]), ids)
    expect(planRestore(backup([a, b]), here([]), ids).signature).toBe(first.signature)
    // Another device restored one of them during the review.
    const again = planRestore(backup([a, b]), here([a]), ids)
    expect(again.signature).not.toBe(first.signature)
    expect(again.newBets.map((x) => x.id)).toEqual([b.id])
  })

  it('another account’s copies get new ids each time, yet the plan is the same plan', () => {
    const theirs = { ...backup([bet({ id: '00000000-0000-4000-8000-000000000009', date: '2026-01-02' })]), account: { id: 'other', email: null } }
    expect(planRestore(theirs, here([]), ids).signature).toBe(planRestore(theirs, here([]), ids).signature)
  })

  it('shows each possible duplicate next to the bet here it looks like', () => {
    const mine = bet({ id: 'm', date: '2026-01-05', amount: 10 })
    const theirs = { ...backup([{ ...mine, id: '00000000-0000-4000-8000-00000000000a', note: 'theirs' }]), account: { id: 'other', email: null } }
    const plan = planRestore(theirs, here([mine]), ids)
    expect(plan.duplicateOf.map((b) => b.id)).toEqual(['m'])
    expect(plan.duplicateSources).toEqual(['00000000-0000-4000-8000-00000000000a'])
  })

  it('replaces only the settings that differ, and remembers them as they were', () => {
    const s: Settings = { ...DEFAULT_SETTINGS, oddsFormat: 'american', unitSize: 10, startingBankroll: 500 }
    expect(settingsChange(s, backup([]).settings)).toEqual({
      before: { oddsFormat: 'american', startingBankroll: 500 },
      after: { oddsFormat: 'decimal', startingBankroll: 1000 }
    })
    expect(settingsChange({ ...s, oddsFormat: 'decimal', startingBankroll: 1000 }, backup([]).settings)).toBeNull()
  })
})

describe('import review: each duplicate against the bet it looks like', () => {
  it('pairs each duplicate with one bet here, and the plan changes when the bets do', () => {
    const here = [bet({ id: 'h1', date: '2026-03-01', amount: 5 })]
    const parsed = { rows: [input, { ...input, date: '2026-03-01' }, { ...input, date: '2026-03-01' }], lines: [2, 3, 4], rejected: [], noStake: 0 }
    const plan = planImport(parsed, here)
    expect(plan.duplicates.map((d) => [d.line, d.match?.id])).toEqual([[3, 'h1']])
    // Two identical rows of the file, one bet here: one is a duplicate, the other goes in.
    expect(plan.fresh.map((r) => r.line)).toEqual([2, 4])
    expect(planImport(parsed, []).signature).not.toBe(plan.signature)
  })
})

describe('a change the server refused is never in neither place', () => {
  const refusedErr = () => new Error('new row violates check constraint')

  it('when its record cannot be stored, it stays in the queue and the drain stops', async () => {
    let queue: PendingOp[] = [
      { opId: 'a', kind: 'add', id: 'a', input, queuedAt: S },
      { opId: 'b', kind: 'add', id: 'b', input, queuedAt: S }
    ]
    const hooks: DrainHooks = {
      outbox: () => queue,
      update: (fn) => (queue = fn(queue)),
      send: async () => {
        throw refusedErr()
      },
      applied: () => {},
      rejected: () => false
    }
    const out = await drainOutbox(hooks)
    expect(out.stop).toBe('storage')
    expect(queue.map((o) => o.opId)).toEqual(['a', 'b'])
  })

  it('once it can be stored, it leaves the queue, and the rest goes', async () => {
    let queue: PendingOp[] = [
      { opId: 'a', kind: 'add', id: 'a', input, queuedAt: S },
      { opId: 'b', kind: 'add', id: 'b', input, queuedAt: S }
    ]
    const kept: string[] = []
    const hooks: DrainHooks = {
      outbox: () => queue,
      update: (fn) => (queue = fn(queue)),
      send: async (op) => {
        if (op.opId === 'a') throw refusedErr()
        return bet({ id: op.kind === 'bulk-add' ? 'x' : op.id })
      },
      applied: () => {},
      rejected: (ops) => {
        kept.push(...ops.map((o) => o.opId))
        return true
      }
    }
    expect(await drainOutbox(hooks)).toEqual({ stop: 'done', processed: 1 })
    expect(kept).toEqual(['a'])
    expect(queue).toEqual([])
  })

  it('a refused list storage turns away is not kept in this window either (store, or nothing)', async () => {
    let full = false
    let stored: string[] = ['old']
    const store = queueStore<string[]>({
      lock: 'test-refused',
      load: () => stored,
      save: (v) => {
        if (full) throw new StorageWriteError(new Error('full'))
        stored = v
      },
      versions: async () => null
    })
    full = true
    const r = await store.update((list) => [...list, 'new'], { hold: false })
    expect(r).toEqual({ value: ['old'], saved: false })
    expect(store.held).toBe(false)
    full = false
    expect((await store.update((list) => list)).value).toEqual(['old'])
  })
})

describe('a read answered late never undoes what another window got confirmed', () => {
  const noVersions = (): Promise<null> => Promise.resolve(null)

  it('lays over a read what was confirmed after it went out, in order: other windows’ and its own (see audit-nov5)', async () => {
    let clock = 1000
    const key = 'bettracker:confirmed-bets:u'
    const here = sharedLog<{ op: PendingOp; row: Bet | null }>(key, { now: () => clock, win: 'win-here', versions: noVersions, channel: null })
    const there = sharedLog<{ op: PendingOp; row: Bet | null }>(key, { now: () => clock, win: 'win-there', versions: noVersions, channel: null })
    const kept = bet({ id: 'kept' })
    const gone = bet({ id: 'gone' })
    // Confirmed before the read went out: the read has it.
    await there.record({ op: { opId: 'x', kind: 'delete', id: 'older' }, row: null })
    clock = 2000
    const read = await here.begin()
    clock = 3000
    // Another window deletes one bet and adds another while the read is out.
    await there.record({ op: { opId: 'd', kind: 'delete', id: 'gone' }, row: null })
    const added = bet({ id: 'added' })
    await there.record({ op: { opId: 'n', kind: 'add', id: 'added', input, queuedAt: S }, row: added })
    // This window's own, in its place in the order (its own log has it too).
    await here.record({ op: { opId: 'o', kind: 'delete', id: 'kept' }, row: null })
    let rows: Bet[] = []
    expect(await read.finish([kept, gone], (acc, c) => reconcile(acc, c.op, c.row), (r) => (rows = r))).toBe(true)
    expect(rows.map((b) => b.id).sort()).toEqual(['added'])
  })

  it('forgets entries older than any read can be, and raises its floor past them', async () => {
    let clock = 0
    const key = 'bettracker:confirmed-moves:u'
    const log = sharedLog<number>(key, { now: () => clock, win: 'w', versions: noVersions, channel: null })
    await log.record(1)
    clock = 11 * 60_000
    await log.record(2)
    const state = JSON.parse(localStorage.getItem(key) ?? 'null') as { floor: number; entries: { change: number }[] }
    expect(state.entries.map((e) => e.change)).toEqual([2])
    expect(state.floor).toBe(1)
  })
})

describe('settings: a late read never replaces a newer confirmed row', () => {
  const row = (updatedAt: string, oddsFormat: Settings['oddsFormat'] = 'decimal'): Settings => ({ ...DEFAULT_SETTINGS, oddsFormat, updatedAt })

  it('goes forward in time only; "no row" never replaces a row', () => {
    const saved = row('2026-11-02T10:00:05.000+00:00', 'american')
    expect(newerSettings(null, row('2026-11-02T10:00:00Z'))).toBe(true)
    expect(newerSettings(saved, row('2026-11-02T10:00:00Z'))).toBe(false)
    expect(newerSettings(saved, { ...DEFAULT_SETTINGS })).toBe(false)
    expect(newerSettings(saved, row('2026-11-02T10:00:05.000Z', 'american'))).toBe(true)
    expect(newerSettings({ ...DEFAULT_SETTINGS }, row('2026-11-02T10:00:00Z'))).toBe(true)
  })
})

describe('settings Undo: a guarded field yields to a later change', () => {
  it('a later edit of a field drops its guard; an answered field takes its guard with it', () => {
    const undo = editSettings(null, { oddsFormat: 'american', unitSize: null }, 'T1', { oddsFormat: 'decimal', unitSize: 10 })
    expect(undo.guard).toEqual({ oddsFormat: 'decimal', unitSize: 10 })
    const later = editSettings(undo, { unitSize: 25 }, 'T2')
    expect(later.guard).toEqual({ oddsFormat: 'decimal' })
    expect(afterSettingsAnswer(later, undo)).toMatchObject({ patch: { unitSize: 25 } })
    expect(afterSettingsAnswer(later, undo)?.guard).toBeUndefined()
  })
})

describe('settings: an edit waiting for the storage lock survives a reload', () => {
  it('is journaled at once, and a later start queues what a closed window left', async () => {
    expect(journalEntry('u', { patch: { oddsFormat: 'american' }, editedAt: 'T1' })).not.toBeNull()
    // The window is gone (a reload): its journal is under another window's name now.
    const own = Object.keys(Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => [localStorage.key(i), 1]))).find((k) => k.startsWith(settingsJournalPrefix('u')))
    expect(own).toBeDefined()
    localStorage.setItem(`${settingsJournalPrefix('u')}closed-window`, localStorage.getItem(own as string) as string)
    localStorage.removeItem(own as string)
    const queued: unknown[] = []
    await replayJournals('u', async (edits) => {
      queued.push(...edits)
      return true
    })
    expect(queued).toEqual([{ patch: { oddsFormat: 'american' }, editedAt: 'T1' }])
    expect(localStorage.getItem(`${settingsJournalPrefix('u')}closed-window`)).toBeNull()
  })

  it('leaves the journal in place when the queue could not take it', async () => {
    localStorage.setItem(`${settingsJournalPrefix('u')}closed`, JSON.stringify([{ patch: { unitSize: 5 }, editedAt: 'T' }]))
    await replayJournals('u', async () => false)
    expect(localStorage.getItem(`${settingsJournalPrefix('u')}closed`)).not.toBeNull()
  })
})

describe('restore result: what is known, never more', () => {
  const entry: ImportBatch = {
    id: 'B',
    kind: 'restore',
    at: S,
    file: 'b.json',
    fingerprint: 'f',
    ids: ['a', 'b', 'c'],
    moveIds: ['m'],
    stamp: S,
    restore: { skippedBets: 2, skippedMoves: 0, skippedDuplicates: 1, settings: { before: { oddsFormat: 'american' }, after: { oddsFormat: 'decimal' }, editedAt: S }, failed: [], held: [] }
  }
  const none = { adds: 0, removals: 0 }
  const live = (over: Partial<BatchLive> = {}): BatchLive => ({ bets: none, moves: none, betsHeld: false, movesHeld: false, refused: false, settingsOrigins: {}, settingsHeld: false, ...over })

  it('rows still queued are waiting, not added; settings still pending are waiting too', () => {
    const st = batchStatus(entry, live({ bets: { adds: 3, removals: 0 }, moves: { adds: 1, removals: 0 }, settingsOrigins: { oddsFormat: 'B' } }))
    expect(st.bets).toMatchObject({ state: 'waiting', made: 0, waiting: 3 })
    expect(st.moves.state).toBe('waiting')
    expect(st.settings.state).toBe('waiting')
    expect(st.complete).toBe(false)
  })

  it('nothing waiting and no answer is not "added": it has no answer, and Check again is offered', () => {
    const st = batchStatus(entry, live())
    expect(st.bets).toMatchObject({ state: 'unknown', made: 0, unknown: 3 })
    expect(st.settings.state).toBe('unknown')
    expect(st.complete).toBe(false)
    expect(st.actions).toContain('check')
  })

  it('once the server answered: what it made is added, what it already had was there', () => {
    const st = batchStatus({ ...entry, made: ['a', 'b'], present: ['c'], madeMoves: ['m'], restore: { ...entry.restore!, settings: { ...entry.restore!.settings!, confirmed: ['oddsFormat'] } } }, live())
    expect(st.bets).toMatchObject({ state: 'done', made: 2, present: 1 })
    expect(st.moves).toMatchObject({ state: 'done', made: 1, present: 0 })
    expect(st.settings.state).toBe('done')
    expect(st.skipped).toEqual({ bets: 2, moves: 0, duplicates: 1 })
    expect(st.complete).toBe(true)
  })

  it('a part that failed, was refused, or is only in this window says so, and the whole is not complete', () => {
    const failed = { ...entry, restore: { ...entry.restore!, failed: ['moves' as const], held: ['bets' as const] } }
    // Held while this window's storage refuses its queue (see audit-nov5: once stored, it waits).
    const st = batchStatus(failed, live({ bets: { adds: 3, removals: 0 }, betsHeld: true }))
    expect(st.bets.state).toBe('held')
    expect(st.moves.state).toBe('failed')
    expect(st.complete).toBe(false)
    expect(batchStatus({ ...entry, rejected: ['a', 'b', 'c'] }, live({ refused: true })).bets.state).toBe('refused')
  })

  it('an Undo counts what the server removed and kept, and what is still to go', () => {
    const undone: ImportBatch = {
      ...entry,
      undone: true,
      undo: { at: S, stamp: S, bets: ['a', 'b'], moves: ['m'], changedHere: 1, goneHere: 0, removed: ['a'], kept: ['m'], settings: { reverted: ['oddsFormat'], kept: [] } }
    }
    const undo = batchStatus(undone, live({ bets: { adds: 0, removals: 1 } })).undo
    expect(undo).toMatchObject({ waiting: 1, removed: 1, kept: 1, changedHere: 1, goneHere: 0 })
    // From before answers were recorded: what it put back has no answer yet (asked again), never "put back".
    expect(undo?.settings).toMatchObject({ fields: ['oddsFormat'], confirmed: [], unknown: ['oddsFormat'], keptHere: [] })
  })
})

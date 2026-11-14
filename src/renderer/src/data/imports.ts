import type { BetInput, MoveInput, SettingsPatch } from '../../../shared/types'
import { importsKey, insertStamp, sameStamp, type PendingOp } from './offline'
import { queueStore, writeDurable, type QueueStore } from './store'

/**
 * The imports and restores made on this device: which file, when, what each
 * queues, and what the server made of it, so a whole batch can be undone
 * later, a restore that stopped halfway says what is missing (and goes on by
 * itself), and the same file picked again is recognised.
 *
 * An import, a restore and an Undo are operations written down before they
 * are queued: each part (the bets, the deposits and withdrawals, the
 * settings, the Undo's removals and its settings) is first `prepared`, with
 * what it is to queue, then queued and marked so (see data/operations.ts). A
 * window that closes or reloads in between leaves the part prepared, and the
 * next window to start queues it, once.
 *
 * Every row a batch writes carries the same `updated_at`, its `stamp`: on
 * the server that is the batch's receipt. What the server said of each row
 * is kept: `made` (this batch inserted it, now or by an attempt whose answer
 * was lost), `present` (the server had it already: another device's, or
 * restored there; left as it was), `absent` (skipped: deleted on another
 * device since, see migration 007), `rejected` (refused for good, `reason`)
 * and `missing` (asked again, the server has no such row). A row with none of
 * these has no answer yet: never "added". An Undo removes a row only where it
 * still carries the stamp, in the same statement (see deleteBet).
 *
 * Answers carry the generation they are for: the stamp the rows were sent
 * with, or the time a settings write was made. A batch undone and put back
 * again is a new generation; a late answer to the earlier one is dropped.
 *
 * Kept in localStorage per user, the newest MAX_IMPORTS, and changed only
 * under a lock every window shares (see store.ts). Losing this list loses the
 * Undo of an old batch, never a bet.
 */
export interface ImportBatch {
  /** The history entry; for a CSV import from before batches had their own id, the op that carried it. */
  id: string
  at: string
  file: string
  fingerprint: string
  /** The bets it queues. */
  ids: string[]
  /** A backup restored: the deposits and withdrawals it queues. */
  moveIds?: string[]
  /** 'restore' for a backup; an import of a CSV otherwise. */
  kind?: 'restore'
  /** Undone: its Undo has been asked for (see `undo` for what came of it). */
  undone?: boolean
  /** The `updated_at` its rows are written with (see above). An entry from before this has none. */
  stamp?: string
  /** What the server said of each row: the bets, and the moves (see above). */
  made?: string[]
  madeMoves?: string[]
  present?: string[]
  presentMoves?: string[]
  absent?: string[]
  absentMoves?: string[]
  rejected?: string[]
  rejectedMoves?: string[]
  /** Asked again (Check again), the server has no such row. */
  missing?: string[]
  missingMoves?: string[]
  /** Why the server refused what it refused. */
  reason?: string
  /** Where each part is (see above). An entry from before this has none: its parts count as queued. */
  parts?: { bets?: PartLog<BetPayload>; moves?: PartLog<MovePayload> }
  /** A restore: what it found here already, its settings, and what it could not queue. */
  restore?: RestoreLog
  /** The last Undo: what it asked the server to remove, and what the server did. */
  undo?: UndoLog
}

export type SettingsField = keyof SettingsPatch
export type RestorePart = 'bets' | 'moves' | 'settings'

/**
 * Where a part of an operation is: written down with what it is to queue
 * (`prepared`), queued (`queued`), queued in this window alone because
 * storage refused the queue (`held`), or not queued at all (`failed`, with
 * why).
 */
export type PartPhase = 'prepared' | 'queued' | 'held' | 'failed'

export interface PartLog<P> {
  phase: PartPhase
  /** What it is to queue, while prepared. */
  payload?: P[]
  error?: string
}

export interface BetPayload {
  id: string
  input: BetInput
}

export interface MovePayload {
  id: string
  input: MoveInput
}

/**
 * What the server said of each setting a write carried: `confirmed` (the row
 * holds the value written), `kept` (a later change won, here or elsewhere:
 * not written), `rejected` (refused for good, `reason`), `missing` (asked
 * again, the server does not hold the value written).
 */
export interface SettingsOutcome {
  confirmed?: SettingsField[]
  kept?: SettingsField[]
  rejected?: SettingsField[]
  missing?: SettingsField[]
  reason?: string
}

export interface RestoreLog {
  /** Already here when it was applied (the same, or changed since the backup): left as they are. */
  skippedBets: number
  skippedMoves: number
  /** Possible duplicates of bets here (another account's backup) the user chose to skip. */
  skippedDuplicates: number
  /**
   * The settings it replaces: each field as it was and as the backup has it,
   * written at `editedAt`. Tried again or put forward again, only the fields
   * in `write`, and only where the server still holds `guard`.
   */
  settings?: {
    before: SettingsPatch
    after: SettingsPatch
    editedAt: string
    guard?: SettingsPatch
    write?: SettingsField[]
    phase?: PartPhase
    error?: string
  } & SettingsOutcome
  /** From before parts had phases: what could not be queued, and what storage refused (in that window only). */
  failed: RestorePart[]
  held: RestorePart[]
}

export interface UndoLog {
  at: string
  /** The stamp it asked about (the batch's when it was undone). */
  stamp: string
  /** An import from before batches had stamps: the stamp of each row, as this device last saw it. */
  stamps?: Record<string, string>
  /** Where its removals are (see PartPhase); an Undo from before this has none: queued. */
  phase?: PartPhase
  error?: string
  /** Asked to remove, unless they changed since. */
  bets: string[]
  moves: string[]
  /** Left alone on this device already: changed since, or gone. */
  changedHere: number
  goneHere: number
  /** What the server did with what was asked: removed, kept (changed since), refused. */
  removed: string[]
  kept: string[]
  failed?: string[]
  /**
   * The settings it puts back (`asked`: they still held what the restore set
   * on this device), the ones it left here because they had changed since
   * (`keptHere`), the ones that already held the value from before
   * (`already`), and what the server did with `asked`. From before this:
   * `reverted` and `kept`, with no answer recorded.
   */
  settings?: {
    asked?: SettingsField[]
    keptHere?: SettingsField[]
    already?: SettingsField[]
    editedAt?: string
    reverted?: SettingsField[]
    kept?: SettingsField[]
    phase?: PartPhase
    error?: string
  } & SettingsOutcome
}

/**
 * What the server made of a batch's ops, as the hooks hear it (see
 * useBetSync, useMoves, useSettings). `stamp` names the generation an answer
 * is for: the stamp its adds were sent with, or the one its Undo's deletes
 * asked about; `editedAt` the time of the settings write.
 */
export type BatchEvent =
  | { kind: 'outcome'; batch: string; table: 'bets' | 'moves'; stamp?: string; made: string[]; present?: string[]; absent?: string[]; missing?: string[] }
  | { kind: 'undo'; batch: string; table: 'bets' | 'moves'; stamp?: string; id: string; removed: boolean }
  | { kind: 'rejected'; batch: string; table: 'bets' | 'moves'; undo?: boolean; stamp?: string; ids: string[]; reason?: string }
  | { kind: 'requeued'; batch: string; table: 'bets' | 'moves'; undo?: boolean; stamp?: string; ids: string[] }
  | {
      kind: 'settings'
      batch: string
      undo?: boolean
      editedAt?: string
      confirmed?: SettingsField[]
      kept?: SettingsField[]
      rejected?: SettingsField[]
      missing?: SettingsField[]
      reason?: string
    }

export const MAX_IMPORTS = 20

/** The origin a settings write of an Undo carries (see PendingSettings.fieldOrigin). */
export const undoOrigin = (batch: string): string => `undo:${batch}`

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const optStrings = (v: unknown): boolean => v === undefined || strings(v)

const isBatch = (v: unknown): v is ImportBatch => {
  if (typeof v !== 'object' || v === null) return false
  const b = v as Record<string, unknown>
  return (
    typeof b.id === 'string' &&
    typeof b.at === 'string' &&
    typeof b.file === 'string' &&
    typeof b.fingerprint === 'string' &&
    strings(b.ids) &&
    ['moveIds', 'made', 'madeMoves', 'present', 'presentMoves', 'absent', 'absentMoves', 'rejected', 'rejectedMoves', 'missing', 'missingMoves'].every((k) => optStrings(b[k])) &&
    (b.stamp === undefined || typeof b.stamp === 'string')
  )
}

function readStored(userId: string): ImportBatch[] {
  try {
    const raw = JSON.parse(localStorage.getItem(importsKey(userId)) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter(isBatch) : []
  } catch {
    return []
  }
}

const stores = new Map<string, QueueStore<ImportBatch[]>>()

const historyLock = (userId: string): string => `bettracker:history:${userId}`

function storeFor(userId: string): QueueStore<ImportBatch[]> {
  let store = stores.get(userId)
  if (!store) {
    store = queueStore<ImportBatch[]>({
      lock: historyLock(userId),
      load: () => readStored(userId),
      save: (list) => writeDurable(importsKey(userId), list.slice(0, MAX_IMPORTS))
    })
    stores.set(userId, store)
  }
  return store
}

/** This user's imports and restores, newest first, as this window knows them. */
export function loadImports(userId: string): ImportBatch[] {
  return storeFor(userId).read().slice(0, MAX_IMPORTS)
}

/** The same, read under the lock: what every window stored before is in it. */
export async function freshImports(userId: string): Promise<ImportBatch[]> {
  return (await storeFor(userId).fresh()).slice(0, MAX_IMPORTS)
}

/** Change the list under its lock; resolves with it. */
export async function updateImports(userId: string, fn: (list: ImportBatch[]) => ImportBatch[]): Promise<ImportBatch[]> {
  return (await storeFor(userId).update((list) => fn(list).slice(0, MAX_IMPORTS))).value
}

export function recordImport(userId: string, batch: ImportBatch): Promise<ImportBatch[]> {
  return updateImports(userId, (list) => [batch, ...list.filter((b) => b.id !== batch.id)])
}

export function changeImport(userId: string, id: string, fn: (b: ImportBatch) => ImportBatch): Promise<ImportBatch[]> {
  return updateImports(userId, (list) => list.map((b) => (b.id === id ? fn(b) : b)))
}

export function markUndone(userId: string, id: string, undone = true): Promise<ImportBatch[]> {
  return changeImport(userId, id, (b) => ({ ...b, undone }))
}

/** The history could not be stored: an operation that must be written down first is not started. */
export class HistoryFullError extends Error {
  constructor() {
    super('This device could not store the import history (its storage is full or turned off)')
    this.name = 'HistoryFullError'
  }
}

/**
 * Write an operation down before anything of it is queued (see
 * data/operations.ts): stored, or not made at all (HistoryFullError), never
 * kept in this window alone, since a reload would lose what it is to queue.
 */
export async function prepare(userId: string, batch: ImportBatch): Promise<ImportBatch[]> {
  const r = await storeFor(userId).update((list) => [batch, ...list.filter((b) => b.id !== batch.id)].slice(0, MAX_IMPORTS), { hold: false })
  if (!r.saved) throw new HistoryFullError()
  return r.value
}

const running = new Set<string>()
const chains = new Map<string, Promise<unknown>>()

/**
 * Run `fn` holding operation `id`'s lock: one window at a time queues its
 * parts (see data/operations.ts). `ifFree`: only when no window holds it now
 * (resolves with undefined otherwise). Where Web Locks are missing, within
 * this window only.
 */
export function withOperation<R>(userId: string, id: string, fn: () => Promise<R>, opts: { ifFree?: boolean } = {}): Promise<R | undefined> {
  const name = `bettracker:operation:${userId}:${id}`
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (locks && typeof locks.request === 'function') {
    if (opts.ifFree) return locks.request(name, { ifAvailable: true }, async (lock) => (lock ? fn() : undefined)) as Promise<R | undefined>
    return locks.request(name, () => fn()) as Promise<R | undefined>
  }
  if (opts.ifFree && running.has(name)) return Promise.resolve(undefined)
  const run = (chains.get(name) ?? Promise.resolve()).then(async () => {
    running.add(name)
    try {
      return await fn()
    } finally {
      running.delete(name)
    }
  })
  chains.set(
    name,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  return run
}

const union = (a: readonly string[] | undefined, b: readonly string[]): string[] => [...new Set([...(a ?? []), ...b])]
const minus = (a: readonly string[] | undefined, b: readonly string[]): string[] => (a ?? []).filter((x) => !b.includes(x))

const ROW_LISTS = ['made', 'present', 'absent', 'rejected', 'missing'] as const
type RowList = (typeof ROW_LISTS)[number]

const listKey = (name: RowList, table: 'bets' | 'moves'): keyof ImportBatch => (table === 'bets' ? name : (`${name}Moves` as keyof ImportBatch))

/** The rows of a part the server said `name` of: each row in one list only (the last answer counts). */
function setRows(b: ImportBatch, table: 'bets' | 'moves', name: RowList, ids: readonly string[]): ImportBatch {
  if (ids.length === 0) return b
  const next: Record<string, unknown> = { ...b }
  for (const other of ROW_LISTS) {
    const key = listKey(other, table)
    const cur = b[key] as string[] | undefined
    next[key] = other === name ? union(cur, ids) : minus(cur, ids)
  }
  return next as unknown as ImportBatch
}

const planned = (b: ImportBatch, table: 'bets' | 'moves'): string[] => (table === 'bets' ? b.ids : (b.moveIds ?? []))

/** The rows of a part the server has said nothing of yet. */
export function unanswered(b: ImportBatch, table: 'bets' | 'moves'): string[] {
  const known = new Set(ROW_LISTS.flatMap((name) => (b[listKey(name, table)] as string[] | undefined) ?? []))
  return planned(b, table).filter((id) => !known.has(id))
}

/** Whether the server has said anything of a part's rows (it was sent, at least in part). */
export function answeredAny(b: ImportBatch, table: 'bets' | 'moves'): boolean {
  return unanswered(b, table).length < planned(b, table).length
}

/** From before outcomes were recorded, an Undo's settings were `reverted` and `kept` (left here): read as now. */
export function currentUndoSettings(s: NonNullable<UndoLog['settings']>): NonNullable<UndoLog['settings']> {
  if (s.asked) return s
  const { reverted, kept, ...rest } = s
  return { ...rest, asked: reverted ?? [], keptHere: kept ?? [] }
}

function setFields(o: SettingsOutcome, name: 'confirmed' | 'kept' | 'rejected' | 'missing', fields: readonly SettingsField[]): SettingsOutcome {
  if (fields.length === 0) return o
  const next: SettingsOutcome = { ...o }
  for (const other of ['confirmed', 'kept', 'rejected', 'missing'] as const) {
    const cur = (o[other] ?? []) as string[]
    next[other] = (other === name ? union(cur, fields) : minus(cur, fields)) as SettingsField[]
  }
  return next
}

function withSettingsAnswer<O extends SettingsOutcome>(o: O, e: Extract<BatchEvent, { kind: 'settings' }>): O {
  let next: SettingsOutcome = o
  next = setFields(next, 'confirmed', e.confirmed ?? [])
  next = setFields(next, 'kept', e.kept ?? [])
  next = setFields(next, 'rejected', e.rejected ?? [])
  next = setFields(next, 'missing', e.missing ?? [])
  if ((e.rejected ?? []).length > 0 && e.reason) next = { ...next, reason: e.reason }
  return next as O
}

/**
 * Whether an answer is for the generation the entry is at now: rows sent with
 * its stamp, removals asked about its Undo's, a settings write made at its
 * time. An answer that names none is taken (from before answers named theirs).
 */
function ofThisGeneration(b: ImportBatch, e: BatchEvent): boolean {
  if (e.kind === 'settings') {
    if (e.editedAt === undefined) return true
    if (e.undo) {
      const us = b.undo?.settings
      return us !== undefined && e.editedAt === (us.editedAt ?? b.undo?.at)
    }
    return b.restore?.settings !== undefined && e.editedAt === b.restore.settings.editedAt
  }
  if (e.stamp === undefined) return true
  const undo = e.kind === 'undo' || ((e.kind === 'rejected' || e.kind === 'requeued') && e.undo)
  if (undo) {
    if (!b.undo) return false
    if (e.kind === 'undo') return sameStamp(e.stamp, b.undo.stamps?.[e.id] ?? b.undo.stamp) || e.stamp === (b.undo.stamps?.[e.id] ?? b.undo.stamp)
    return true
  }
  return b.stamp === undefined || sameStamp(e.stamp, b.stamp) || e.stamp === b.stamp
}

/**
 * What the server made of a batch's op, into its entry. An event for a batch
 * no longer listed, or for another generation of it, is dropped. The same
 * event twice changes nothing (an op sent again after its answer was lost
 * tells it again).
 */
export function foldBatchEvent(list: readonly ImportBatch[], e: BatchEvent): ImportBatch[] {
  return list.map((b) => {
    if (b.id !== e.batch || !ofThisGeneration(b, e)) return b
    switch (e.kind) {
      case 'outcome': {
        let next = setRows(b, e.table, 'made', e.made)
        next = setRows(next, e.table, 'present', e.present ?? [])
        next = setRows(next, e.table, 'absent', e.absent ?? [])
        return setRows(next, e.table, 'missing', e.missing ?? [])
      }
      case 'rejected': {
        if (e.undo) return b.undo ? { ...b, undo: { ...b.undo, failed: union(b.undo.failed, e.ids) } } : b
        const next = setRows(b, e.table, 'rejected', e.ids)
        return e.reason ? { ...next, reason: e.reason } : next
      }
      case 'requeued': {
        if (e.undo) return b.undo ? { ...b, undo: { ...b.undo, failed: minus(b.undo.failed, e.ids) } } : b
        const key = listKey('rejected', e.table)
        return { ...b, [key]: minus(b[key] as string[] | undefined, e.ids) }
      }
      case 'undo': {
        if (!b.undo) return b
        const removed = e.removed ? union(b.undo.removed, [e.id]) : minus(b.undo.removed, [e.id])
        const kept = e.removed ? minus(b.undo.kept, [e.id]) : union(b.undo.kept, [e.id])
        return { ...b, undo: { ...b.undo, removed, kept, failed: minus(b.undo.failed, [e.id]) } }
      }
      case 'settings': {
        if (e.undo) {
          if (!b.undo?.settings) return b
          return { ...b, undo: { ...b.undo, settings: withSettingsAnswer(currentUndoSettings(b.undo.settings), e) } }
        }
        if (!b.restore?.settings) return b
        return { ...b, restore: { ...b.restore, settings: withSettingsAnswer(b.restore.settings, e) } }
      }
    }
  })
}

export function recordBatchEvent(userId: string, e: BatchEvent): Promise<ImportBatch[]> {
  return updateImports(userId, (list) => foldBatchEvent(list, e))
}

/** The batch an op belongs to, and whether it is an Undo's (a conditional delete). */
export function batchOf<I>(op: PendingOp<I> | PendingOp<unknown>): { batch: string; undo: boolean } | null {
  if (op.kind === 'bulk-add') return { batch: op.batch ?? op.opId, undo: false }
  if (op.kind === 'add' && op.batch) return { batch: op.batch, undo: false }
  if (op.kind === 'delete' && op.batch && op.ifStamp) return { batch: op.batch, undo: true }
  return null
}

/**
 * Ops refused for good, or sent again from the refused list, as events for
 * the batches they belong to: the rows of an import not yet confirmed, an
 * add's row, an Undo's row.
 */
export function opsAsEvents<I>(kind: 'rejected' | 'requeued', table: 'bets' | 'moves', ops: readonly PendingOp<I>[], reason?: string): BatchEvent[] {
  const by = new Map<string, { batch: string; undo: boolean; stamp?: string; ids: string[] }>()
  for (const op of ops) {
    const of = batchOf(op)
    if (!of) continue
    const stamp = op.kind === 'bulk-add' || op.kind === 'add' ? insertStamp(op) : op.kind === 'delete' ? op.ifStamp : undefined
    const ids = op.kind === 'bulk-add' ? op.entries.slice(op.done ?? 0).map((e) => e.id) : op.kind === 'update' ? [] : [op.id]
    const key = `${of.batch}|${of.undo}|${stamp ?? ''}`
    const cur = by.get(key) ?? { ...of, ...(stamp ? { stamp } : {}), ids: [] }
    by.set(key, { ...cur, ids: union(cur.ids, ids) })
  }
  return [...by.values()]
    .filter((g) => g.ids.length > 0)
    .map((g) => ({
      kind,
      batch: g.batch,
      table,
      ...(g.undo ? { undo: true } : {}),
      ...(g.stamp ? { stamp: g.stamp } : {}),
      ids: g.ids,
      ...(kind === 'rejected' && reason ? { reason } : {})
    }))
}

/** What the server said of a chunk of an import (see addBets), as the batch's answer. */
export function chunkAnswer(
  op: Extract<PendingOp<unknown>, { kind: 'bulk-add' }>,
  table: 'bets' | 'moves',
  outcome: { made: string[]; present?: string[]; absent?: string[] }
): BatchEvent {
  return {
    kind: 'outcome',
    batch: op.batch ?? op.opId,
    table,
    stamp: insertStamp(op),
    made: outcome.made,
    ...(outcome.present && outcome.present.length > 0 ? { present: outcome.present } : {}),
    ...(outcome.absent && outcome.absent.length > 0 ? { absent: outcome.absent } : {})
  }
}

/**
 * What the server said of one add of a batch: the row it holds now. One that
 * carries the add's stamp was made by it (now, or by an attempt whose answer
 * was lost); another was there already; none, it was skipped (deleted on
 * another device since, see migration 007).
 */
export function addAnswer(
  op: Extract<PendingOp<unknown>, { kind: 'add' }>,
  table: 'bets' | 'moves',
  row: { updatedAt: string } | null,
  stamp: string = insertStamp(op)
): BatchEvent | null {
  if (!op.batch) return null
  const base = { kind: 'outcome' as const, batch: op.batch, table, stamp: op.queuedAt, made: [] as string[] }
  if (row === null) return { ...base, absent: [op.id] }
  if (sameStamp(row.updatedAt, stamp)) return { ...base, made: [op.id] }
  return { ...base, present: [op.id] }
}

/** What the server said of one removal of an Undo: gone (removed now, or before), or kept (changed since). */
export function undoAnswer(op: Extract<PendingOp<unknown>, { kind: 'delete' }>, table: 'bets' | 'moves', row: unknown): BatchEvent | null {
  if (!op.batch || !op.ifStamp) return null
  return { kind: 'undo', batch: op.batch, table, stamp: op.ifStamp, id: op.id, removed: row === null }
}

/**
 * A settings answer (see useSettings' settingsOutcomes) as told to the batch
 * whose write it was: a restore's (origin: its id) or its Undo's (`undo:<id>`),
 * of the generation the write was made with (`editedAt`).
 */
export function settingsAnswer(e: {
  origin: string
  editedAt?: string
  confirmed: SettingsField[]
  kept: SettingsField[]
  rejected: SettingsField[]
  reason?: string
}): BatchEvent {
  const undo = e.origin.startsWith(undoOrigin(''))
  return {
    kind: 'settings',
    batch: undo ? e.origin.slice(undoOrigin('').length) : e.origin,
    undo,
    ...(e.editedAt ? { editedAt: e.editedAt } : {}),
    confirmed: e.confirmed,
    kept: e.kept,
    rejected: e.rejected,
    ...(e.reason ? { reason: e.reason } : {})
  }
}

/** Signed out: this window forgets the user's imports too (clearUserData clears storage). */
export function forgetImports(userId: string): void {
  stores.delete(userId)
}

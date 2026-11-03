import type { SettingsPatch } from '../../../shared/types'
import { importsKey } from './offline'
import { queueStore, writeDurable, type QueueStore } from './store'

/**
 * The imports and restores made on this device: which file, when, what each
 * queued, and what the server made of it, so a whole batch can be undone
 * later, a restore that stopped halfway says what is missing, and the same
 * file picked again is recognised.
 *
 * Every row a batch writes carries the same `updated_at`, its `stamp`: on
 * the server that is the batch's receipt. The server says which rows the
 * batch made (`made`: an insert it took, or one an earlier attempt made whose
 * answer was lost, see addBets), and an Undo removes a row only where it
 * still carries the stamp, in the same statement (see deleteBet): a row the
 * batch did not make (one that was there already, or another device's with
 * the same id) and one edited since are never removed, whatever this device
 * knows. What the Undo asked for and what the server did are kept here too.
 *
 * Kept in localStorage per user, the newest MAX_IMPORTS, and changed only
 * under a lock every window shares (see store.ts): the window that sends the
 * queue writes what the server answered while another may be recording a new
 * import. Where storage refuses it, it is kept in this window only. Losing
 * this list loses the Undo of an old batch, never a bet.
 */
export interface ImportBatch {
  /** The history entry; for a CSV import from before batches had their own id, the op that carried it. */
  id: string
  at: string
  file: string
  fingerprint: string
  /** The bets it queued. */
  ids: string[]
  /** A backup restored: the deposits and withdrawals it queued. */
  moveIds?: string[]
  /** 'restore' for a backup; an import of a CSV otherwise. */
  kind?: 'restore'
  /** Undone: its Undo has been queued (see `undo` for what came of it). */
  undone?: boolean
  /** The `updated_at` its rows are written with (see above). An entry from before this has none. */
  stamp?: string
  /** The bets, and the moves, the server confirmed this batch made. */
  made?: string[]
  madeMoves?: string[]
  /** A restore: what it found here already, its settings, and what it could not queue. */
  restore?: RestoreLog
  /** The last Undo: what it asked the server to remove, and what the server did. */
  undo?: UndoLog
}

export type SettingsField = keyof SettingsPatch

export interface RestoreLog {
  /** Already here when it was applied (the same, or changed since the backup): left as they are. */
  skippedBets: number
  skippedMoves: number
  /** Possible duplicates of bets here (another account's backup) the user chose to skip. */
  skippedDuplicates: number
  /** The settings it replaced: each field as it was and as the backup has it. */
  settings?: { before: SettingsPatch; after: SettingsPatch; editedAt: string }
  /** What it could not even queue (an error before it was stored), and what storage refused (only in that window). */
  failed: RestorePart[]
  held: RestorePart[]
}

export type RestorePart = 'bets' | 'moves' | 'settings'

export interface UndoLog {
  at: string
  /** The stamp it asked about (the batch's when it was undone). */
  stamp: string
  /** Asked to remove, unless they changed since. */
  bets: string[]
  moves: string[]
  /** Left alone on this device already: changed since, or gone. */
  changedHere: number
  goneHere: number
  /** What the server did with what was asked. */
  removed: string[]
  kept: string[]
  /** The settings it put back, and the ones it left because they changed since. */
  settings?: { reverted: SettingsField[]; kept: SettingsField[] }
}

/** What the server made of a batch's ops, as the hooks hear it (see useBetSync). */
export type BatchEvent =
  | { kind: 'made'; batch: string; table: 'bets' | 'moves'; ids: string[] }
  | { kind: 'undo'; batch: string; table: 'bets' | 'moves'; id: string; removed: boolean }

export const MAX_IMPORTS = 20

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

const isBatch = (v: unknown): v is ImportBatch => {
  if (typeof v !== 'object' || v === null) return false
  const b = v as Record<string, unknown>
  return (
    typeof b.id === 'string' &&
    typeof b.at === 'string' &&
    typeof b.file === 'string' &&
    typeof b.fingerprint === 'string' &&
    strings(b.ids) &&
    (b.moveIds === undefined || strings(b.moveIds)) &&
    (b.made === undefined || strings(b.made)) &&
    (b.madeMoves === undefined || strings(b.madeMoves)) &&
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

function storeFor(userId: string): QueueStore<ImportBatch[]> {
  let store = stores.get(userId)
  if (!store) {
    store = queueStore<ImportBatch[]>({
      lock: `bettracker:history:${userId}`,
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

const union = (a: readonly string[] | undefined, b: readonly string[]): string[] => [...new Set([...(a ?? []), ...b])]

/**
 * What the server made of a batch's op, into its entry: the rows it made,
 * or what its Undo did with a row. An event for a batch no longer listed is
 * dropped. The same event twice changes nothing (an op sent again after its
 * answer was lost tells it again).
 */
export function foldBatchEvent(list: readonly ImportBatch[], e: BatchEvent): ImportBatch[] {
  return list.map((b) => {
    if (b.id !== e.batch) return b
    if (e.kind === 'made') return e.table === 'bets' ? { ...b, made: union(b.made, e.ids) } : { ...b, madeMoves: union(b.madeMoves, e.ids) }
    if (!b.undo) return b
    const removed = e.removed ? union(b.undo.removed, [e.id]) : b.undo.removed.filter((id) => id !== e.id)
    const kept = e.removed ? b.undo.kept.filter((id) => id !== e.id) : union(b.undo.kept, [e.id])
    return { ...b, undo: { ...b.undo, removed, kept } }
  })
}

export function recordBatchEvent(userId: string, e: BatchEvent): Promise<ImportBatch[]> {
  return updateImports(userId, (list) => foldBatchEvent(list, e))
}

/** Signed out: this window forgets the user's imports too (clearUserData clears storage). */
export function forgetImports(userId: string): void {
  stores.delete(userId)
}

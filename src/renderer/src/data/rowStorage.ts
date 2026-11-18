import { removeDurable, writeDurable, writeExpendable } from './store'
import { headAsSent, insertStamp, readJson, removes, rowKeys, writable, type PendingOp, type Refused, type RowTableName } from './offline'

/**
 * Device storage for the simple user-owned tables synced by useRowSync (the
 * expenses, cards and budgets of migration 008): a cache of the last-known
 * server rows, a queue of changes waiting to sync and a list of changes the
 * server refused, per user, under the keys of `rowKeys`. The same rules as
 * the moves' (offline.ts): a cache can be fetched again, so failing to store
 * it is fine; a queue exists nowhere else, so failing to store it throws
 * (StorageWriteError); and nothing of a user's is stored once they have
 * signed out on this device (see clearUserData), until they sign in again.
 */

export interface RowBase {
  id: string
  createdAt: string
  updatedAt: string
}

/** What storage needs to know about a row table (a subset of RowTableSpec, data/rowTable.ts). */
export interface RowStorageSpec<T extends RowBase, I> {
  name: RowTableName
  /** A cached row brought up to the current shape, or null for one that can't be used. */
  hydrate: (raw: unknown) => T | null
  /** The optimistic row a queued add renders as. */
  fromInput: (id: string, input: I, createdAt: string, updatedAt: string) => T
  /** A queued edit laid over the row it edits. */
  withInput: (row: T, input: I, updatedAt: string) => T
  /** Order of the cache and the UI's base order. */
  compare: (a: T, b: T) => number
}

// Generic in I as well: with strictFunctionTypes a RowStorageSpec<Expense, ExpenseInput> is NOT a RowStorageSpec<Expense, unknown>.

/**
 * Null when this device has never loaded the table, which is not the same as
 * having no rows: until it has, the list can't be known.
 */
export function loadRowCache<T extends RowBase, I>(userId: string, spec: RowStorageSpec<T, I>): T[] | null {
  const raw = readJson<unknown>(rowKeys(userId, spec.name).cache)
  if (!Array.isArray(raw)) return null
  return raw.map((r) => spec.hydrate(r)).filter((r): r is T => r !== null)
}

export function saveRowCache<T extends RowBase, I>(userId: string, spec: RowStorageSpec<T, I>, rows: readonly T[]): void {
  if (writable(userId)) writeExpendable(rowKeys(userId, spec.name).cache, rows)
}

/** The queue exactly as stored, for a change made under its lock. */
export function readRowOutbox<I>(userId: string, name: RowTableName): PendingOp<I>[] {
  const raw = readJson<PendingOp<I>[]>(rowKeys(userId, name).outbox)
  return Array.isArray(raw) ? raw : []
}

/** The queue as stored. Its head may have gone out with its answer lost (see headAsSent). */
export function loadRowOutbox<I>(userId: string, name: RowTableName): PendingOp<I>[] {
  return headAsSent(readRowOutbox<I>(userId, name))
}

/** Throws StorageWriteError when the queue can't be stored. */
export function saveRowOutbox<I>(userId: string, name: RowTableName, ops: readonly PendingOp<I>[]): void {
  if (writable(userId)) writeDurable(rowKeys(userId, name).outbox, ops)
}

export function loadRowRefused<I>(userId: string, name: RowTableName): Refused<I>[] {
  const raw = readJson<Refused<I>[]>(rowKeys(userId, name).refused)
  return Array.isArray(raw) ? raw : []
}

export function saveRowRefused<I>(userId: string, name: RowTableName, list: readonly Refused<I>[]): void {
  if (!writable(userId)) return
  const key = rowKeys(userId, name).refused
  if (list.length === 0) removeDurable(key)
  else writeDurable(key, list)
}

export function sortRows<T extends RowBase, I>(spec: RowStorageSpec<T, I>, rows: readonly T[]): T[] {
  return [...rows].sort(spec.compare)
}

/**
 * What the UI shows: the last-known rows with the queued changes on top, as
 * applyMoveOutbox does for moves. An edit of a row that is not there is
 * skipped (it was deleted; sending the edit will find no row). Imports are
 * never built for these tables, so a 'bulk-add' is ignored.
 */
export function applyRowOutbox<T extends RowBase, I>(spec: RowStorageSpec<T, I>, server: readonly T[], outbox: readonly PendingOp<I>[]): T[] {
  const map = new Map(server.map((r) => [r.id, r]))
  for (const op of outbox) {
    if (op.kind === 'add') {
      map.set(op.id, spec.fromInput(op.id, op.input, op.queuedAt, insertStamp(op)))
    } else if (op.kind === 'update') {
      const current = map.get(op.id)
      if (current) map.set(op.id, spec.withInput(current, op.input, op.editedAt))
    } else if (op.kind === 'delete' && removes(map.get(op.id), op)) {
      map.delete(op.id)
    }
  }
  return sortRows(spec, [...map.values()])
}

/**
 * Fold a synced op into the cached server state, as reconcileMove does: a
 * delete removes the row (or puts back the row the server answered with), an
 * add or an edit puts the row the server returned in its place, and one that
 * returned none (refused by the conflict check, a tombstone, or the row is
 * gone) leaves the state as the server had it.
 */
export function reconcileRow<T extends RowBase, I>(spec: RowStorageSpec<T, I>, server: readonly T[], op: PendingOp<I>, row: T | null): T[] {
  if (op.kind === 'delete') return row ? sortRows(spec, [...server.filter((r) => r.id !== row.id), row]) : server.filter((r) => r.id !== op.id)
  if (!row) return [...server]
  return sortRows(spec, [...server.filter((r) => r.id !== row.id), row])
}

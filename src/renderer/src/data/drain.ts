import type { Bet, BetInput, Settings } from '../../../shared/types'
import { classifySyncError } from './errors'
import type { PendingOp, PendingSettings } from './offline'

/**
 * Replaying queued changes against the server.
 *
 * The hooks (useBetSync, useSettings, useMoves) own the state; these
 * functions own the decisions: what leaves the queue, what stays, when to
 * stop, and what a failed read leaves on screen. They take their I/O as
 * arguments so every branch can be tested without React or Supabase.
 */

/**
 * How a drain ended:
 *  - 'done':    the queue is empty;
 *  - 'offline': the server was unreachable, the rest waits for the connection;
 *  - 'behind':  the database is missing a migration, the rest waits for it.
 * `processed` counts the ops that reached the server.
 */
export type DrainResult =
  | { stop: 'done'; processed: number }
  | { stop: 'offline'; processed: number }
  | { stop: 'behind'; processed: number; error: unknown }

export interface DrainHooks<I = BetInput, R = Bet> {
  /** The queue as it is now. Read before every op: the user can add to it while a request is out. */
  outbox: () => readonly PendingOp<I>[]
  setOutbox: (next: PendingOp<I>[]) => void
  /**
   * Mark an op `sent` just before its first request goes out (from then on
   * it may reach the server whatever the answer, so enqueueOp must never
   * rewrite or cancel it), or unmark it when that first request was refused
   * before it could apply. The mark is saved with the queue.
   */
  setSent: (op: PendingOp<I>, sent: boolean) => void
  /** Send one op; resolves with the row the server returned, if any. */
  send: (op: PendingOp<I>) => Promise<R | null>
  /**
   * The op reached the server. `superseded`: another op for the same bet is
   * still queued behind it, so a refused update is not the last word on
   * that bet (no "newer edit elsewhere" notice for it).
   */
  applied: (op: PendingOp<I>, result: R | null, superseded: boolean) => void
  /** The server refused the op for good; it has already left the queue. */
  rejected: (op: PendingOp<I>, err: unknown) => void
}

/**
 * Send the queued bet ops in order until the queue is empty or one can't go
 * through. A sent op leaves the queue by its opId, never by position: while
 * it was out the user may have queued more, so whatever is first by then may
 * be a different op.
 */
export async function drainOutbox<I = BetInput, R = Bet>(h: DrainHooks<I, R>): Promise<DrainResult> {
  let processed = 0
  const without = (op: PendingOp<I>): PendingOp<I>[] => h.outbox().filter((o) => o.opId !== op.opId)
  const forBet = (o: PendingOp<I>, op: PendingOp<I>): boolean => o.kind !== 'bulk-add' && op.kind !== 'bulk-add' && o.id === op.id
  for (let op = h.outbox()[0]; op !== undefined; op = h.outbox()[0]) {
    const firstTry = !op.sent
    if (firstTry) h.setSent(op, true)
    try {
      const result = await h.send(op)
      h.applied(op, result, h.outbox().some((o) => o.opId !== op.opId && forBet(o, op)))
      h.setOutbox(without(op))
      processed++
    } catch (err) {
      const failure = classifySyncError(err)
      // Unreachable, or the database is missing a migration: keep the op, and
      // everything queued after it, in order, for the next attempt.
      if (failure === 'offline') return { stop: 'offline', processed }
      if (failure === 'behind') {
        // Refused before it could apply: a first attempt never landed.
        if (firstTry) h.setSent(op, false)
        return { stop: 'behind', processed, error: err }
      }
      // The server rejected this op (validation, RLS, row gone). Drop it so it
      // can't block the queue, surface the error, and keep going. An add
      // refused on its first attempt (not as a duplicate) never made its bet,
      // so the edits queued for it go too: sent, they would come back refused,
      // as a false "newer edit" notice. Not after an earlier attempt (it may
      // have landed), and not for an import (earlier chunks may have landed);
      // deletes stay either way, as a delete of a missing row is harmless.
      const neverMade = op.kind === 'add' && firstTry && !/duplicate key/i.test(err instanceof Error ? err.message : String(err))
      h.setOutbox(without(op).filter((o) => !(neverMade && o.kind === 'update' && forBet(o, op))))
      h.rejected(op, err)
    }
  }
  return { stop: 'done', processed }
}

/**
 * How a settings push ended. 'conflict' means a newer edit from another
 * device already landed, so this one was dropped.
 */
export type SettingsPushResult =
  | { stop: 'saved'; row: Settings }
  | { stop: 'conflict' }
  | { stop: 'offline' }
  | { stop: 'behind'; error: unknown }
  | { stop: 'rejected'; error: unknown }

export interface SettingsPushHooks {
  pending: () => PendingSettings | null
  setPending: (next: PendingSettings | null) => void
  /** Resolves with the saved row, or null when a newer edit already landed. */
  save: (p: PendingSettings) => Promise<Settings | null>
}

/**
 * Push the one queued settings patch, with the same keep-or-drop rule as the
 * bets. Returns null when nothing was queued.
 */
export async function pushSettings(h: SettingsPushHooks): Promise<SettingsPushResult | null> {
  const p = h.pending()
  if (!p) return null
  try {
    const saved = await h.save(p)
    // Only clear the queue if nothing was added while the request was out.
    if (h.pending() === p) h.setPending(null)
    return saved ? { stop: 'saved', row: saved } : { stop: 'conflict' }
  } catch (err) {
    const failure = classifySyncError(err)
    if (failure === 'offline') return { stop: 'offline' }
    if (failure === 'behind') return { stop: 'behind', error: err }
    h.setPending(null)
    return { stop: 'rejected', error: err }
  }
}

/**
 * What a failed read of a table that a migration adds (the moves of 005)
 * leaves behind:
 *  - unreachable: the device copy stays and the badge says offline;
 *  - the table is missing: the database has no moves yet, so an empty list is
 *    the truth (a device copy from before is kept). `tableMissing` lets the
 *    hook keep looking for the migration. Nothing is reported: reads happen on
 *    every boot and resume, and the hint is for a change that waits on it;
 *  - refused for any other reason: the device copy stays and it is reported.
 * `server` is the snapshot to show from now on; `tableMissing` false says
 * nothing about the table either way.
 */
export interface FailedRead<T> {
  offline: boolean
  server: T[] | null
  tableMissing: boolean
  report: boolean
}

export function afterFailedRead<T>(err: unknown, cached: T[] | null): FailedRead<T> {
  const failure = classifySyncError(err)
  if (failure === 'offline') return { offline: true, server: cached, tableMissing: false, report: false }
  if (failure === 'behind') return { offline: false, server: cached ?? [], tableMissing: true, report: false }
  return { offline: false, server: cached, tableMissing: false, report: true }
}

/** What the header badge shows. 'behind': changes wait on a missing migration. */
export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'behind'

/**
 * The badge, from the queue and the last attempt. No session or no connection
 * comes first; then an empty queue is synced; then a queue held back by a
 * missing migration is 'behind'; anything else queued is on its way.
 * `queued` counts the waiting changes that the badge stands for.
 */
export function syncStatus(s: { canSync: boolean; offline: boolean; queued: number; behind: boolean }): SyncStatus {
  if (!s.canSync || s.offline) return 'offline'
  if (s.queued === 0) return 'synced'
  return s.behind ? 'behind' : 'syncing'
}

/**
 * One badge for several queues (the bets, the settings patch …): the first of
 * offline, syncing, behind that any of them is in, else synced. A queue held
 * back by a missing migration does not hide another that is on its way.
 * Callers pass 'synced' for a queue with nothing in it.
 */
export function combinedStatus(parts: readonly SyncStatus[]): SyncStatus {
  for (const s of ['offline', 'syncing', 'behind'] as const) if (parts.includes(s)) return s
  return 'synced'
}

/**
 * Whether a missing migration is known right now, so its hint is shown once
 * per episode rather than on every retry and resume. `found()` is true only
 * the first time since the last `clear()` (a request that went through, or a
 * queue that emptied).
 */
export interface MigrationNotice {
  readonly active: boolean
  found: () => boolean
  clear: () => void
}

export function migrationNotice(): MigrationNotice {
  let active = false
  return {
    get active() {
      return active
    },
    found() {
      const first = !active
      active = true
      return first
    },
    clear() {
      active = false
    }
  }
}

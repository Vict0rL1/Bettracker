import type { Bet, BetInput, Settings } from '../../../shared/types'
import { classifySyncError, retryDelay } from './errors'
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
 *  - 'paused':  Supabase refused who was asking (no session, a key it doesn't
 *               take), the rest waits for a sign-in or the right key;
 *  - 'retry':   the server failed for now (a 5xx, a rate limit), the rest
 *               waits for the next try, after a growing wait;
 *  - 'behind':  the database is missing a migration, the rest waits for it.
 * `processed` counts the ops that reached the server.
 */
export type DrainResult =
  | { stop: 'done'; processed: number }
  | { stop: 'offline'; processed: number }
  | { stop: 'paused' | 'retry' | 'behind'; processed: number; error: unknown }

export interface DrainHooks<I = BetInput, R = Bet> {
  /** The queue as it is now, other windows' changes included. Read before every op: it can grow while a request is out. */
  outbox: () => readonly PendingOp<I>[]
  /**
   * Change the queue: `fn` gets it as stored now, and nothing else changes it
   * until it is stored again (see store.ts). Resolves with the new queue.
   */
  update: (fn: (queue: PendingOp<I>[]) => PendingOp<I>[]) => readonly PendingOp<I>[] | Promise<readonly PendingOp<I>[]>
  /**
   * Send one op; resolves with the row the server returned, if any. An import
   * reports each chunk the server confirmed through `progress`, so a retry
   * after an interruption starts after it.
   */
  send: (op: PendingOp<I>, progress: (done: number) => Promise<void>) => Promise<R | null>
  /**
   * The op reached the server. `superseded`: another op for the same bet is
   * still queued behind it, so a refused update is not the last word on
   * that bet (no "newer edit elsewhere" notice for it).
   */
  applied: (op: PendingOp<I>, result: R | null, superseded: boolean) => void
  /**
   * The server refused these for good: the op, with the edits queued for a
   * bet it never made. They have left the queue; keep them where the user
   * can send them again.
   */
  rejected: (ops: PendingOp<I>[], err: unknown) => void | Promise<void>
}

const markSent = <I>(queue: PendingOp<I>[], opId: string, sent: boolean): PendingOp<I>[] =>
  queue.map((o) => (o.opId === opId ? { ...o, sent: sent ? (true as const) : undefined } : o))

/**
 * Send the queued ops in order until the queue is empty or one can't go
 * through. A sent op leaves the queue by its opId, never by position: while
 * it was out the user, or another window, may have queued more, so whatever
 * is first by then may be a different op.
 *
 * An op is marked `sent` in storage before its first request leaves, and the
 * op that goes is the one stored at that moment: another window may have
 * folded an edit into it, or cancelled it, just before. From then on no
 * window rewrites or cancels it (see enqueueOp).
 */
export async function drainOutbox<I = BetInput, R = Bet>(h: DrainHooks<I, R>): Promise<DrainResult> {
  let processed = 0
  const forBet = (o: PendingOp<I>, op: PendingOp<I>): boolean => o.kind !== 'bulk-add' && op.kind !== 'bulk-add' && o.id === op.id
  for (let head = h.outbox()[0]; head !== undefined; head = h.outbox()[0]) {
    let op: PendingOp<I> = head
    const firstTry = !op.sent
    if (firstTry) {
      const stored = (await h.update((q) => markSent(q, head.opId, true))).find((o) => o.opId === head.opId)
      // Cancelled by another window before it went: nothing to send.
      if (!stored) continue
      op = stored
    }
    const progress = async (done: number): Promise<void> => {
      await h.update((q) => q.map((o) => (o.opId === op.opId && o.kind === 'bulk-add' ? { ...o, done } : o)))
    }
    try {
      const result = await h.send(op, progress)
      h.applied(op, result, h.outbox().some((o) => o.opId !== op.opId && forBet(o, op)))
      await h.update((q) => q.filter((o) => o.opId !== op.opId))
      processed++
    } catch (err) {
      const failure = classifySyncError(err)
      // Unreachable, or the answer may be lost: keep the op, and everything
      // queued after it, in order, for the next attempt.
      if (failure === 'offline' || failure === 'retry') {
        return failure === 'offline' ? { stop: 'offline', processed } : { stop: 'retry', processed, error: err }
      }
      // No session, a key refused, or the database behind: refused before it
      // could apply, so a first attempt never landed and can still be folded
      // into or cancelled. Keep it and the rest for later.
      if (failure === 'paused' || failure === 'behind') {
        if (firstTry) await h.update((q) => markSent(q, op.opId, false))
        return { stop: failure, processed, error: err }
      }
      // The server refused this op for good (validation, RLS, row gone). It
      // leaves the queue so it can't block it, with the edits queued for its
      // bet if it was an add refused on its first try (not as a duplicate):
      // it never made the bet, so they would only come back refused, as false
      // "newer edit" notices. Not after an earlier attempt (it may have
      // landed), and not for an import (earlier chunks may have landed);
      // deletes stay either way, as a delete of a missing row is harmless.
      const neverMade = op.kind === 'add' && firstTry && !/duplicate key/i.test(err instanceof Error ? err.message : String(err))
      const gone: PendingOp<I>[] = []
      await h.update((q) =>
        q.filter((o) => {
          const leaves = o.opId === op.opId || (neverMade && o.kind === 'update' && forBet(o, op))
          if (leaves) gone.push(o)
          return !leaves
        })
      )
      await h.rejected(gone.length > 0 ? gone : [op], err)
    }
  }
  return { stop: 'done', processed }
}

/**
 * How a settings push ended. 'conflict' means a newer edit from another
 * device already landed, so this one lost.
 */
export type SettingsPushResult =
  | { stop: 'saved'; row: Settings }
  | { stop: 'conflict' }
  | { stop: 'offline' }
  | { stop: 'paused' | 'retry' | 'behind' | 'rejected'; error: unknown }

export interface SettingsPushHooks {
  pending: () => PendingSettings | null
  /**
   * `sent` has had its answer: take it out of what is pending (see
   * afterSettingsAnswer), keeping whatever was edited since it went.
   */
  settle: (sent: PendingSettings) => void | Promise<void>
  /** Resolves with the saved row, or null when a newer edit already landed. */
  save: (p: PendingSettings) => Promise<Settings | null>
}

/**
 * Push the one queued settings patch, with the same keep-or-drop rule as the
 * bets. Returns null when nothing was queued. Whatever the answer, it only
 * settles the patch that went: an edit made while it was out stays pending.
 */
export async function pushSettings(h: SettingsPushHooks): Promise<SettingsPushResult | null> {
  const p = h.pending()
  if (!p) return null
  try {
    const saved = await h.save(p)
    await h.settle(p)
    return saved ? { stop: 'saved', row: saved } : { stop: 'conflict' }
  } catch (err) {
    const failure = classifySyncError(err)
    if (failure === 'offline') return { stop: 'offline' }
    if (failure !== 'rejected') return { stop: failure, error: err }
    await h.settle(p)
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
 *  - signed out meanwhile, or a passing server failure: the device copy stays,
 *    and the next read tries again;
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
  // Signed out meanwhile, or a passing server failure: the next read will do.
  if (failure === 'paused' || failure === 'retry') return { offline: false, server: cached, tableMissing: false, report: false }
  return { offline: false, server: cached, tableMissing: false, report: true }
}

/**
 * What the header badge shows. 'behind': changes wait on a missing migration;
 * 'paused': on a sign-in or a key Supabase takes; 'retrying': on the next try
 * after a server failure.
 */
export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'paused' | 'retrying' | 'behind'

/**
 * The badge, from the queue and the last attempt. No session or no connection
 * comes first; then an empty queue is synced; then a queue held back says
 * why (paused, retrying, behind); anything else queued is on its way.
 * `queued` counts the waiting changes that the badge stands for.
 */
export function syncStatus(s: { canSync: boolean; offline: boolean; queued: number; behind: boolean; paused?: boolean; retrying?: boolean }): SyncStatus {
  if (!s.canSync || s.offline) return 'offline'
  if (s.queued === 0) return 'synced'
  if (s.paused) return 'paused'
  if (s.retrying) return 'retrying'
  return s.behind ? 'behind' : 'syncing'
}

/**
 * One badge for several queues (the bets, the settings patch …): the first of
 * offline, paused, retrying, syncing, behind that any of them is in, else
 * synced. A queue held back by a missing migration does not hide another
 * that is on its way. Callers pass 'synced' for a queue with nothing in it.
 */
export function combinedStatus(parts: readonly SyncStatus[]): SyncStatus {
  for (const s of ['offline', 'paused', 'retrying', 'syncing', 'behind'] as const) if (parts.includes(s)) return s
  return 'synced'
}

/**
 * When to try a queue again after a passing server failure (a 5xx, a rate
 * limit): `failed` starts the wait, doubling each time (see retryDelay), and
 * a request that goes through ends it. Meanwhile `waiting` is true and the
 * queue is left alone, whatever else asks for a sync.
 */
export interface Backoff {
  readonly waiting: boolean
  /** The wait before the next try, in ms. */
  failed: (err: unknown) => number
  reset: () => void
}

export function backoff(now: () => number = Date.now): Backoff {
  let attempt = 0
  let until = 0
  return {
    get waiting() {
      return now() < until
    },
    failed(err) {
      attempt++
      const wait = retryDelay(attempt, err)
      until = now() + wait
      return wait
    },
    reset() {
      attempt = 0
      until = 0
    }
  }
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

/**
 * Where a row that an op got back from the server goes. Into the snapshot
 * when this device has one; otherwise it is kept apart (`landed`): one row is
 * not the whole list, and caching it as the list would show a bankroll as
 * known while missing everything else. The first full read replaces both.
 */
export function foldApplied<T>(
  server: readonly T[] | null,
  landed: readonly T[],
  fold: (rows: readonly T[]) => T[]
): { server: T[] | null; landed: T[] } {
  return server === null ? { server: null, landed: fold(landed) } : { server: fold(server), landed: [...landed] }
}

/**
 * What the slow retry timer does for a queue backed by a table:
 *  - 'read': nothing has been read yet (the first read failed, and with the
 *    connection still "up" no online event will come), or the last read found
 *    the table missing (a window left open must notice the migration): send
 *    what is queued, then read;
 *  - 'drain': something is queued;
 *  - 'idle': nothing to do.
 */
export function retryPlan(s: { queued: boolean; loaded: boolean; tableMissing?: boolean }): 'read' | 'drain' | 'idle' {
  if (!s.loaded || s.tableMissing) return 'read'
  return s.queued ? 'drain' : 'idle'
}

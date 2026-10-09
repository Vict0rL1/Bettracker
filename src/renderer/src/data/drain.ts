import type { Bet, Settings } from '../../../shared/types'
import { classifySyncError } from './errors'
import type { PendingOp, PendingSettings } from './offline'

/**
 * Replaying queued changes against the server.
 *
 * The hooks (useBetSync, useSettings) own the state; these functions own the
 * decisions: what leaves the queue, what stays, and when to stop. They take
 * their I/O as arguments so every branch can be tested without React or
 * Supabase.
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

export interface DrainHooks {
  /** The queue as it is now. Read before every op: the user can add to it while a request is out. */
  outbox: () => readonly PendingOp[]
  setOutbox: (next: PendingOp[]) => void
  /** Send one op; resolves with the row the server returned, if any. */
  send: (op: PendingOp) => Promise<Bet | null>
  /** The op reached the server. */
  applied: (op: PendingOp, result: Bet | null) => void
  /** The server refused the op for good; it has already left the queue. */
  rejected: (op: PendingOp, err: unknown) => void
}

/** Send the queued bet ops in order until the queue is empty or one can't go through. */
export async function drainOutbox(h: DrainHooks): Promise<DrainResult> {
  let processed = 0
  for (let op = h.outbox()[0]; op !== undefined; op = h.outbox()[0]) {
    try {
      const result = await h.send(op)
      h.applied(op, result)
      h.setOutbox(h.outbox().slice(1))
      processed++
    } catch (err) {
      const failure = classifySyncError(err)
      // Unreachable, or the database is missing a migration: keep the op, and
      // everything queued after it, in order, for the next attempt.
      if (failure === 'offline') return { stop: 'offline', processed }
      if (failure === 'behind') return { stop: 'behind', processed, error: err }
      // The server rejected this op (validation, RLS, row gone). Drop it so it
      // can't block the queue, surface the error, and keep going.
      h.setOutbox(h.outbox().slice(1))
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

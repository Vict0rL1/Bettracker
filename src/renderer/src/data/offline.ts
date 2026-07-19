import type { BetEntry, EntryInput } from '../../../shared/types'

/**
 * Device-local persistence for offline support.
 *
 * Two things are stored per user:
 *  - a cache of the last-known server rows, so the app opens instantly (and
 *    works read-only) without a connection;
 *  - an outbox of pending mutations made while offline, replayed in order
 *    once the connection returns.
 *
 * Entry ids are client-generated UUIDs, so an optimistic row keeps the same id
 * after it syncs and a retried insert can be recognized as a duplicate instead
 * of creating a second row.
 */

export type PendingOp =
  | { opId: string; kind: 'add'; id: string; input: EntryInput; queuedAt: string }
  | { opId: string; kind: 'update'; id: string; input: EntryInput }
  | { opId: string; kind: 'delete'; id: string }

export interface OfflineUser {
  id: string
  email: string | null
}

const cacheKey = (userId: string): string => `bettracker:cache:${userId}`
const outboxKey = (userId: string): string => `bettracker:outbox:${userId}`
const LAST_USER_KEY = 'bettracker:last-user'

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or unavailable — the app still works, just without offline.
  }
}

export const loadCache = (userId: string): BetEntry[] | null => readJson<BetEntry[]>(cacheKey(userId))
export const saveCache = (userId: string, entries: readonly BetEntry[]): void => writeJson(cacheKey(userId), entries)

export const loadOutbox = (userId: string): PendingOp[] => readJson<PendingOp[]>(outboxKey(userId)) ?? []
export const saveOutbox = (userId: string, outbox: readonly PendingOp[]): void => writeJson(outboxKey(userId), outbox)

export const loadLastUser = (): OfflineUser | null => readJson<OfflineUser>(LAST_USER_KEY)
export const saveLastUser = (user: OfflineUser): void => writeJson(LAST_USER_KEY, user)

/** Wipe everything this device knows about a user (used on sign-out). */
export function clearUserData(userId: string): void {
  try {
    localStorage.removeItem(cacheKey(userId))
    localStorage.removeItem(outboxKey(userId))
    localStorage.removeItem(LAST_USER_KEY)
  } catch {
    // best effort
  }
}

const byDateThenCreated = (a: BetEntry, b: BetEntry): number => {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.id < b.id ? -1 : 1
}

export const sortEntries = (entries: readonly BetEntry[]): BetEntry[] => [...entries].sort(byDateThenCreated)

/** What the UI shows: last-known server rows with pending local ops layered on top. */
export function applyOutbox(server: readonly BetEntry[], outbox: readonly PendingOp[]): BetEntry[] {
  const map = new Map(server.map((e) => [e.id, e]))
  for (const op of outbox) {
    if (op.kind === 'add') {
      map.set(op.id, {
        id: op.id,
        date: op.input.date,
        amount: op.input.amount,
        note: op.input.note ?? '',
        createdAt: op.queuedAt,
        updatedAt: op.queuedAt
      })
    } else if (op.kind === 'update') {
      const current = map.get(op.id)
      if (current) {
        map.set(op.id, { ...current, date: op.input.date, amount: op.input.amount, note: op.input.note ?? '' })
      }
    } else {
      map.delete(op.id)
    }
  }
  return sortEntries([...map.values()])
}

/**
 * Queue a mutation, collapsing redundant work:
 *  - editing a not-yet-synced add rewrites that add in place;
 *  - repeated edits of one entry keep a single update op;
 *  - deleting a not-yet-synced add cancels it entirely (the server never
 *    hears about it); deleting a synced entry drops its pending edits.
 */
export function enqueueOp(outbox: readonly PendingOp[], op: PendingOp): PendingOp[] {
  if (op.kind === 'update') {
    const i = outbox.findIndex((o) => o.id === op.id && (o.kind === 'add' || o.kind === 'update'))
    if (i >= 0) {
      const next = [...outbox]
      const prev = next[i] as Extract<PendingOp, { kind: 'add' | 'update' }>
      next[i] = { ...prev, input: op.input }
      return next
    }
    return [...outbox, op]
  }
  if (op.kind === 'delete') {
    const hadPendingAdd = outbox.some((o) => o.kind === 'add' && o.id === op.id)
    const filtered = outbox.filter((o) => o.id !== op.id)
    return hadPendingAdd ? filtered : [...filtered, op]
  }
  return [...outbox, op]
}

/** Fold a successfully synced op (and the row the server returned) into the cached server state. */
export function reconcile(server: readonly BetEntry[], op: PendingOp, result: BetEntry | null): BetEntry[] {
  if (op.kind === 'delete') return server.filter((e) => e.id !== op.id)
  if (!result) return [...server]
  const rest = server.filter((e) => e.id !== result.id)
  return sortEntries([...rest, result])
}

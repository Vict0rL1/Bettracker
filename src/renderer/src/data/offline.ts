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
  /** A CSV import: many rows in one op so it syncs as a few chunked requests. */
  | { opId: string; kind: 'bulk-add'; entries: { id: string; input: EntryInput }[]; queuedAt: string }

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

/**
 * Bring a cached row up to the current shape. A cache written by an older
 * version has no stake/tag fields; without this they'd read as `undefined`,
 * which is neither "no stake" nor a number and would poison ROI with NaN.
 */
export function hydrateEntry(raw: Partial<BetEntry> & { id: string; date: string }): BetEntry {
  const stake = raw.stake
  return {
    id: raw.id,
    date: raw.date,
    amount: Number(raw.amount ?? 0),
    stake: typeof stake === 'number' && Number.isFinite(stake) ? stake : null,
    note: raw.note ?? '',
    sport: raw.sport ?? '',
    book: raw.book ?? '',
    betType: raw.betType ?? '',
    createdAt: raw.createdAt ?? '',
    updatedAt: raw.updatedAt ?? ''
  }
}

export function loadCache(userId: string): BetEntry[] | null {
  const raw = readJson<(Partial<BetEntry> & { id: string; date: string })[]>(cacheKey(userId))
  return raw === null ? null : raw.map(hydrateEntry)
}

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

/** How many rows a pending op will write (used for the "queued" badge). */
export const opSize = (op: PendingOp): number => (op.kind === 'bulk-add' ? op.entries.length : 1)

/** The optimistic row an add/bulk-add member renders as before it reaches the server. */
function optimisticRow(id: string, input: EntryInput, queuedAt: string): BetEntry {
  return {
    id,
    date: input.date,
    amount: input.amount,
    stake: input.stake ?? null,
    note: input.note ?? '',
    sport: input.sport ?? '',
    book: input.book ?? '',
    betType: input.betType ?? '',
    createdAt: queuedAt,
    updatedAt: queuedAt
  }
}

/** What the UI shows: last-known server rows with pending local ops layered on top. */
export function applyOutbox(server: readonly BetEntry[], outbox: readonly PendingOp[]): BetEntry[] {
  const map = new Map(server.map((e) => [e.id, e]))
  for (const op of outbox) {
    if (op.kind === 'add') {
      map.set(op.id, optimisticRow(op.id, op.input, op.queuedAt))
    } else if (op.kind === 'bulk-add') {
      for (const { id, input } of op.entries) map.set(id, optimisticRow(id, input, op.queuedAt))
    } else if (op.kind === 'update') {
      const current = map.get(op.id)
      if (current) {
        map.set(op.id, {
          ...current,
          date: op.input.date,
          amount: op.input.amount,
          stake: op.input.stake ?? null,
          note: op.input.note ?? '',
          sport: op.input.sport ?? '',
          book: op.input.book ?? '',
          betType: op.input.betType ?? ''
        })
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
 *
 * Rows inside a pending bulk-add are deliberately left alone: the import is
 * replayed as-is and the later edit/delete op applies on top, which costs one
 * extra request but keeps the import an all-or-nothing unit.
 */
export function enqueueOp(outbox: readonly PendingOp[], op: PendingOp): PendingOp[] {
  if (op.kind === 'update') {
    const i = outbox.findIndex((o) => (o.kind === 'add' || o.kind === 'update') && o.id === op.id)
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
    const filtered = outbox.filter((o) => o.kind === 'bulk-add' || o.id !== op.id)
    return hadPendingAdd ? filtered : [...filtered, op]
  }
  return [...outbox, op]
}

/** Fold a successfully synced op (and the row the server returned) into the cached server state. */
export function reconcile(server: readonly BetEntry[], op: PendingOp, result: BetEntry | null): BetEntry[] {
  if (op.kind === 'delete') return server.filter((e) => e.id !== op.id)
  if (op.kind === 'bulk-add') {
    // The server stored exactly what we sent, so keep the local rows rather than
    // blanking them; the refresh that follows a drain trues up the timestamps.
    const ids = new Set(op.entries.map((e) => e.id))
    const rest = server.filter((e) => !ids.has(e.id))
    const added = op.entries.map(({ id, input }) => optimisticRow(id, input, op.queuedAt))
    return sortEntries([...rest, ...added])
  }
  if (!result) return [...server]
  const rest = server.filter((e) => e.id !== result.id)
  return sortEntries([...rest, result])
}

import { DEFAULT_SETTINGS, isBetStatus, statusForAmount, type Bet, type BetInput, type BetStatus, type Settings, type SettingsPatch } from '../../../shared/types'

/**
 * Device-local persistence for offline support.
 *
 * Two things are stored per user:
 *  - a cache of the last-known server rows, so the app opens instantly (and
 *    works read-only) without a connection;
 *  - an outbox of pending mutations made while offline, replayed in order
 *    once the connection returns.
 *
 * Bet ids are client-generated UUIDs, so an optimistic row keeps the same id
 * after it syncs and a retried insert can be recognized as a duplicate instead
 * of creating a second row.
 */

/**
 * `sent` marks an op whose request has gone out at least once. Whether that
 * request failed or not, it may have reached the server, so the op is never
 * rewritten or cancelled from then on (see enqueueOp).
 */
export type PendingOp =
  /** `editedAt`, when present, is the last edit folded into a not-yet-sent add. */
  | { opId: string; kind: 'add'; id: string; input: BetInput; queuedAt: string; editedAt?: string; sent?: true }
  /**
   * `editedAt` is when the user made the edit — the conflict key, see data/bets.ts.
   * `legacy` marks an edit queued by a version from before migration 003: its
   * input only has the fields that version knew, and it is sent the way that
   * version sent it (see loadOutbox).
   */
  | { opId: string; kind: 'update'; id: string; input: BetInput; editedAt: string; legacy?: true; sent?: true }
  | { opId: string; kind: 'delete'; id: string; sent?: true }
  /** A CSV import: many rows in one op so it syncs as a few chunked requests. */
  | { opId: string; kind: 'bulk-add'; entries: { id: string; input: BetInput }[]; queuedAt: string; sent?: true }

/**
 * The time an insert writes as `updated_at`: when its content was last set on
 * the device (the add itself, or the last edit folded into it). Device time,
 * like every edit's, so the conflict check compares like with like.
 */
export const insertStamp = (op: Extract<PendingOp, { kind: 'add' | 'bulk-add' }>): string =>
  op.kind === 'add' ? (op.editedAt ?? op.queuedAt) : op.queuedAt

export interface OfflineUser {
  id: string
  email: string | null
}

const cacheKey = (userId: string): string => `bettracker:cache:${userId}`
const outboxKey = (userId: string): string => `bettracker:outbox:${userId}`
const settingsKey = (userId: string): string => `bettracker:settings:${userId}`
const settingsOutboxKey = (userId: string): string => `bettracker:settings-outbox:${userId}`
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

const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Bring a cached row up to the current shape. A cache written by an older
 * version has no stake/tag/odds/status fields; without this they'd read as
 * `undefined`, which is neither "no stake" nor a number and would poison ROI
 * with NaN. A row with no status gets the one its amount implies — the same
 * rule the 003 migration used — and a row with no amount at all is pending.
 */
export function hydrateBet(raw: Partial<Bet> & { id: string; date: string }): Bet {
  const amount = finiteOrNull(raw.amount)
  const status = isBetStatus(raw.status) ? raw.status : amount === null ? 'pending' : statusForAmount(amount)
  return {
    id: raw.id,
    date: raw.date,
    amount: status === 'pending' ? null : (amount ?? 0),
    stake: finiteOrNull(raw.stake),
    odds: finiteOrNull(raw.odds),
    closingOdds: finiteOrNull(raw.closingOdds),
    status,
    note: raw.note ?? '',
    sport: raw.sport ?? '',
    book: raw.book ?? '',
    betType: raw.betType ?? '',
    createdAt: raw.createdAt ?? '',
    updatedAt: raw.updatedAt ?? ''
  }
}

export function loadCache(userId: string): Bet[] | null {
  const raw = readJson<(Partial<Bet> & { id: string; date: string })[]>(cacheKey(userId))
  return raw === null ? null : raw.map(hydrateBet)
}

export const saveCache = (userId: string, bets: readonly Bet[]): void => writeJson(cacheKey(userId), bets)

/**
 * The queue as stored. One written by a version from before migration 003
 * has edits without `editedAt`, whose input only carries the fields that
 * version knew (date, amount, note, and from 002 stake and tags). Sent as a
 * full edit, it would blank odds, closing odds and whatever else it lacks,
 * and its $0 for a pending bet (that version shows one as $0) would settle it
 * as a push; sent with no edit time, the conflict check would refuse it. So
 * it is marked `legacy` and stamped with the moment the queue is loaded, and
 * goes out the way that version sent it: its own fields, no status (see
 * updateBetLegacy), which the 003 trigger treats like any write from it.
 */
export function loadOutbox(userId: string, loadedAt: string = new Date().toISOString()): PendingOp[] {
  const ops = readJson<PendingOp[]>(outboxKey(userId)) ?? []
  return ops.map((op) => (op.kind === 'update' && typeof op.editedAt !== 'string' ? { ...op, editedAt: loadedAt, legacy: true } : op))
}

const fitsStatus = (status: BetStatus, amount: number | null): boolean =>
  status === 'pending' ? amount === null : amount !== null && (status === 'won' ? amount > 0 : status === 'lost' ? amount < 0 : amount === 0)

/**
 * A legacy edit (see loadOutbox) laid over the row it edits, the way the
 * database applies it: only the fields it carries are written, and the
 * status follows migration 003's trigger — a pending bet sent back as $0
 * stays pending, a status the new amount no longer fits is worked out again.
 */
export function applyLegacyEdit(current: Bet, input: BetInput): Bet {
  let amount = typeof input.amount === 'number' ? input.amount : current.amount
  let status = current.status
  if (status === 'pending' && amount === 0) amount = null
  else if (!fitsStatus(status, amount)) status = amount === null ? 'pending' : statusForAmount(amount)
  return {
    ...current,
    date: input.date,
    amount,
    status,
    ...('note' in input ? { note: input.note ?? '' } : {}),
    ...('stake' in input ? { stake: input.stake ?? null } : {}),
    ...('sport' in input ? { sport: input.sport ?? '' } : {}),
    ...('book' in input ? { book: input.book ?? '' } : {}),
    ...('betType' in input ? { betType: input.betType ?? '' } : {})
  }
}
export const saveOutbox = (userId: string, outbox: readonly PendingOp[]): void => writeJson(outboxKey(userId), outbox)

/** Settings are one row; the cache holds the last-known row and the outbox at most one pending patch. */
export const loadSettingsCache = (userId: string): Settings | null => {
  const raw = readJson<Partial<Settings>>(settingsKey(userId))
  return raw === null ? null : { ...DEFAULT_SETTINGS, ...raw }
}
export const saveSettingsCache = (userId: string, s: Settings): void => writeJson(settingsKey(userId), s)

export interface PendingSettings {
  patch: SettingsPatch
  editedAt: string
}
export const loadSettingsOutbox = (userId: string): PendingSettings | null => readJson<PendingSettings>(settingsOutboxKey(userId))
export const saveSettingsOutbox = (userId: string, p: PendingSettings | null): void => {
  if (p === null) {
    try {
      localStorage.removeItem(settingsOutboxKey(userId))
    } catch {
      // best effort
    }
  } else writeJson(settingsOutboxKey(userId), p)
}

export const loadLastUser = (): OfflineUser | null => readJson<OfflineUser>(LAST_USER_KEY)
export const saveLastUser = (user: OfflineUser): void => writeJson(LAST_USER_KEY, user)

/** Wipe everything this device knows about a user (used on sign-out). */
export function clearUserData(userId: string): void {
  try {
    localStorage.removeItem(cacheKey(userId))
    localStorage.removeItem(outboxKey(userId))
    localStorage.removeItem(settingsKey(userId))
    localStorage.removeItem(settingsOutboxKey(userId))
    localStorage.removeItem(LAST_USER_KEY)
  } catch {
    // best effort
  }
}

const byDateThenCreated = (a: Bet, b: Bet): number => {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.id < b.id ? -1 : 1
}

export const sortBets = (bets: readonly Bet[]): Bet[] => [...bets].sort(byDateThenCreated)

/** How many rows a pending op will write (used for the "queued" badge). */
export const opSize = (op: PendingOp): number => (op.kind === 'bulk-add' ? op.entries.length : 1)

/** The fields an input carries over onto a row, in the row's shape. */
function fieldsFrom(input: BetInput): Pick<Bet, 'date' | 'amount' | 'stake' | 'odds' | 'closingOdds' | 'status' | 'note' | 'sport' | 'book' | 'betType'> {
  const amount = input.amount ?? null
  const status = input.status ?? (amount === null ? 'pending' : statusForAmount(amount))
  return {
    date: input.date,
    amount: status === 'pending' ? null : amount,
    stake: input.stake ?? null,
    odds: input.odds ?? null,
    closingOdds: input.closingOdds ?? null,
    status,
    note: input.note ?? '',
    sport: input.sport ?? '',
    book: input.book ?? '',
    betType: input.betType ?? ''
  }
}

/** The optimistic row an add/bulk-add member renders as before it reaches the server. */
function optimisticRow(id: string, input: BetInput, queuedAt: string, updatedAt: string = queuedAt): Bet {
  return { id, ...fieldsFrom(input), createdAt: queuedAt, updatedAt }
}

/** What the UI shows: last-known server rows with pending local ops layered on top. */
export function applyOutbox(server: readonly Bet[], outbox: readonly PendingOp[]): Bet[] {
  const map = new Map(server.map((b) => [b.id, b]))
  for (const op of outbox) {
    if (op.kind === 'add') {
      map.set(op.id, optimisticRow(op.id, op.input, op.queuedAt, insertStamp(op)))
    } else if (op.kind === 'bulk-add') {
      for (const { id, input } of op.entries) map.set(id, optimisticRow(id, input, op.queuedAt))
    } else if (op.kind === 'update') {
      const current = map.get(op.id)
      if (current && op.legacy) map.set(op.id, { ...applyLegacyEdit(current, op.input), updatedAt: op.editedAt })
      else if (current) map.set(op.id, { ...current, ...fieldsFrom(op.input), updatedAt: op.editedAt })
    } else {
      map.delete(op.id)
    }
  }
  return sortBets([...map.values()])
}

/**
 * Queue a mutation, collapsing redundant work:
 *  - editing a not-yet-synced add rewrites that add in place;
 *  - repeated edits of one bet keep a single update op, stamped with the
 *    latest edit time;
 *  - deleting a not-yet-synced add cancels it entirely (the server never
 *    hears about it); deleting a synced bet drops its pending edits.
 *
 * Only ops that have not been sent are collapsed. A `sent` op (its request
 * went out, whether it answered or not) may already be on the server, so it
 * is never rewritten or cancelled: an edit queues behind it, and a delete of
 * its bet is queued even when the op is the add. An edit folds into the last
 * op queued for its bet, never an earlier one, so the newest state is always
 * what is sent last.
 *
 * Rows inside a pending bulk-add are deliberately left alone: the import is
 * replayed as-is and the later edit/delete op applies on top, which costs one
 * extra request but keeps the import an all-or-nothing unit.
 */
export function enqueueOp(outbox: readonly PendingOp[], op: PendingOp): PendingOp[] {
  const forBet = (o: PendingOp, id: string): boolean => o.kind !== 'bulk-add' && o.id === id
  if (op.kind === 'update') {
    let i = outbox.length - 1
    while (i >= 0 && !forBet(outbox[i], op.id)) i--
    const last = outbox[i]
    if (last && !last.sent && (last.kind === 'add' || last.kind === 'update')) {
      const next = [...outbox]
      // A legacy edit overtaken by a full one is a full edit from then on.
      next[i] = last.kind === 'add' ? { ...last, input: op.input, editedAt: op.editedAt } : { ...last, input: op.input, editedAt: op.editedAt, legacy: undefined }
      return next
    }
    return [...outbox, op]
  }
  if (op.kind === 'delete') {
    const mine = outbox.filter((o) => forBet(o, op.id))
    // Only an add that never went out can be cancelled outright, and only if
    // no delete is queued before it: then the row exists on the server and a
    // later add is an Undo re-adding it, so deleting again must reach it.
    const cancellable = mine.some((o) => !o.sent && o.kind === 'add') && !mine.some((o) => o.kind === 'delete')
    const kept = outbox.filter((o) => !forBet(o, op.id) || o.sent)
    return cancellable ? kept : [...kept, op]
  }
  return [...outbox, op]
}

/**
 * Fold a successfully synced op (and the row the server returned) into the
 * cached server state. An update that returned no row was refused by the
 * conflict check (or the row is gone): the local state is left as the server
 * had it, and the refresh that follows a drain brings the winning version.
 */
export function reconcile(server: readonly Bet[], op: PendingOp, result: Bet | null): Bet[] {
  if (op.kind === 'delete') return server.filter((b) => b.id !== op.id)
  if (op.kind === 'bulk-add') {
    // The server stored exactly what we sent, so keep the local rows rather than
    // blanking them; the refresh that follows a drain trues up the timestamps.
    const ids = new Set(op.entries.map((e) => e.id))
    const rest = server.filter((b) => !ids.has(b.id))
    const added = op.entries.map(({ id, input }) => optimisticRow(id, input, op.queuedAt))
    return sortBets([...rest, ...added])
  }
  if (!result) return [...server]
  const rest = server.filter((b) => b.id !== result.id)
  return sortBets([...rest, result])
}

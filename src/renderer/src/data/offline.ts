import { DEFAULT_SETTINGS, isBetStatus, statusForAmount, type BankrollMove, type Bet, type BetInput, type BetStatus, type MoveInput, type Settings, type SettingsPatch } from '../../../shared/types'
import { isValidDate } from '../lib/validate'
import { removeDurable, writeDurable, writeExpendable } from './store'

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
 *
 * The caches can be fetched again, so failing to store one is ignored; the
 * queues exist nowhere else, so failing to store one throws (see store.ts).
 */

/**
 * `sent` marks an op whose request has gone out at least once. Whether that
 * request failed or not, it may have reached the server, so the op is never
 * rewritten or cancelled from then on (see enqueueOp).
 */
export type PendingOp<I = BetInput> =
  /** `editedAt`, when present, is the last edit folded into a not-yet-sent add. */
  | { opId: string; kind: 'add'; id: string; input: I; queuedAt: string; editedAt?: string; sent?: true }
  /**
   * `editedAt` is when the user made the edit — the conflict key, see data/bets.ts.
   * `legacy` marks an edit queued by a version from before migration 003: its
   * input only has the fields that version knew, and it is sent the way that
   * version sent it (see loadOutbox).
   */
  | { opId: string; kind: 'update'; id: string; input: I; editedAt: string; legacy?: true; sent?: true }
  | { opId: string; kind: 'delete'; id: string; sent?: true }
  /**
   * A CSV import: many rows in one op so it syncs as a few chunked requests.
   * `done` counts the leading entries the server has confirmed, so a retry
   * after an interruption sends only the rest (see addBets).
   */
  | { opId: string; kind: 'bulk-add'; entries: { id: string; input: I }[]; queuedAt: string; done?: number; sent?: true }

/**
 * A queued deposit or withdrawal: the same op shapes and rules as bets. Only
 * add, update and delete are ever built for moves (no import, no legacy).
 */
export type MoveOp = PendingOp<MoveInput>

/**
 * The time an insert writes as `updated_at`: when its content was last set on
 * the device (the add itself, or the last edit folded into it). Device time,
 * like every edit's, so the conflict check compares like with like.
 */
export const insertStamp = <I>(op: Extract<PendingOp<I>, { kind: 'add' | 'bulk-add' }>): string =>
  op.kind === 'add' ? (op.editedAt ?? op.queuedAt) : op.queuedAt

export interface OfflineUser {
  id: string
  email: string | null
}

const cacheKey = (userId: string): string => `bettracker:cache:${userId}`
const outboxKey = (userId: string): string => `bettracker:outbox:${userId}`
const settingsKey = (userId: string): string => `bettracker:settings:${userId}`
const settingsOutboxKey = (userId: string): string => `bettracker:settings-outbox:${userId}`
const movesKey = (userId: string): string => `bettracker:moves:${userId}`
const movesOutboxKey = (userId: string): string => `bettracker:moves-outbox:${userId}`
const refusedKey = (userId: string): string => `bettracker:refused:${userId}`
const movesRefusedKey = (userId: string): string => `bettracker:moves-refused:${userId}`
const LAST_USER_KEY = 'bettracker:last-user'

/** The storage keys of a user's queues, which other windows watch for (see the hooks' storage listeners). */
export const queueKeys = (userId: string) => ({
  outbox: outboxKey(userId),
  moves: movesOutboxKey(userId),
  settings: settingsOutboxKey(userId),
  refused: refusedKey(userId),
  movesRefused: movesRefusedKey(userId),
  cache: cacheKey(userId),
  movesCache: movesKey(userId),
  settingsCache: settingsKey(userId)
})

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
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

export const saveCache = (userId: string, bets: readonly Bet[]): void => writeExpendable(cacheKey(userId), bets)

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
  return headAsSent(readOutbox(userId, loadedAt))
}

/** The queue exactly as stored (legacy edits stamped, see loadOutbox), for a change made under its lock. */
export function readOutbox(userId: string, loadedAt: string = new Date().toISOString()): PendingOp[] {
  const ops = readJson<PendingOp[]>(outboxKey(userId)) ?? []
  return ops.map((op) => (op.kind === 'update' && typeof op.editedAt !== 'string' ? { ...op, editedAt: loadedAt, legacy: true as const } : op))
}

/**
 * The head of a stored queue may have gone out with its answer lost. This
 * version saves `sent` before a request leaves; one from before it did not,
 * and its queue looks the same (and a save can fail when storage is full).
 * So the head is taken as sent either way: never rewritten or cancelled, at
 * the cost of a request at most (an edit queued behind it instead of folded
 * in, a delete sent after it).
 */
export const headAsSent = <T extends { sent?: true }>(ops: readonly T[]): T[] =>
  ops.map((op, i) => (i === 0 && !op.sent ? { ...op, sent: true as const } : op))

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
/** Throws StorageWriteError when the queue can't be stored. */
export const saveOutbox = (userId: string, outbox: readonly PendingOp[]): void => writeDurable(outboxKey(userId), outbox)

/** Settings are one row; the cache holds the last-known row and the outbox at most one pending patch. */
export const loadSettingsCache = (userId: string): Settings | null => {
  const raw = readJson<Partial<Settings>>(settingsKey(userId))
  return raw === null ? null : { ...DEFAULT_SETTINGS, ...raw }
}
export const saveSettingsCache = (userId: string, s: Settings): void => writeExpendable(settingsKey(userId), s)

export interface PendingSettings {
  patch: SettingsPatch
  editedAt: string
}
export const loadSettingsOutbox = (userId: string): PendingSettings | null => readJson<PendingSettings>(settingsOutboxKey(userId))
/** Throws StorageWriteError when the patch can't be stored. */
export const saveSettingsOutbox = (userId: string, p: PendingSettings | null): void => {
  if (p === null) removeDurable(settingsOutboxKey(userId))
  else writeDurable(settingsOutboxKey(userId), p)
}

/**
 * What is left pending once `sent` has had its answer — saved, refused, or
 * beaten by a newer edit from another device: the edits made since it went
 * out. A field still at the value that went has had its answer and goes; a
 * field changed since stays, with the time of the newest edit.
 */
export function afterSettingsAnswer(current: PendingSettings | null, sent: PendingSettings): PendingSettings | null {
  if (!current) return null
  const sentPatch = sent.patch as Record<string, unknown>
  const left = Object.fromEntries(Object.entries(current.patch).filter(([k, v]) => !(k in sentPatch) || !Object.is(sentPatch[k], v)))
  return Object.keys(left).length > 0 ? { patch: left as SettingsPatch, editedAt: current.editedAt } : null
}

/**
 * Two windows' pending patches as one, for when storage takes them again:
 * the newer edit's fields win.
 */
export function mergeSettingsPending(stored: PendingSettings | null, mine: PendingSettings | null): PendingSettings | null {
  if (!stored || !mine) return mine ?? stored
  const [older, newer] = stored.editedAt <= mine.editedAt ? [stored, mine] : [mine, stored]
  return { patch: { ...older.patch, ...newer.patch }, editedAt: newer.editedAt }
}

export const loadLastUser = (): OfflineUser | null => readJson<OfflineUser>(LAST_USER_KEY)
export const saveLastUser = (user: OfflineUser): void => writeExpendable(LAST_USER_KEY, user)

/**
 * Changes the server refused for good, kept apart from the queue so they
 * can't block it, until the user sends them again or lets them go. `ops` is
 * the refused op with the edits queued for a bet it never made.
 */
export interface Refused<I = BetInput> {
  ops: PendingOp<I>[]
  reason: string
  at: string
}
export const loadRefused = (userId: string): Refused[] => readJson<Refused[]>(refusedKey(userId)) ?? []
export const saveRefused = (userId: string, list: readonly Refused[]): void =>
  list.length === 0 ? removeDurable(refusedKey(userId)) : writeDurable(refusedKey(userId), list)
export const loadMovesRefused = (userId: string): Refused<MoveInput>[] => readJson<Refused<MoveInput>[]>(movesRefusedKey(userId)) ?? []
export const saveMovesRefused = (userId: string, list: readonly Refused<MoveInput>[]): void =>
  list.length === 0 ? removeDurable(movesRefusedKey(userId)) : writeDurable(movesRefusedKey(userId), list)

/** Wipe everything this device knows about a user (used on sign-out). */
export function clearUserData(userId: string): void {
  try {
    localStorage.removeItem(cacheKey(userId))
    localStorage.removeItem(outboxKey(userId))
    localStorage.removeItem(settingsKey(userId))
    localStorage.removeItem(settingsOutboxKey(userId))
    localStorage.removeItem(movesKey(userId))
    localStorage.removeItem(movesOutboxKey(userId))
    localStorage.removeItem(refusedKey(userId))
    localStorage.removeItem(movesRefusedKey(userId))
    localStorage.removeItem(LAST_USER_KEY)
  } catch {
    // best effort
  }
}

const byDateThenCreated = (a: { date: string; createdAt: string; id: string }, b: { date: string; createdAt: string; id: string }): number => {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.id < b.id ? -1 : 1
}

export const sortBets = (bets: readonly Bet[]): Bet[] => [...bets].sort(byDateThenCreated)

/** How many rows a pending op will write (used for the "queued" badge). */
export const opSize = <I>(op: PendingOp<I>): number => (op.kind === 'bulk-add' ? op.entries.length : 1)

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
      // A row an earlier attempt already stored is the server's now, edited
      // since perhaps: only the rows it doesn't have yet show from the import.
      for (const { id, input } of op.entries) if (!map.has(id)) map.set(id, optimisticRow(id, input, op.queuedAt))
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
export function enqueueOp<I = BetInput>(outbox: readonly PendingOp<I>[], op: PendingOp<I>): PendingOp<I>[] {
  const forBet = (o: PendingOp<I>, id: string): boolean => o.kind !== 'bulk-add' && o.id === id
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
    // The server stored what we sent where it had no row yet, so keep those
    // local rows rather than blanking them; a row it already had (stored by an
    // earlier attempt, edited since perhaps) stays as it is there. The refresh
    // that follows a drain trues up the timestamps.
    const have = new Set(server.map((b) => b.id))
    const added = op.entries.filter(({ id }) => !have.has(id)).map(({ id, input }) => optimisticRow(id, input, op.queuedAt))
    return sortBets([...server, ...added])
  }
  if (!result) return [...server]
  const rest = server.filter((b) => b.id !== result.id)
  return sortBets([...rest, result])
}

/**
 * Deposits and withdrawals: a third cache and outbox beside the bets' and the
 * settings', replayed with the bets' queue rules (enqueueOp, drainOutbox).
 */

/**
 * A cached move as the app can use it, or null for one it can't. There is no
 * older shape to bring forward yet; this only keeps out a row that would
 * poison the bankroll: no id, a date that is no date, or an amount that is no
 * number or the 0 the database refuses.
 */
export function hydrateMove(raw: unknown): BankrollMove | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Partial<Record<keyof BankrollMove, unknown>>
  if (typeof r.id !== 'string' || typeof r.date !== 'string' || !isValidDate(r.date)) return null
  const amount = finiteOrNull(r.amount)
  if (amount === null || amount === 0) return null
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  return { id: r.id, date: r.date, amount, note: text(r.note), createdAt: text(r.createdAt), updatedAt: text(r.updatedAt) }
}

/**
 * Null when this device has never loaded the moves, which is not the same as
 * having none: until it has, the bankroll can't be known.
 */
export function loadMoveCache(userId: string): BankrollMove[] | null {
  const raw = readJson<unknown>(movesKey(userId))
  if (!Array.isArray(raw)) return null
  return raw.map(hydrateMove).filter((m): m is BankrollMove => m !== null)
}

export const saveMoveCache = (userId: string, rows: readonly BankrollMove[]): void => writeExpendable(movesKey(userId), rows)

/** The moves queue as stored. Its head may have gone out with its answer lost (see headAsSent). */
export const loadMoveOutbox = (userId: string): MoveOp[] => headAsSent(readMoveOutbox(userId))

/** The moves queue exactly as stored, for a change made under its lock. */
export const readMoveOutbox = (userId: string): MoveOp[] => readJson<MoveOp[]>(movesOutboxKey(userId)) ?? []

/** Throws StorageWriteError when the queue can't be stored. */
export const saveMoveOutbox = (userId: string, ops: readonly MoveOp[]): void => writeDurable(movesOutboxKey(userId), ops)

export const sortMoves = (rows: readonly BankrollMove[]): BankrollMove[] => [...rows].sort(byDateThenCreated)

/**
 * What the UI shows: the last-known moves with the queued changes on top, as
 * applyOutbox does for bets. An edit of a move that is not there is skipped
 * (it was deleted; sending the edit will find no row). Imports are never
 * built for moves, so a 'bulk-add' is ignored.
 */
export function applyMoveOutbox(server: readonly BankrollMove[], outbox: readonly MoveOp[]): BankrollMove[] {
  const map = new Map(server.map((m) => [m.id, m]))
  for (const op of outbox) {
    if (op.kind === 'add') {
      map.set(op.id, { id: op.id, date: op.input.date, amount: op.input.amount, note: op.input.note ?? '', createdAt: op.queuedAt, updatedAt: insertStamp(op) })
    } else if (op.kind === 'update') {
      const current = map.get(op.id)
      if (current) map.set(op.id, { ...current, date: op.input.date, amount: op.input.amount, note: op.input.note ?? '', updatedAt: op.editedAt })
    } else if (op.kind === 'delete') {
      map.delete(op.id)
    }
  }
  return sortMoves([...map.values()])
}

/**
 * Fold a synced move op into the cached server state, as reconcile does for
 * bets: a delete removes the row, an add or an edit puts the row the server
 * returned in its place, and an edit that returned none (refused by the
 * conflict check, or the row is gone) leaves the state as the server had it.
 */
export function reconcileMove(server: readonly BankrollMove[], op: MoveOp, row: BankrollMove | null): BankrollMove[] {
  if (op.kind === 'delete') return server.filter((m) => m.id !== op.id)
  if (!row) return [...server]
  return sortMoves([...server.filter((m) => m.id !== row.id), row])
}

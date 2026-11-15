/**
 * Changes the server confirmed lately, shared by every window of the app.
 *
 * A read does not wait for the sync, and a long list is read page by page: a
 * read can be answered before a change lands and come back after it. Within
 * one window, confirmedLog (drain.ts) lays the changes confirmed while the
 * read was out over what it got. But another window sends the queue too (one
 * window at a time, see useOpQueue), and a read here knows nothing of what
 * that window got confirmed: it would install a list from before the change
 * — a bet deleted there back here, one added there gone — and write that copy
 * to the cache every window shows.
 *
 * So each confirmation is also written here, numbered (`seq`), before the
 * window that got it shows it or caches it; a read notes the number it went
 * out at. Once it is in, it lays over what it got every change confirmed
 * since, in the order the server confirmed them — this window's too, each in
 * its place, from this window's own log (which has even what this one keeps
 * only as "read again"), by the tag it was recorded with — then this window's
 * changes not recorded here yet (the latest), and is installed, all under the
 * log's lock (no confirmation slips in between) — but only when the log still
 * holds every one of them:
 *  - it keeps the newest MAX_ENTRIES of the last KEEP_MS. What it lets go
 *    raises its `floor`: a read that went out below the floor can't know what
 *    it missed (more confirmations than are kept, or older than kept);
 *  - an import's chunk is too big to keep: it is kept as "read again" (null)
 *    — for the other windows; its own window has it in its own log;
 *  - a log cleared to make room, or never there, starts a new `epoch`: a read
 *    that went out under another one can't trust it;
 *  - a window that could not write here (storage full) says so to the others
 *    (`gap`, on a broadcast channel): every read out then is read again.
 * Such a read is not installed: the caller reads again (see `finish`).
 *
 * The log is changed only under its lock, with the version fence of store.ts,
 * so two windows writing at once never lose an entry or reuse a number, and
 * never half-written: a write storage refuses is not made at all.
 *
 * What is left: a confirmation whose answer has not reached its window yet
 * when a read here is installed. That window writes it here, then folds it
 * into its copy and caches that, after this read: the cache every window shows
 * ends up with it (see the hooks' storage listeners).
 */
import { queueStore, StorageWriteError, type QueueStore, type Versions } from './store'

export interface ConfirmedEntry<C> {
  seq: number
  /** When the confirmation came (this device's clock, shared by its windows). */
  at: number
  /** The window that got it. */
  win: string
  /** What changed, to lay over a read; null: too big to keep, a read that overlaps it reads again. */
  change: C | null
  /** Its tag in its window's own log (see confirmedLog): that window lays it from there, in its place. */
  local?: string
}

export interface ConfirmedLogState<C> {
  /** Names this log since it started: a read that saw another one cannot trust it. '' while there is none. */
  epoch: string
  /** The last number given. */
  seq: number
  /** Every entry up to this number has been let go. */
  floor: number
  entries: ConfirmedEntry<C>[]
}

/** Longer than a read can take: each page gives up after 30 s, and a list is a few pages. */
export const KEEP_MS = 10 * 60_000
/** At most this many entries are kept; the oldest go first. */
export const MAX_ENTRIES = 200

/** Reads in a row a refresh makes when the log can't vouch for what one got. */
export const MAX_READS = 3
/** Then what is shown stays, and it reads again after this long. */
export const REREAD_MS = 2000

/** This window, as the log names it. */
export const WINDOW_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const empty = <C>(): ConfirmedLogState<C> => ({ epoch: '', seq: 0, floor: 0, entries: [] })

/** The log's lock, by its key: `bettracker:confirmed-bets:<user>` → `bettracker:lock:confirmed-bets:<user>`. */
export const lockName = (key: string): string => (key.startsWith('bettracker:') ? `bettracker:lock:${key.slice('bettracker:'.length)}` : `${key}:lock`)

function readState<C>(key: string): ConfirmedLogState<C> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<ConfirmedLogState<C>> | null
    if (!raw || typeof raw.epoch !== 'string' || typeof raw.seq !== 'number' || typeof raw.floor !== 'number' || !Array.isArray(raw.entries)) return empty()
    return {
      epoch: raw.epoch,
      seq: raw.seq,
      floor: raw.floor,
      entries: raw.entries.filter((e) => typeof e?.seq === 'number' && typeof e.at === 'number' && typeof e.win === 'string')
    }
  } catch {
    return empty()
  }
}

/** Store the log, or throw: never half-kept. */
function writeState<C>(key: string, state: ConfirmedLogState<C>): void {
  try {
    localStorage.setItem(key, JSON.stringify(state))
  } catch (err) {
    throw new StorageWriteError(err)
  }
}

/**
 * The log with one more confirmation: numbered after the last, the old and
 * the too many let go (the floor rises past them). A log that was not there
 * starts with a new epoch.
 */
export function appendConfirmed<C>(state: ConfirmedLogState<C>, entry: Omit<ConfirmedEntry<C>, 'seq'>, newEpoch: () => string): ConfirmedLogState<C> {
  const epoch = state.epoch || newEpoch()
  const seq = state.seq + 1
  const all = [...state.entries, { ...entry, seq }]
  const kept = all.filter((e) => e.at > entry.at - KEEP_MS).slice(-MAX_ENTRIES)
  const floor = all.filter((e) => !kept.includes(e)).reduce((max, e) => Math.max(max, e.seq), state.floor)
  return { epoch, seq, floor, entries: kept }
}

/** Where a read went out: the log's epoch and last number then. */
export interface ReadStart {
  epoch: string
  seq: number
}

/**
 * What a read that went out at `start` can lay over what it got, from the log
 * as it is now: every entry since, in the order the changes were confirmed
 * (this window's own included: it lays those from its own log, see finish);
 * or null when the log cannot vouch for them all (it started over, let some
 * go, or keeps one of another window's only as "read again").
 */
export function changesSince<C>(state: ConfirmedLogState<C>, start: ReadStart, win: string): ConfirmedEntry<C>[] | null {
  if (state.epoch !== start.epoch) return null
  if (state.floor > start.seq) return null
  const since = state.entries.filter((e) => e.seq > start.seq).sort((a, b) => a.seq - b.seq)
  if (since.some((e) => e.win !== win && e.change === null)) return null
  return since
}

/** A read out (see SharedLog.begin). */
export interface SharedRead<C> {
  /**
   * The read is in: under the log's lock, lay over `rows` every change
   * confirmed since, in order — this window's from `local` (its own log since
   * the read went out, by tag: it has what this log keeps only as "read
   * again") — then this window's not recorded here yet, and `install` the
   * result. Resolves false, installing nothing, when the log cannot vouch for
   * them: the caller reads again.
   */
  finish: <T>(
    rows: T[],
    apply: (rows: readonly T[], change: C) => T[],
    install: (rows: T[]) => void,
    local?: () => readonly { tag: string; change: (rows: readonly T[]) => T[] }[]
  ) => Promise<boolean>
  /** The read failed: forget it. */
  cancel: () => void
}

export interface SharedLog<C> {
  /**
   * A change the server confirmed in this window (null: too big to keep),
   * with its tag in this window's own log (see confirmedLog). Awaited before
   * the window shows or caches it. Resolves with whether the log holds it;
   * when it does not, the other windows heard of the gap.
   */
  record: (change: C | null, local?: string) => Promise<boolean>
  /** A read going out. */
  begin: () => Promise<SharedRead<C>>
  /** Called when another window could not record a change (a read made before may miss it). Returns a way to stop. */
  onGap: (fn: () => void) => () => void
  /** Stop listening to other windows (an account changed). */
  close: () => void
}

type Channel = Pick<BroadcastChannel, 'postMessage' | 'close'> & { onmessage: ((e: MessageEvent) => void) | null }

export interface SharedLogOptions {
  now?: () => number
  win?: string
  /** Where the store's versions are kept (see store.ts); IndexedDB unless a test says otherwise. */
  versions?: () => Promise<Versions | null>
  /** A broadcast channel; the real one unless a test says otherwise (null: none). */
  channel?: ((name: string) => Channel) | null
  /**
   * Whether this device may still keep this user's data (false once signed
   * out: see offline.writable). When not, nothing is written: a late answer
   * would leave a copy of a row behind the sign-out.
   */
  canWrite?: () => boolean
}

export function sharedLog<C>(key: string, opts: SharedLogOptions = {}): SharedLog<C> {
  const now = opts.now ?? Date.now
  const win = opts.win ?? WINDOW_ID
  const canWrite = opts.canWrite ?? (() => true)
  const store: QueueStore<ConfirmedLogState<C>> = queueStore<ConfirmedLogState<C>>({
    // Outside the log's own key space: clearing caches to make room (see
    // evictExpendable) takes the log, never its lock's version, which would
    // make every holder wait for a version that is not coming (store.ts).
    lock: lockName(key),
    load: () => readState<C>(key),
    save: (state) => writeState(key, state),
    ...(opts.versions ? { versions: opts.versions } : {})
  })
  // The reads out now, each marked when a window failed to record a change meanwhile.
  const out = new Set<{ tainted: boolean }>()
  const listeners = new Set<() => void>()
  const taint = (): void => {
    for (const r of out) r.tainted = true
  }
  const makeChannel = opts.channel === undefined ? (typeof BroadcastChannel !== 'undefined' ? (name: string): Channel => new BroadcastChannel(name) : null) : opts.channel
  let channel: Channel | null = null
  // Opened when first needed, and again after close(): a component that runs
  // its effects twice (React's StrictMode) closes and goes on using the log.
  const open = (): Channel | null => {
    if (channel || !makeChannel) return channel
    try {
      channel = makeChannel(`${key}:gaps`)
    } catch {
      return null
    }
    channel.onmessage = (e: MessageEvent) => {
      const data = e.data as { gap?: string } | null
      if (!data || typeof data.gap !== 'string' || data.gap === win) return
      taint()
      for (const fn of listeners) fn()
    }
    return channel
  }
  open()
  let epochs = 0
  const newEpoch = (): string => `${win}-${now().toString(36)}-${(epochs++).toString(36)}`
  return {
    async record(change, local) {
      // Signed out: nothing kept, and nobody to tell (the other windows sign out too).
      if (!canWrite()) return false
      const at = now()
      const r = await store.update((state) => appendConfirmed(state, { at, win, change, ...(local !== undefined ? { local } : {}) }, newEpoch), { hold: false })
      if (!r.saved) {
        // Not kept: a read out anywhere may be missing this change.
        taint()
        try {
          open()?.postMessage({ gap: win })
        } catch {
          // No channel: another window's read may show the old list until its next read.
        }
      }
      return r.saved
    },
    async begin() {
      const mark = { tainted: false }
      out.add(mark)
      let state = await store.fresh()
      // A log that is not there yet starts now, so a later one (cleared to
      // make room, then started again) can't pass for it.
      if (!state.epoch && canWrite()) state = (await store.update((s) => (s.epoch ? s : { ...s, epoch: newEpoch() }), { hold: false })).value
      const start: ReadStart = { epoch: state.epoch, seq: state.seq }
      return {
        async finish(rows, apply, install, local) {
          try {
            return await store.within((current) => {
              if (mark.tainted) return false
              const entries = changesSince(current, start, win)
              if (entries === null) return false
              // This window's own changes since the read went out, by tag, in order.
              const mine = new Map((local?.() ?? []).map((l) => [l.tag, l.change]))
              let acc = rows
              for (const e of entries) {
                const own = e.win === win && e.local !== undefined ? mine.get(e.local) : undefined
                if (own) {
                  acc = own(acc)
                  mine.delete(e.local as string)
                } else if (e.change !== null) acc = apply(acc, e.change)
                // One of this window's own "read again" that its own log does not have for this read.
                else return false
              }
              // Confirmed here but not recorded yet (waiting for this lock): the latest, last.
              for (const change of mine.values()) acc = change(acc)
              install(acc)
              return true
            })
          } finally {
            out.delete(mark)
          }
        },
        cancel() {
          out.delete(mark)
        }
      }
    },
    onGap(fn) {
      listeners.add(fn)
      open()
      return () => void listeners.delete(fn)
    },
    close() {
      listeners.clear()
      out.clear()
      try {
        channel?.close()
      } catch {
        // already closed
      }
      channel = null
    }
  }
}

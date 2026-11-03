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
 * So each confirmation is also written here, as data, with the time it came;
 * a read notes the time it went out, and lays over what it got every change
 * another window had confirmed since. Entries older than any read can be are
 * dropped. Storage full: nothing is kept, and a read in another window may
 * show the old list until the next one, as before.
 */
import { writeExpendable } from './store'

export interface ConfirmedEntry<C> {
  /** When the confirmation came (this device's clock, shared by its windows). */
  at: number
  /** The window that got it. */
  win: string
  change: C
}

/** Longer than a read can take: each page gives up after 30 s, and a list is a few pages. */
const KEEP_MS = 10 * 60_000
/** At most this many entries are kept; the oldest go first. */
const MAX_ENTRIES = 200

/** This window, as the log names it. */
export const WINDOW_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

function readEntries<C>(key: string): ConfirmedEntry<C>[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    return Array.isArray(raw) ? (raw as ConfirmedEntry<C>[]).filter((e) => typeof e?.at === 'number' && typeof e.win === 'string') : []
  } catch {
    return []
  }
}

export interface SharedLog<C> {
  /** A change the server confirmed in this window. */
  record: (change: C) => void
  /** A read going out: once it is in, `over` lays on it what other windows confirmed since. */
  read: () => { over: <T>(rows: T[], apply: (rows: readonly T[], change: C) => T[]) => T[] }
}

export function sharedLog<C>(key: string, now: () => number = Date.now, win: string = WINDOW_ID): SharedLog<C> {
  return {
    record(change) {
      const at = now()
      const kept = readEntries<C>(key).filter((e) => e.at > at - KEEP_MS)
      writeExpendable(key, [...kept, { at, win, change }].slice(-MAX_ENTRIES))
    },
    read() {
      const since = now()
      return {
        over: (rows, apply) =>
          readEntries<C>(key)
            .filter((e) => e.win !== win && e.at >= since)
            .sort((a, b) => a.at - b.at)
            .reduce((acc, e) => apply(acc, e.change), rows)
      }
    }
  }
}

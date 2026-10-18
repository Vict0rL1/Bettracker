/**
 * This device's storage, shared by every window of the app.
 *
 * Two tabs, or a tab and the installed app, read and write the same
 * localStorage. The queues of changes waiting to sync live there, and a
 * window that wrote back the queue it read at startup would wipe whatever
 * another window queued since. So a queue only changes by read-modify-write
 * under a lock that spans windows (the Web Locks API), and only one window
 * sends a queue at a time (see the hooks' drain locks). Where the API is
 * missing — a page served over plain http on the local network is not a
 * secure context — the lock spans this window alone, which is what the app
 * had before.
 *
 * The lock alone is not enough: localStorage is not coherent across the
 * browser's processes. Each window reads its own copy, which another window's
 * write reaches a moment later, so the window that gets the lock next may
 * still read the queue as it was before the last holder's write, and write
 * that back. So every write under a lock also counts up a version, kept next
 * to the queue and in IndexedDB, which every window reads as it is now; the
 * next holder waits until its own copy has caught up with that version before
 * it reads (underLock). Without IndexedDB it reads at once, as before.
 *
 * What is stored is of two kinds. A cache of server rows can be fetched
 * again, so failing to store one is fine (writeExpendable). A queue holds
 * changes that exist nowhere else, so failing to store one is an error the
 * user must hear about (writeDurable, StorageWriteError), after the caches
 * have made room for it.
 */

const chains = new Map<string, Promise<unknown>>()

/** Run `fn` holding the lock `name`: one holder at a time across windows, in the order asked. */
export function withLock<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (locks && typeof locks.request === 'function') return locks.request(name, () => fn()) as Promise<T>
  const run = (chains.get(name) ?? Promise.resolve()).then(fn, fn)
  chains.set(
    name,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  return run
}

/** The last version written under each lock, as every window sees it now. */
export interface Versions {
  get(lock: string): Promise<number>
  set(lock: string, version: number): Promise<void>
}

let indexed: Promise<Versions | null> | undefined

/** How long IndexedDB gets to answer before it is done without (some browsers' hang). */
const OPEN_MS = 3000
const REQUEST_MS = 1000

/** Resolves with what `ask` gives, or with `fallback` once `ms` have gone by without an answer. */
function answer<T>(ms: number, fallback: T, ask: (done: (value: T) => void) => void): Promise<T> {
  return new Promise((resolve) => {
    const late = setTimeout(() => resolve(fallback), ms)
    const done = (value: T): void => {
      clearTimeout(late)
      resolve(value)
    }
    try {
      ask(done)
    } catch {
      done(fallback)
    }
  })
}

/** The versions in IndexedDB; null where it can't be opened (then nothing waits). */
function indexedVersions(): Promise<Versions | null> {
  // An open that never answers leaves this page without versions, as without IndexedDB.
  indexed ??= answer<Versions | null>(OPEN_MS, null, (done) => {
    const open = indexedDB.open('bettracker-locks', 1)
    const failed = (): void => {
      indexed = undefined
      done(null)
    }
    open.onupgradeneeded = () => open.result.createObjectStore('versions')
    open.onerror = failed
    open.onblocked = failed
    open.onsuccess = () => {
      const db = open.result
      // Closed by the browser, or wanted by a newer version of the app: open it again next time.
      db.onclose = () => (indexed = undefined)
      db.onversionchange = () => {
        db.close()
        indexed = undefined
      }
      done({
        get: (lock) =>
          answer(REQUEST_MS, 0, (got) => {
            const req = db.transaction('versions', 'readonly').objectStore('versions').get(lock)
            req.onsuccess = () => got(typeof req.result === 'number' ? req.result : 0)
            req.onerror = () => got(0)
          }),
        set: (lock, version) =>
          answer<void>(REQUEST_MS, undefined, (stored) => {
            const tx = db.transaction('versions', 'readwrite', { durability: 'relaxed' })
            tx.objectStore('versions').put(version, lock)
            tx.oncomplete = () => stored()
            tx.onerror = () => stored()
            tx.onabort = () => stored()
          })
      })
    }
  })
  return indexed
}

/** How long a holder waits for a version that may never come (storage cleared by hand). */
const CATCH_UP_MS = 2000

const versionKey = (lock: string): string => `${lock}:version`

function storedVersion(key: string): number {
  try {
    const n = Number(localStorage.getItem(key))
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/** Resolves once this window's copy of localStorage holds `version` under `key`, or after CATCH_UP_MS. */
function caughtUp(key: string, version: number): Promise<void> {
  if (storedVersion(key) >= version) return Promise.resolve()
  const win = typeof window !== 'undefined' ? window : undefined
  return new Promise((resolve) => {
    const until = Date.now() + CATCH_UP_MS
    const check = (): void => {
      if (storedVersion(key) < version && Date.now() < until) return
      clearInterval(poll)
      win?.removeEventListener('storage', check)
      resolve()
    }
    // The storage event says when the write arrives; the poll covers the rest.
    const poll = setInterval(check, 25)
    win?.addEventListener('storage', check)
  })
}

/**
 * Hold `lock`, with this window's copy of storage caught up on every write
 * made under it (see above). `fn` calls `wrote` after it stores something: it
 * counts the version up, here and in IndexedDB, before the lock goes.
 */
async function underLock<T>(lock: string, versions: () => Promise<Versions | null>, fn: (wrote: () => Promise<void>) => T | Promise<T>): Promise<T> {
  return withLock(lock, async () => {
    const shared = await versions()
    const key = versionKey(lock)
    const latest = shared ? await shared.get(lock) : 0
    await caughtUp(key, latest)
    return fn(async () => {
      const next = Math.max(latest, storedVersion(key)) + 1
      try {
        localStorage.setItem(key, String(next))
      } catch {
        // Not even room for this: the next holder reads at once, as before.
        return
      }
      await shared?.set(lock, next)
    })
  })
}

/** A change could not be stored on this device: storage is full, or turned off. */
export class StorageWriteError extends Error {
  constructor(readonly reason: unknown) {
    super('This device could not store the change (its storage is full or turned off)')
    this.name = 'StorageWriteError'
  }
}

/** What the server holds anyway: the cached bets, deposits and withdrawals, and settings. Never a queue. */
const EXPENDABLE = /^bettracker:(?:cache|moves|settings):/

/** Store something that can be fetched again. Failing to is fine. */
export function writeExpendable(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or unavailable: it comes back from the server.
  }
}

/** Drop every cached copy of server data, to make room for what can't be fetched again. */
export function evictExpendable(): number {
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && EXPENDABLE.test(k)) keys.push(k)
    }
    for (const k of keys) localStorage.removeItem(k)
    return keys.length
  } catch {
    return 0
  }
}

/**
 * Store something that exists nowhere else. When storage is full the cached
 * server data goes first and it is tried once more; StorageWriteError when
 * it still can't be stored.
 */
export function writeDurable(key: string, value: unknown): void {
  const json = JSON.stringify(value)
  try {
    localStorage.setItem(key, json)
    return
  } catch (first) {
    if (evictExpendable() === 0) throw new StorageWriteError(first)
  }
  try {
    localStorage.setItem(key, json)
  } catch (second) {
    throw new StorageWriteError(second)
  }
}

/** Remove something durable: an emptied queue. */
export function removeDurable(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch (err) {
    throw new StorageWriteError(err)
  }
}

/**
 * A queue kept in storage and changed only under its lock.
 *
 * When storage refuses it, this window holds the queue itself (`held`): its
 * changes still show and still sync while the window is open, and every
 * change tries storage again. Meanwhile other windows may store changes of
 * their own, so what is held is the list of changes made here since: each
 * try replays them, in order, on the queue as stored then. What other windows
 * stored is kept, and what this window took out (an op it sent, a bet it
 * deleted) stays out. A change must therefore give the same answer when it
 * is replayed: it finds what it changes by id, and decides once what to take.
 */
export interface QueueStore<T> {
  /** The queue as this window knows it: as stored, or as held here while storage refuses it. */
  read(): T
  /** The same, read under the lock: every change any window stored before is in it. */
  fresh(): Promise<T>
  /**
   * Change the queue: `fn` gets it as it is now, other windows' changes
   * included, and nothing else changes it until it is stored. Resolves with
   * the queue and whether storage now holds it.
   */
  update(fn: (current: T) => T): Promise<{ value: T; saved: boolean }>
  /** True while storage refuses this window's queue. */
  readonly held: boolean
}

export function queueStore<T>(opts: {
  lock: string
  load: () => T
  /** Throws StorageWriteError when it can't. */
  save: (value: T) => void
  /** Where the versions are kept (see underLock); IndexedDB unless a test says otherwise. */
  versions?: () => Promise<Versions | null>
}): QueueStore<T> {
  const versions = opts.versions ?? indexedVersions
  let held: { changes: ((current: T) => T)[]; value: T } | null = null
  return {
    get held() {
      return held !== null
    },
    read: () => (held ? held.value : opts.load()),
    fresh: () => underLock(opts.lock, versions, () => (held ? held.value : opts.load())),
    update: (fn) =>
      underLock(opts.lock, versions, async (wrote) => {
        const changes = [...(held?.changes ?? []), fn]
        const value = changes.reduce((current, change) => change(current), opts.load())
        try {
          opts.save(value)
        } catch (err) {
          if (!(err instanceof StorageWriteError)) throw err
          held = { changes, value }
          return { value, saved: false }
        }
        held = null
        await wrote()
        return { value, saved: true }
      })
  }
}

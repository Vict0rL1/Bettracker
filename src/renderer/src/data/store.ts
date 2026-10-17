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
 * their own; the first write that succeeds again keeps them, behind this
 * window's (`recover`).
 */
export interface QueueStore<T> {
  /** The queue as this window knows it: as stored, or as held here while storage refuses it. */
  read(): T
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
  /** The queue to store once storage takes it again: this window's, then what other windows stored meanwhile. */
  recover: (stored: T, mine: T) => T
}): QueueStore<T> {
  let held: { value: T } | null = null
  return {
    get held() {
      return held !== null
    },
    read: () => (held ? held.value : opts.load()),
    update: (fn) =>
      withLock(opts.lock, () => {
        const next = fn(held ? held.value : opts.load())
        const value = held ? opts.recover(opts.load(), next) : next
        try {
          opts.save(value)
          held = null
          return { value, saved: true }
        } catch (err) {
          if (!(err instanceof StorageWriteError)) throw err
          held = { value: next }
          return { value: next, saved: false }
        }
      })
  }
}

/** For queues of ops: this window's ops, then the ones only storage has. */
export function recoverOps<T extends { opId: string }>(stored: readonly T[], mine: readonly T[]): T[] {
  const ids = new Set(mine.map((o) => o.opId))
  return [...mine, ...stored.filter((o) => !ids.has(o.opId))]
}

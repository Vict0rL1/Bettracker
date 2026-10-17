import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { evictExpendable, queueStore, recoverOps, StorageWriteError, withLock, writeDurable, writeExpendable } from './store'

/**
 * Storage that fills up: setItem throws QuotaExceededError once the stored
 * text would pass `quota` characters, as a browser's does. `refuse` throws on
 * every write (storage turned off).
 */
class SmallStorage implements Storage {
  map = new Map<string, string>()
  constructor(
    public quota = Infinity,
    public refuse = false
  ) {}
  get length(): number {
    return this.map.size
  }
  private used(except?: string): number {
    let n = 0
    for (const [k, v] of this.map) if (k !== except) n += k.length + v.length
    return n
  }
  clear(): void {
    this.map.clear()
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  setItem(key: string, value: string): void {
    if (this.refuse || this.used(key) + key.length + value.length > this.quota) {
      throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })
    }
    this.map.set(key, String(value))
  }
}

const real = globalThis.localStorage
let storage: SmallStorage
beforeEach(() => {
  storage = new SmallStorage()
  globalThis.localStorage = storage
})
afterEach(() => {
  globalThis.localStorage = real
})

describe('writeExpendable / writeDurable', () => {
  it('a cache that does not fit is let go quietly', () => {
    storage.refuse = true
    expect(() => writeExpendable('bettracker:cache:u1', [1, 2, 3])).not.toThrow()
  })

  it('a queue that does not fit makes room by dropping the caches, never another queue', () => {
    storage.setItem('bettracker:cache:u1', 'x'.repeat(500))
    storage.setItem('bettracker:moves:u1', 'x'.repeat(200))
    storage.setItem('bettracker:settings:u1', '{}')
    storage.setItem('bettracker:moves-outbox:u1', '[{"opId":"m"}]')
    storage.setItem('bettracker:settings-outbox:u1', '{"patch":{}}')
    storage.setItem('bettracker:refused:u1', '[]')
    storage.quota = storage.map.size * 60 + 400
    writeDurable('bettracker:outbox:u1', [{ opId: 'a', note: 'y'.repeat(300) }])
    expect(storage.getItem('bettracker:outbox:u1')).toContain('"opId":"a"')
    expect(storage.getItem('bettracker:cache:u1')).toBeNull()
    expect(storage.getItem('bettracker:moves:u1')).toBeNull()
    for (const k of ['bettracker:moves-outbox:u1', 'bettracker:settings-outbox:u1', 'bettracker:refused:u1']) expect(storage.getItem(k), k).not.toBeNull()
  })

  // It used to be swallowed: the change looked stored and was only in memory.
  it('says so when even that is not enough', () => {
    storage.refuse = true
    expect(() => writeDurable('bettracker:outbox:u1', [{ opId: 'a' }])).toThrow(StorageWriteError)
  })

  it('evicts only what can be fetched again', () => {
    storage.setItem('bettracker:cache:u1', '[]')
    storage.setItem('bettracker:outbox:u1', '[]')
    storage.setItem('bettracker:theme', 'dark')
    expect(evictExpendable()).toBe(1)
    expect([...storage.map.keys()].sort()).toEqual(['bettracker:outbox:u1', 'bettracker:theme'])
  })
})

describe('withLock', () => {
  it('runs one holder at a time, in the order asked (the in-window fallback)', async () => {
    const order: string[] = []
    const slow = withLock('q', async () => {
      order.push('a:start')
      await new Promise((r) => setTimeout(r, 10))
      order.push('a:end')
    })
    const fast = withLock('q', () => void order.push('b'))
    await Promise.all([slow, fast])
    expect(order).toEqual(['a:start', 'a:end', 'b'])
  })

  it('goes on after a holder that failed', async () => {
    await expect(withLock('q2', () => Promise.reject(new Error('no')))).rejects.toThrow('no')
    await expect(withLock('q2', () => 'yes')).resolves.toBe('yes')
  })

  it('uses the Web Locks API when the browser has it', async () => {
    const request = vi.fn((_name: string, fn: () => unknown) => Promise.resolve(fn()))
    vi.stubGlobal('navigator', { locks: { request } })
    try {
      expect(await withLock('q3', () => 42)).toBe(42)
      expect(request).toHaveBeenCalledWith('q3', expect.any(Function))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('queueStore', () => {
  type Op = { opId: string }
  const make = () =>
    queueStore<Op[]>({
      lock: 'test-queue',
      load: () => JSON.parse(localStorage.getItem('q') ?? '[]') as Op[],
      save: (q) => writeDurable('q', q),
      recover: recoverOps
    })

  // Two windows each kept their own copy and wrote it back whole: the last
  // write wiped the other's change.
  it('changes the queue as stored now: another window’s change is kept', async () => {
    const mine = make()
    const theirs = make()
    await mine.update((q) => [...q, { opId: 'a' }])
    await theirs.update((q) => [...q, { opId: 'b' }])
    await mine.update((q) => [...q, { opId: 'c' }])
    expect(mine.read().map((o) => o.opId)).toEqual(['a', 'b', 'c'])
  })

  it('two windows changing it at once both get in', async () => {
    const a = make()
    const b = make()
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).update((q) => [...q, { opId: String(i) }])))
    expect(a.read().map((o) => o.opId).sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])
  })

  it('holds the queue in this window when storage refuses it, and says so', async () => {
    const q = make()
    await q.update((x) => [...x, { opId: 'a' }])
    storage.refuse = true
    const r = await q.update((x) => [...x, { opId: 'b' }])
    expect(r).toEqual({ value: [{ opId: 'a' }, { opId: 'b' }], saved: false })
    expect(q.held).toBe(true)
    expect(q.read().map((o) => o.opId)).toEqual(['a', 'b'])
    // A change while held stays held, and changes go on.
    await q.update((x) => x.filter((o) => o.opId !== 'a'))
    expect(q.read().map((o) => o.opId)).toEqual(['b'])
  })

  it('stores what it held once storage takes it again, with what other windows stored meanwhile', async () => {
    const q = make()
    storage.refuse = true
    await q.update((x) => [...x, { opId: 'mine' }])
    storage.refuse = false
    storage.setItem('q', JSON.stringify([{ opId: 'theirs' }]))
    const r = await q.update((x) => x)
    expect(r.saved).toBe(true)
    expect(q.held).toBe(false)
    expect(JSON.parse(storage.getItem('q') ?? '[]')).toEqual([{ opId: 'mine' }, { opId: 'theirs' }])
  })
})

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { drainOutbox, type DrainHooks, type DrainResult } from './drain'
import { enqueueOp, headAsSent, requeueRefused, type PendingOp, type Refused } from './offline'
import { queueStore, withLock } from './store'

export interface OpQueueOptions<I> {
  userId: string | null
  /** Names the locks: 'bets' or 'moves'. */
  name: string
  /** The storage keys other windows change, watched to stay in step with them. */
  keys: (userId: string) => { queue: string; refused: string }
  read: (userId: string) => PendingOp<I>[]
  save: (userId: string, queue: readonly PendingOp<I>[]) => void
  readRefused: (userId: string) => Refused<I>[]
  saveRefused: (userId: string, list: readonly Refused<I>[]) => void
  /** The server refused a change for good; it is kept in `refused`. */
  onRefused: (err: unknown) => void
  newId: () => string
}

export interface OpQueue<I> {
  /** The queue as this window knows it (see store.ts), for rendering. */
  outbox: PendingOp<I>[]
  outboxRef: { readonly current: PendingOp<I>[] }
  /** Storage refused the queue: it is only in this window until it syncs or storage takes it. */
  held: boolean
  /** Changes the server refused for good, kept to send again or let go. */
  refused: Refused<I>[]
  /** Storage refused that list: it is only in this window until storage takes it. */
  refusedHeld: boolean
  /** Queue ops (see enqueueOp). Resolves with whether storage holds them. */
  enqueue: (ops: readonly PendingOp<I>[]) => Promise<boolean>
  /** Send the queue, holding the lock that lets one window at a time do it. Null with no user. */
  drain: <R>(hooks: Pick<DrainHooks<I, R>, 'send' | 'applied'>) => Promise<DrainResult | null>
  /** Put the refused changes back in the queue, to be sent again. */
  retryRefused: () => Promise<boolean>
  /** Let the refused changes go. */
  discardRefused: () => Promise<void>
  /** Try storage again for a held queue and refused list (after room was made). */
  saveAgain: () => Promise<boolean>
}

const sameRefused = <I>(a: Refused<I>, b: Refused<I>): boolean => a.at === b.at && a.ops[0]?.opId === b.ops[0]?.opId

/** Takes these entries off the refused list, by identity: replayed later (see store.ts), it takes no others. */
const without =
  <I>(entries: readonly Refused<I>[]) =>
  (list: Refused<I>[]): Refused<I>[] =>
    list.filter((r) => !entries.some((e) => sameRefused(e, r)))

/**
 * A queue of ops (the bets', or the deposits and withdrawals') kept in
 * storage and shared by every window of the app:
 *  - it changes only by read-modify-write under a lock that spans windows,
 *    so a window never writes back a stale copy over another's changes;
 *  - one window at a time sends it, under a second lock, reading it from
 *    storage before every op;
 *  - a change made in another window shows here through the storage event;
 *  - when storage refuses it, this window holds it (`held`) and says so;
 *  - changes the server refuses for good are kept apart (`refused`).
 */
export function useOpQueue<I>(o: OpQueueOptions<I>): OpQueue<I> {
  const { userId, name } = o
  const optsRef = useRef(o)
  optsRef.current = o
  const [outbox, setOutboxState] = useState<PendingOp<I>[]>([])
  const [held, setHeld] = useState(false)
  const [refused, setRefusedState] = useState<Refused<I>[]>([])
  const [refusedHeld, setRefusedHeld] = useState(false)
  const outboxRef = useRef<PendingOp<I>[]>([])
  // The user this render is for: a drain of an earlier one may still end, and
  // its queue must not show as this user's (see useBetSync).
  const userRef = useRef(userId)
  userRef.current = userId

  // The callbacks in `o` are module functions: the stores depend on the user alone.
  const stores = useMemo(() => {
    if (!userId) return null
    const opts = optsRef.current
    return {
      queue: queueStore<PendingOp<I>[]>({
        lock: `bettracker:queue:${name}:${userId}`,
        load: () => opts.read(userId),
        save: (q) => opts.save(userId, q)
      }),
      refused: queueStore<Refused<I>[]>({
        lock: `bettracker:refused:${name}:${userId}`,
        load: () => opts.readRefused(userId),
        save: (list) => opts.saveRefused(userId, list)
      })
    }
  }, [userId, name])

  const mirror = useCallback(
    (q: PendingOp<I>[]) => {
      if (userRef.current !== userId) return
      outboxRef.current = q
      setOutboxState(q)
      setHeld(stores?.queue.held ?? false)
    },
    [userId, stores]
  )
  const showRefused = useCallback(
    (list: Refused<I>[]) => {
      if (userRef.current !== userId) return
      setRefusedState(list)
      setRefusedHeld(stores?.refused.held ?? false)
    },
    [userId, stores]
  )

  // Boot: the stored queue at once, for instant paint. Its head may have gone
  // out with its answer lost (see headAsSent); storage says so too, so no
  // window folds an edit into it.
  useEffect(() => {
    outboxRef.current = []
    setOutboxState([])
    setHeld(false)
    setRefusedState([])
    setRefusedHeld(false)
    if (!userId || !stores) return
    const stored = optsRef.current.read(userId)
    const boot = headAsSent(stored)
    outboxRef.current = boot
    setOutboxState(boot)
    setRefusedState(optsRef.current.readRefused(userId))
    if (stored.length > 0 && !stored[0].sent) void stores.queue.update((q) => headAsSent(q)).then((r) => mirror(r.value))
  }, [userId, stores, mirror])

  // Another window changed the queue, or the refused list.
  useEffect(() => {
    if (!userId || !stores) return
    const keys = optsRef.current.keys(userId)
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== null && e.key !== keys.queue && e.key !== keys.refused) return
      if (!stores.queue.held) mirror(stores.queue.read())
      if (!stores.refused.held) setRefusedState(stores.refused.read())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [userId, stores, mirror])

  const update = useCallback(
    async (fn: (q: PendingOp<I>[]) => PendingOp<I>[]) => {
      if (!stores) return { value: outboxRef.current, saved: false }
      const r = await stores.queue.update(fn)
      mirror(r.value)
      return r
    },
    [stores, mirror]
  )

  const enqueue = useCallback(
    async (ops: readonly PendingOp<I>[]): Promise<boolean> => {
      if (ops.length === 0) return true
      return (await update((q) => ops.reduce((acc, op) => enqueueOp<I>(acc, op), q))).saved
    },
    [update]
  )

  const drain = useCallback(
    async <R>(hooks: Pick<DrainHooks<I, R>, 'send' | 'applied'>): Promise<DrainResult | null> => {
      if (!userId || !stores) return null
      return withLock(`bettracker:drain:${name}:${userId}`, () =>
        drainOutbox<I, R>({
          outbox: () => stores.queue.fresh(),
          update: async (fn) => (await update(fn)).value,
          send: hooks.send,
          applied: hooks.applied,
          rejected: async (ops, err) => {
            const entry: Refused<I> = { ops, reason: err instanceof Error ? err.message : String(err), at: new Date().toISOString() }
            const r = await stores.refused.update((list) => [...list, entry])
            showRefused(r.value)
            if (userRef.current === userId) optsRef.current.onRefused(err)
          }
        })
      )
    },
    [userId, name, stores, update, showRefused]
  )

  const retryRefused = useCallback(async (): Promise<boolean> => {
    if (!stores) return false
    // Queued first, then taken off the list: a window closed in between
    // leaves them in both (sent twice at worst), never in neither. As new
    // changes, with ids given once here (the queue change may be replayed,
    // see store.ts), never over what was queued since (see requeueRefused).
    const entries = await stores.refused.fresh()
    const stories = entries.map((x) => x.ops.map((op) => ({ ...op, opId: optsRef.current.newId(), sent: undefined }) as PendingOp<I>))
    const saved = stories.length === 0 || (await update((q) => requeueRefused<I>(q, stories))).saved
    const r = await stores.refused.update(without(entries))
    showRefused(r.value)
    return saved
  }, [stores, update, showRefused])

  const discardRefused = useCallback(async (): Promise<void> => {
    if (!stores) return
    const r = await stores.refused.update(without(await stores.refused.fresh()))
    showRefused(r.value)
  }, [stores, showRefused])

  const saveAgain = useCallback(async (): Promise<boolean> => {
    const saved = (await update((q) => q)).saved
    if (!stores?.refused.held) return saved
    const r = await stores.refused.update((list) => list)
    showRefused(r.value)
    return saved && r.saved
  }, [update, stores, showRefused])

  return { outbox, outboxRef, held, refused, refusedHeld, enqueue, drain, retryRefused, discardRefused, saveAgain }
}

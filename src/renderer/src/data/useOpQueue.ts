import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { drainOutbox, type DrainHooks, type DrainResult } from './drain'
import { enqueueOp, headAsSent, keepRefused, markHeadSent, requeueRefused, type PendingOp, type Refused } from './offline'
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

/** Refused entries sent again while the queue was only in this window, and what of theirs is queued: their bets, and their imports by op. */
interface Resent<I> {
  entries: Refused<I>[]
  bets: Set<string>
  imports: Set<string>
}

const resentOf = <I>(entries: Refused<I>[], stories: readonly (readonly PendingOp<I>[])[]): Resent<I> => ({
  entries,
  bets: new Set(stories.flat().flatMap((op) => (op.kind === 'bulk-add' ? [] : [op.id]))),
  imports: new Set(stories.flat().flatMap((op) => (op.kind === 'bulk-add' ? [op.opId] : [])))
})

/** Whether the queue still holds something these entries were sent again as. */
const stillQueued = <I>(x: Resent<I>, queue: readonly PendingOp<I>[]): boolean =>
  queue.some((op) => (op.kind === 'bulk-add' ? x.imports.has(op.opId) : x.bets.has(op.id)))

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
  // Refused entries sent again while storage refused the queue: what they were
  // sent again as is only in this window, so they stay on the stored list (not
  // shown) until the queue is stored, or until that has left it: sent, or
  // refused again into entries of its own. A window closed meanwhile loses the
  // copies, never the entries.
  const resentRef = useRef<Resent<I>[]>([])

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
      setRefusedState(list.filter((r) => !resentRef.current.some((x) => x.entries.some((e) => sameRefused(e, r)))))
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
    resentRef.current = []
    if (!userId || !stores) return
    const stored = optsRef.current.read(userId)
    const boot = headAsSent(stored)
    outboxRef.current = boot
    setOutboxState(boot)
    setRefusedState(optsRef.current.readRefused(userId))
    if (stored.length > 0 && !stored[0].sent) void stores.queue.update(markHeadSent<PendingOp<I>>()).then((r) => mirror(r.value))
  }, [userId, stores, mirror])

  // Another window changed the queue, or the refused list.
  useEffect(() => {
    if (!userId || !stores) return
    const keys = optsRef.current.keys(userId)
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== null && e.key !== keys.queue && e.key !== keys.refused) return
      if (!stores.queue.held) mirror(stores.queue.read())
      if (!stores.refused.held) showRefused(stores.refused.read())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [userId, stores, mirror, showRefused])

  const update = useCallback(
    async (fn: (q: PendingOp<I>[]) => PendingOp<I>[]) => {
      if (!stores) return { value: outboxRef.current, saved: false }
      const r = await stores.queue.update(fn)
      mirror(r.value)
      // Entries sent again from this window alone (see resentRef) leave the list once that is safe.
      const settled = resentRef.current.filter((x) => r.saved || !stillQueued(x, r.value))
      if (settled.length > 0) {
        resentRef.current = resentRef.current.filter((x) => !settled.includes(x))
        showRefused((await stores.refused.update(without(settled.flatMap((x) => x.entries)))).value)
      }
      return r
    },
    [stores, mirror, showRefused]
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
          rejected: async (ops, err, revised) => {
            const reason = err instanceof Error ? err.message : String(err)
            const at = new Date().toISOString()
            const r = await stores.refused.update((list) => keepRefused(list, ops, reason, at, revised))
            showRefused(r.value)
            if (!revised && userRef.current === userId) optsRef.current.onRefused(err)
          }
        })
      )
    },
    [userId, name, stores, update, showRefused]
  )

  /** The stored refused list, but for the entries this window has sent again (see resentRef). */
  const shownRefused = useCallback(async (): Promise<Refused<I>[]> => {
    if (!stores) return []
    return (await stores.refused.fresh()).filter((r) => !resentRef.current.some((x) => x.entries.some((e) => sameRefused(e, r))))
  }, [stores])

  const retryRefused = useCallback(async (): Promise<boolean> => {
    if (!stores) return false
    // Queued first, then taken off the list: a window closed in between
    // leaves them in both (sent twice at worst), never in neither. As new
    // changes, with ids given once here (the queue change may be replayed,
    // see store.ts), never over what was queued since (see requeueRefused).
    const entries = await shownRefused()
    if (entries.length === 0) return true
    const stories = entries.map((x) => x.ops.map((op) => ({ ...op, opId: optsRef.current.newId(), sent: undefined, sentBy: undefined }) as PendingOp<I>))
    const r = await update((q) => requeueRefused<I>(q, stories))
    const resent = resentOf(entries, stories)
    if (!r.saved && stillQueued(resent, r.value)) {
      // Queued only in this window (storage full): off the notice, but kept
      // on the stored list until that is safe (see resentRef).
      resentRef.current = [...resentRef.current, resent]
      showRefused(stores.refused.read())
      return false
    }
    showRefused((await stores.refused.update(without(entries))).value)
    return true
  }, [stores, update, showRefused, shownRefused])

  const discardRefused = useCallback(async (): Promise<void> => {
    if (!stores) return
    // Only what the notice shows: what was sent again is on its way.
    const r = await stores.refused.update(without(await shownRefused()))
    showRefused(r.value)
  }, [stores, showRefused, shownRefused])

  const saveAgain = useCallback(async (): Promise<boolean> => {
    const saved = (await update((q) => q)).saved
    if (!stores?.refused.held) return saved
    const r = await stores.refused.update((list) => list)
    showRefused(r.value)
    return saved && r.saved
  }, [update, stores, showRefused])

  return { outbox, outboxRef, held, refused, refusedHeld, enqueue, drain, retryRefused, discardRefused, saveAgain }
}

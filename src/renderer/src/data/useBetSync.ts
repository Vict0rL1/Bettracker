import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Bet, BetInput } from '../../../shared/types'
import { newId } from '../lib/uuid'
import { normalizeInput } from '../lib/validate'
import { getBets, sendOp, subscribeToBets } from './bets'
import { sharedLog } from './confirmed'
import { backoff, confirmedLog, foldApplied, migrationNotice, retryPlan, syncStatus, type DrainResult, type SyncStatus } from './drain'
import { classifySyncError, SignedOutError } from './errors'
import type { BatchEvent } from './imports'
import {
  applyOutbox,
  confirmedKey,
  insertStamp,
  landImport,
  loadCache,
  loadRefused,
  opSize,
  queueKeys,
  readdStamp,
  readOutbox,
  reconcile,
  sameStamp,
  saveCache,
  saveOutbox,
  saveRefused,
  type PendingOp,
  type Refused
} from './offline'
import { queuedByBatch, refusedBatches, settledHere, useOpQueue } from './useOpQueue'

export type { SyncStatus }

export interface BetSync {
  /** Server rows with queued local changes applied; null until first load. */
  bets: Bet[] | null
  status: SyncStatus
  /** Rows waiting to reach the server (not bets awaiting settlement). */
  queuedCount: number
  isOffline: boolean
  /** Storage refused the queue: these changes are only in this window until they sync. */
  unsaved: boolean
  /** Changes the server refused for good, kept to send again or let go. */
  refused: Refused[]
  /** Storage refused the list of refused changes: they are only in this window. */
  refusedUnsaved: boolean
  /** A change the server refused found no room to be set apart: the queue waits for room (see useOpQueue). */
  refusalBlocked: boolean
  /**
   * Each change resolves once it is queued: true when this device's storage
   * holds it, false when it is only in this window (see `unsaved`).
   */
  addBet: (input: BetInput) => Promise<boolean>
  updateBet: (id: string, input: BetInput) => Promise<boolean>
  deleteBet: (id: string) => Promise<boolean>
  /**
   * Queue an imported batch as a single op. Resolves with how many rows were
   * queued, the op that carries them, the ids they were given and the stamp
   * they are written with (an import's Undo removes the rows that still carry
   * it). `ids`: the ids to give them (a backup restored keeps its own); a row
   * whose id is on the server already is left as it is there. `batch` names
   * the history entry that hears what the server made (the op's id if not
   * given); `stamp`, the time they are written with (now if not given).
   */
  importBets: (
    inputs: readonly BetInput[],
    opts?: { ids?: readonly string[]; batch?: string; stamp?: string }
  ) => Promise<{ count: number; saved: boolean; opId: string; ids: string[]; stamp: string }>
  /** Imports still on their way, by the op that carries each: how many rows have landed, of how many. */
  importing: ReadonlyMap<string, { done: number; total: number }>
  /** Several edits at once (bulk retag/settle, and Undo of either): one state update, one op per bet. */
  updateBets: (changes: readonly { id: string; input: BetInput }[]) => Promise<boolean>
  deleteBets: (ids: readonly string[]) => Promise<boolean>
  /**
   * The Undo of an import or restore: remove these rows only where they
   * still carry their stamp, the batch's (see deleteBet), and tell `batch`.
   */
  undoBets: (targets: readonly { id: string; stamp: string }[], batch: string) => Promise<boolean>
  /** Rows still waiting to reach the server, by the batch they belong to (see ImportBatch). */
  batchQueued: ReadonlyMap<string, number>
  /** Batches with a change the server refused for good. */
  batchRefused: ReadonlySet<string>
  /**
   * Undo of a delete: re-add the rows with their original ids, through the
   * outbox like everything else, stamped just after what was deleted (see
   * readdStamp) unless `stamp` says otherwise. With `batch` (an import's
   * Undo, undone) what they make is told to that batch.
   */
  restoreBets: (bets: readonly Bet[], opts?: { batch?: string; stamp?: string }) => Promise<boolean>
  retryRefused: () => Promise<boolean>
  discardRefused: () => Promise<void>
  saveAgain: () => Promise<boolean>
}

const RETRY_INTERVAL_MS = 20_000
const REALTIME_DEBOUNCE_MS = 400

/**
 * Offline-first bet state.
 *
 * The device cache renders instantly on boot; mutations apply to the UI
 * immediately and enter a persistent outbox, shared by every window of the
 * app (see useOpQueue), that is replayed against Supabase in order — on
 * enqueue, on reconnect, and on a slow retry timer. A full fetch remains the
 * reconciliation anchor after the queue drains and on realtime events from
 * other devices.
 *
 * A failed request leaves the queue as it is and the badge says why: no
 * connection ('offline'), no session or a key Supabase refuses ('paused',
 * until a sign-in), a passing server failure ('retrying', after a growing
 * wait), or a missing migration ('behind'). Only a refusal for good takes a
 * change out of the queue, into `refused`.
 *
 * `onNotice` is for things that are not errors but the user should hear; it
 * gets a code (not copy) so the app can phrase it in the user's language.
 */
export function useBetSync(
  userId: string | null,
  canSync: boolean,
  onError: (err: unknown) => void,
  onNotice?: (code: 'conflict') => void,
  onBatch?: (event: BatchEvent) => void | Promise<void>
): BetSync {
  const [server, setServerState] = useState<Bet[] | null>(null)
  // Rows the server confirmed before this device had any copy to fold them
  // into (see foldApplied): shown until the first read, never cached.
  const [landed, setLanded] = useState<Bet[]>([])
  const landedRef = useRef<Bet[]>([])
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine)
  const [behind, setBehindState] = useState(false)
  const [paused, setPausedState] = useState(false)
  const [retrying, setRetryingState] = useState(false)

  // Refs are the source of truth inside the async sync loop; state mirrors
  // them for rendering.
  const serverRef = useRef<Bet[] | null>(null)
  // Changes the server confirmed while a read was out, for that read to lay
  // over what it got (see confirmedLog).
  const confirmedRef = useRef(confirmedLog<Bet>())
  // The user whose sync is running, if any.
  const syncingRef = useRef<string | null>(null)
  // The user this render is for. A sync started for an earlier one (signed
  // out, or another account in) may still end: what it brings back is
  // dropped, never shown or stored as this user's.
  const userRef = useRef(userId)
  userRef.current = userId
  const noticeRef = useRef(migrationNotice())
  const pausedNoticeRef = useRef(migrationNotice())
  const retryNoticeRef = useRef(migrationNotice())
  const backoffRef = useRef(backoff())
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canSyncRef = useRef(canSync)
  canSyncRef.current = canSync
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const onNoticeRef = useRef(onNotice)
  onNoticeRef.current = onNotice
  const onBatchRef = useRef(onBatch)
  onBatchRef.current = onBatch
  // What the server made of a batch, into its history. Never in the way of
  // the sync: an entry that could not be written loses an Undo's detail, and
  // must not fail the op (a failed op could be taken for a refused one).
  const tell = useCallback(async (e: BatchEvent): Promise<void> => {
    try {
      await onBatchRef.current?.(e)
    } catch {
      // see above
    }
  }, [])
  // The same confirmations, for reads in this user's other windows (see confirmed.ts).
  const shared = useMemo(() => (userId ? sharedLog<{ op: PendingOp; row: Bet | null }>(confirmedKey(userId, 'bets')) : null), [userId])

  const queue = useOpQueue<BetInput>({
    userId,
    name: 'bets',
    keys: (uid) => ({ queue: queueKeys(uid).outbox, refused: queueKeys(uid).refused }),
    read: (uid) => readOutbox(uid),
    save: saveOutbox,
    readRefused: loadRefused,
    saveRefused,
    onRefused: (err) => onErrorRef.current(err),
    newId
  })
  // Each of these keeps its identity from render to render (the queue object itself does not).
  const { outbox, outboxRef, enqueue, drain, discardRefused, refusalBlocked } = queue
  const refusalBlockedRef = useRef(refusalBlocked)
  refusalBlockedRef.current = refusalBlocked
  const retryQueued = queue.retryRefused
  const saveQueued = queue.saveAgain

  const setServer = useCallback(
    (rows: Bet[]) => {
      if (userRef.current !== userId) return
      serverRef.current = rows
      setServerState(rows)
      if (userId) saveCache(userId, rows)
    },
    [userId]
  )

  // The database is missing a migration. The hint is shown once, when that is
  // first found, not on every retry or resume; an op that goes through, or a
  // queue that empties, ends the episode.
  const setBehind = useCallback((next: boolean, err?: unknown) => {
    if (next && noticeRef.current.found()) onErrorRef.current(err)
    if (!next) noticeRef.current.clear()
    setBehindState(next)
  }, [])

  // A key Supabase refuses, or a passing server failure: said once per
  // episode too. A lost session has its own notice, from the app.
  const setPaused = useCallback((next: boolean, err?: unknown) => {
    if (next && !(err instanceof SignedOutError) && pausedNoticeRef.current.found()) onErrorRef.current(err)
    if (!next) pausedNoticeRef.current.clear()
    setPausedState(next)
  }, [])
  const setRetrying = useCallback((next: boolean, err?: unknown) => {
    if (next && retryNoticeRef.current.found()) onErrorRef.current(err)
    if (!next) {
      retryNoticeRef.current.clear()
      backoffRef.current.reset()
    }
    setRetryingState(next)
  }, [])

  // A row (or rows) the server got back: into the copy when there is one,
  // else kept apart until the first read (see foldApplied).
  const fold = useCallback(
    (change: (rows: readonly Bet[]) => Bet[], told?: { op: PendingOp; row: Bet | null }) => {
      if (userRef.current !== userId) return
      confirmedRef.current.confirmed(change)
      if (told) shared?.record(told)
      const next = foldApplied(serverRef.current, landedRef.current, change)
      if (next.server !== null) setServer(next.server)
      else {
        landedRef.current = next.landed
        setLanded(next.landed)
      }
    },
    [userId, setServer, shared]
  )

  const refresh = useCallback(async (): Promise<void> => {
    if (!userId || !canSyncRef.current) return
    const read = confirmedRef.current.read()
    const elsewhere = shared?.read()
    try {
      const got = await getBets(userId)
      // What other windows got confirmed meanwhile, then this one's.
      const rows = read.over(elsewhere ? elsewhere.over(got, (acc, c) => reconcile(acc, c.op, c.row)) : got)
      if (userRef.current !== userId) return
      setServer(rows)
      landedRef.current = []
      setLanded([])
      setOffline(false)
    } catch (err) {
      if (userRef.current !== userId) return
      // Unreachable: offline. Signed out meanwhile, or a passing server
      // failure: the next read will do. Either way the device copy stays.
      const failure = classifySyncError(err)
      if (failure === 'offline') setOffline(true)
      else if (failure !== 'paused' && failure !== 'retry') onErrorRef.current(err)
    } finally {
      read.end()
    }
  }, [userId, setServer, shared])

  const syncNowRef = useRef<() => Promise<void>>(async () => {})

  const syncNow = useCallback(async (): Promise<void> => {
    if (syncingRef.current === userId || !canSyncRef.current || !userId) return
    // After a passing server failure the queue waits for its timer; after a
    // refusal with no room to set it apart, for room (saveAgain).
    if (backoffRef.current.waiting || refusalBlockedRef.current) return
    syncingRef.current = userId
    let result: DrainResult | null
    try {
      result = await drain<Bet>({
        send: (op, progress) => {
          if (op.kind !== 'bulk-add') return sendOp(op, undefined, userId)
          // Each chunk the server confirms is the server's from then on (see
          // landImport): into the server copy first, then what it made to
          // the batch's history, then off the import.
          let from = op.done ?? 0
          return sendOp(
            op,
            async (done, made) => {
              const start = from
              const chunk = { ...op, entries: op.entries.slice(start, done), done: 0 }
              fold((rows) => landImport(rows, op, start, done), { op: chunk, row: null })
              from = done
              if (made.length > 0 && userRef.current === userId) await tell({ kind: 'made', batch: op.batch ?? op.opId, table: 'bets', ids: made })
              await progress(done)
            },
            userId
          )
        },
        applied: async (op, row, superseded) => {
          if (userRef.current !== userId) return
          // A refused update lost to a newer edit elsewhere (or the bet is
          // gone). Nothing to retry: the refresh after the drain shows the
          // version that won. Unless a later change of this device for the
          // same bet is still queued: that one has the last word.
          if (op.kind === 'update' && row === null && !superseded) onNoticeRef.current?.('conflict')
          // What a batch's own adds and Undo came to, told before the op
          // leaves the queue (sent again at worst, never lost): an add made
          // the row if it carries the add's stamp (one already there, or
          // another device's, does not); an Undo's delete removed it unless
          // the row came back as it is now.
          if (op.kind === 'add' && op.batch && row && sameStamp(row.updatedAt, insertStamp(op))) {
            await tell({ kind: 'made', batch: op.batch, table: 'bets', ids: [op.id] })
          }
          if (op.kind === 'delete' && op.batch && op.ifStamp) {
            await tell({ kind: 'undo', batch: op.batch, table: 'bets', id: op.id, removed: row === null })
          }
          if (userRef.current !== userId) return
          fold((rows) => reconcile(rows, op, row), op.kind === 'bulk-add' ? undefined : { op, row })
          setOffline(false)
          setBehind(false)
          setPaused(false)
          setRetrying(false)
        }
      })
    } finally {
      if (syncingRef.current === userId) syncingRef.current = null
    }
    if (!result || userRef.current !== userId) return
    if (result.stop === 'offline') {
      setOffline(true)
      return
    }
    // The server answered, so the connection is back whatever said otherwise.
    setOffline(false)
    // Each stop says what holds the queue back now: a reason from an earlier
    // stop would otherwise outrank it on the badge (see syncStatus).
    // Only their state: their notices and the wait end with an op that goes
    // through, or a queue that empties.
    if (result.stop === 'paused') {
      setRetryingState(false)
      setBehindState(false)
      setPaused(true, result.error)
      return
    }
    if (result.stop === 'retry') {
      setPausedState(false)
      setBehindState(false)
      const wait = backoffRef.current.failed(result.error)
      setRetrying(true, result.error)
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      retryTimerRef.current = setTimeout(() => void syncNowRef.current(), wait)
      return
    }
    if (result.stop === 'behind') {
      setPausedState(false)
      setRetryingState(false)
      setBehind(true, result.error)
      return
    }
    // No room to set a refused change apart: the queue waits for room, and
    // the notice says so (see refusalBlocked).
    if (result.stop === 'storage') return
    setBehind(false)
    setPaused(false)
    setRetrying(false)
    // True-up after a drain so totals can never drift from the server.
    if (result.processed > 0 && outboxRef.current.length === 0) await refresh()
  }, [userId, drain, outboxRef, fold, setBehind, setPaused, setRetrying, refresh])
  syncNowRef.current = syncNow

  // Boot: hydrate this user's cache synchronously for instant paint (the
  // queue is useOpQueue's).
  useEffect(() => {
    serverRef.current = null
    setServerState(null)
    landedRef.current = []
    setLanded([])
    confirmedRef.current = confirmedLog<Bet>()
    setOffline(false)
    noticeRef.current.clear()
    pausedNoticeRef.current.clear()
    retryNoticeRef.current.clear()
    backoffRef.current.reset()
    setBehindState(false)
    setPausedState(false)
    setRetryingState(false)
    if (!userId) return
    const cached = loadCache(userId)
    serverRef.current = cached
    if (cached) setServerState(cached)
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [userId])

  // Another window refreshed the cache (after sending, say): show what it got.
  useEffect(() => {
    if (!userId) return
    const key = queueKeys(userId).cache
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== key) return
      const rows = loadCache(userId)
      if (rows) {
        serverRef.current = rows
        setServerState(rows)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [userId])

  // Whenever we (re)gain a live session: push pending work, then pull fresh.
  useEffect(() => {
    if (!userId || !canSync) return
    void syncNow().then(() => refresh())
  }, [userId, canSync, syncNow, refresh])

  // Realtime from other devices → debounced refetch.
  useEffect(() => {
    if (!userId || !canSync) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeToBets(userId, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refresh(), REALTIME_DEBOUNCE_MS)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
  }, [userId, canSync, refresh])

  // Reconnect signals + slow retry loop + resume-from-background refresh.
  useEffect(() => {
    if (!userId) return
    const onOnline = (): void => {
      setOffline(false)
      void syncNow().then(() => refresh())
    }
    const onOffline = (): void => setOffline(true)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void syncNow().then(() => refresh())
    }
    const timer = setInterval(() => {
      // Read again while the bets have never been read: a first read that
      // failed for now (a 503, say) on a connection the browser still thinks
      // is up sends no online event, and a device with no copy would stay on
      // the splash.
      const plan = retryPlan({ queued: outboxRef.current.length > 0, loaded: serverRef.current !== null })
      if (plan === 'read') void syncNow().then(() => refresh())
      else if (plan === 'drain') void syncNow()
    }, RETRY_INTERVAL_MS)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [userId, outboxRef, syncNow, refresh])

  const mutateMany = useCallback(
    async (ops: readonly PendingOp[]): Promise<boolean> => {
      if (ops.length === 0) return true
      const saved = await enqueue(ops)
      setTimeout(() => void syncNowRef.current(), 0)
      return saved
    },
    [enqueue]
  )

  const mutate = useCallback((op: PendingOp) => mutateMany([op]), [mutateMany])

  const add = useCallback(
    async (input: BetInput): Promise<boolean> => {
      const clean = normalizeInput(input) // throws on bad input, before anything is queued
      return mutate({
        opId: newId(),
        kind: 'add',
        id: newId(),
        input: clean,
        queuedAt: new Date().toISOString()
      })
    },
    [mutate]
  )

  const update = useCallback(
    async (id: string, input: BetInput): Promise<boolean> => {
      const clean = normalizeInput(input)
      return mutate({ opId: newId(), kind: 'update', id, input: clean, editedAt: new Date().toISOString() })
    },
    [mutate]
  )

  const remove = useCallback((id: string): Promise<boolean> => mutate({ opId: newId(), kind: 'delete', id }), [mutate])

  const importBets = useCallback(
    async (
      inputs: readonly BetInput[],
      opts: { ids?: readonly string[]; batch?: string; stamp?: string } = {}
    ): Promise<{ count: number; saved: boolean; opId: string; ids: string[]; stamp: string }> => {
      // Validate the whole batch up front so a bad row fails the import instead
      // of half-writing it.
      const entries = inputs.map((input, i) => ({ id: opts.ids?.[i] ?? newId(), input: normalizeInput(input) }))
      const opId = newId()
      const stamp = opts.stamp ?? new Date().toISOString()
      if (entries.length === 0) return { count: 0, saved: true, opId, ids: [], stamp }
      const saved = await mutate({ opId, kind: 'bulk-add', entries, queuedAt: stamp, ...(opts.batch ? { batch: opts.batch } : {}) })
      return { count: entries.length, saved, opId, ids: entries.map((e) => e.id), stamp }
    },
    [mutate]
  )

  const updateBets = useCallback(
    async (changes: readonly { id: string; input: BetInput }[]): Promise<boolean> => {
      const editedAt = new Date().toISOString()
      // Validate the whole batch first so a bad row fails the edit instead of half-applying it.
      const ops: PendingOp[] = changes.map(({ id, input }) => ({ opId: newId(), kind: 'update', id, input: normalizeInput(input), editedAt }))
      return mutateMany(ops)
    },
    [mutateMany]
  )

  const deleteBets = useCallback(
    (ids: readonly string[]): Promise<boolean> => mutateMany(ids.map((id) => ({ opId: newId(), kind: 'delete', id }))),
    [mutateMany]
  )

  const undoBets = useCallback(
    async (targets: readonly { id: string; stamp: string }[], batch: string): Promise<boolean> => {
      const saved = await mutateMany(targets.map(({ id, stamp }) => ({ opId: newId(), kind: 'delete', id, ifStamp: stamp, batch })))
      await settledHere(outboxRef.current, targets, batch, 'bets', tell)
      return saved
    },
    [mutateMany, outboxRef, tell]
  )

  const restoreBets = useCallback(
    async (rows: readonly Bet[], opts: { batch?: string; stamp?: string } = {}): Promise<boolean> => {
      const queuedAt = opts.stamp ?? readdStamp(rows)
      return mutateMany(
        rows.map((b) => ({
          opId: newId(),
          kind: 'add',
          ...(opts.batch ? { batch: opts.batch } : {}),
          id: b.id,
          input: normalizeInput({
            date: b.date,
            amount: b.amount,
            stake: b.stake,
            odds: b.odds,
            closingOdds: b.closingOdds,
            status: b.status,
            note: b.note,
            sport: b.sport,
            book: b.book,
            betType: b.betType
          }),
          queuedAt
        }))
      )
    },
    [mutateMany]
  )

  const retryRefused = useCallback(async (): Promise<boolean> => {
    const saved = await retryQueued()
    setTimeout(() => void syncNowRef.current(), 0)
    return saved
  }, [retryQueued])

  const saveAgain = useCallback(async (): Promise<boolean> => {
    const saved = await saveQueued()
    if (saved) setTimeout(() => void syncNowRef.current(), 0)
    return saved
  }, [saveQueued])

  const bets = useMemo(() => {
    if (server === null && outbox.length === 0 && landed.length === 0) return null
    return applyOutbox(server ?? landed, outbox)
  }, [server, landed, outbox])

  const status = syncStatus({ canSync, offline, queued: outbox.length, behind, paused, retrying })

  // Rows waiting to sync, not ops — one queued import of 40 bets reads as 40,
  // less the rows an interrupted attempt already stored.
  const queuedCount = useMemo(() => outbox.reduce((n, op) => n + opSize(op) - (op.kind === 'bulk-add' ? (op.done ?? 0) : 0), 0), [outbox])

  // By the batch each belongs to (its op's id for an import queued before batches had their own).
  const importing = useMemo(
    () =>
      new Map(
        outbox.flatMap((op) => (op.kind === 'bulk-add' ? [[op.batch ?? op.opId, { done: op.done ?? 0, total: opSize(op) }] as const] : []))
      ),
    [outbox]
  )
  const batchQueued = useMemo(() => queuedByBatch(outbox), [outbox])
  const batchRefused = useMemo(() => refusedBatches(queue.refused), [queue.refused])

  return {
    bets,
    status,
    queuedCount,
    importing,
    isOffline: status === 'offline',
    unsaved: queue.held && outbox.length > 0,
    refused: queue.refused,
    refusedUnsaved: queue.refusedHeld && queue.refused.length > 0,
    refusalBlocked,
    addBet: add,
    updateBet: update,
    deleteBet: remove,
    importBets,
    updateBets,
    deleteBets,
    undoBets,
    batchQueued,
    batchRefused,
    restoreBets,
    retryRefused,
    discardRefused,
    saveAgain
  }
}

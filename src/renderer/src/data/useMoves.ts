import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BankrollMove, MoveInput } from '../../../shared/types'
import { newId } from '../lib/uuid'
import { normalizeMove } from '../lib/validate'
import { afterFailedRead, backoff, foldApplied, migrationNotice, retryPlan, syncStatus, type DrainResult, type SyncStatus } from './drain'
import { SignedOutError } from './errors'
import { getMoves, sendMoveOp, subscribeToMoves } from './moves'
import {
  applyMoveOutbox,
  loadMoveCache,
  loadMovesRefused,
  queueKeys,
  readMoveOutbox,
  reconcileMove,
  saveMoveCache,
  saveMoveOutbox,
  saveMovesRefused,
  type MoveOp,
  type Refused
} from './offline'
import { useOpQueue } from './useOpQueue'

export interface MoveSync {
  /**
   * Server rows with queued changes applied. Before the first snapshot, only
   * what this device queued (or sent since): pass it on as the bankroll's
   * moves only when `loaded`.
   */
  moves: BankrollMove[]
  /** A snapshot exists: a cache, a successful read, or the [] a missing table means. */
  loaded: boolean
  status: SyncStatus
  /** Moves waiting to reach the server. */
  queuedCount: number
  /** A change waits for migration 005 (a write was refused for the missing table). */
  blocked: boolean
  /** Storage refused the queue: these changes are only in this window until they sync. */
  unsaved: boolean
  /** Changes the server refused for good, kept to send again or let go. */
  refused: Refused<MoveInput>[]
  /** Each resolves once queued: true when this device's storage holds it (see useBetSync). */
  addMove: (input: MoveInput) => Promise<boolean>
  updateMove: (id: string, input: MoveInput) => Promise<boolean>
  deleteMove: (id: string) => Promise<boolean>
  /** Undo of a delete: an add with the same id and a fresh queuedAt. */
  restoreMove: (m: BankrollMove) => Promise<boolean>
  retryRefused: () => Promise<boolean>
  discardRefused: () => Promise<void>
  saveAgain: () => Promise<boolean>
}

const RETRY_INTERVAL_MS = 20_000
const REALTIME_DEBOUNCE_MS = 400

/**
 * Deposits and withdrawals, offline-first exactly like the bets (useBetSync):
 * a device cache for instant paint, an outbox shared by every window and
 * replayed in order by the same queue rules, and a full read as the anchor
 * after a drain and on realtime events.
 *
 * What differs is that the table comes with migration 005, which the app can
 * run ahead of. A read that finds it missing is not an error: there are no
 * moves on the server yet, so the list is empty, nothing is said, and the
 * hook keeps reading on the slow timer to notice the migration. A change made
 * meanwhile waits in the queue, and its refused write says why once per
 * episode, like the bets'.
 */
export function useMoves(
  userId: string | null,
  canSync: boolean,
  onError: (err: unknown) => void,
  onNotice?: (code: 'conflict') => void
): MoveSync {
  const [server, setServerState] = useState<BankrollMove[] | null>(null)
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine)
  const [behind, setBehindState] = useState(false)
  const [paused, setPausedState] = useState(false)
  const [retrying, setRetryingState] = useState(false)
  // A read went through, so the table exists: only then is there anything to
  // subscribe to.
  const [tableReady, setTableReady] = useState(false)
  // Moves that reached the server before this device had any snapshot. They
  // keep showing until the first read brings the whole list, but are never
  // cached and never make the list count as loaded.
  const [landed, setLanded] = useState<BankrollMove[]>([])
  const landedRef = useRef<BankrollMove[]>([])

  const serverRef = useRef<BankrollMove[] | null>(null)
  const syncingRef = useRef(false)
  const noticeRef = useRef(migrationNotice())
  const pausedNoticeRef = useRef(migrationNotice())
  const retryNoticeRef = useRef(migrationNotice())
  const backoffRef = useRef(backoff())
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The last read found the table missing: keep reading until it is there.
  const tableMissingRef = useRef(false)
  const canSyncRef = useRef(canSync)
  canSyncRef.current = canSync
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const onNoticeRef = useRef(onNotice)
  onNoticeRef.current = onNotice

  const queue = useOpQueue<MoveInput>({
    userId,
    name: 'moves',
    keys: (uid) => ({ queue: queueKeys(uid).moves, refused: queueKeys(uid).movesRefused }),
    read: readMoveOutbox,
    save: saveMoveOutbox,
    readRefused: loadMovesRefused,
    saveRefused: saveMovesRefused,
    onRefused: (err) => onErrorRef.current(err),
    newId
  })
  // Each of these keeps its identity from render to render (the queue object itself does not).
  const { outbox, outboxRef, enqueue, drain, discardRefused } = queue
  const retryQueued = queue.retryRefused
  const saveQueued = queue.saveAgain

  const setServer = useCallback(
    (rows: BankrollMove[]) => {
      serverRef.current = rows
      setServerState(rows)
      if (userId) saveMoveCache(userId, rows)
    },
    [userId]
  )

  // A write found the table missing. The hint is shown once, when that is
  // first found, not on every retry or resume; a write that goes through, or
  // a queue that empties, ends the episode. Reads never start one.
  const setBehind = useCallback((next: boolean, err?: unknown) => {
    if (next && noticeRef.current.found()) onErrorRef.current(err)
    if (!next) noticeRef.current.clear()
    setBehindState(next)
  }, [])

  // As useBetSync: said once per episode; a lost session has its own notice.
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

  const refresh = useCallback(async (): Promise<void> => {
    if (!userId || !canSyncRef.current) return
    try {
      const rows = await getMoves()
      setServer(rows)
      setOffline(false)
      tableMissingRef.current = false
      setTableReady(true)
      setBehind(false)
    } catch (err) {
      const read = afterFailedRead(err, serverRef.current)
      setOffline(read.offline)
      // Only the missing table changes the snapshot: no table, no moves yet.
      if (read.server !== null && read.server !== serverRef.current) setServer(read.server)
      if (read.tableMissing) tableMissingRef.current = true
      if (read.report) onErrorRef.current(err)
    }
  }, [userId, setServer, setBehind])

  const syncNowRef = useRef<() => Promise<void>>(async () => {})

  const syncNow = useCallback(async (): Promise<void> => {
    if (syncingRef.current || !canSyncRef.current || !userId) return
    if (backoffRef.current.waiting) return
    syncingRef.current = true
    let result: DrainResult | null
    try {
      result = await drain<BankrollMove>({
        send: (op) => sendMoveOp(op),
        applied: (op, row, superseded) => {
          // A refused edit lost to a newer one elsewhere, unless a later change
          // of this device to the same move is still queued (see useBetSync).
          if (op.kind === 'update' && row === null && !superseded) onNoticeRef.current?.('conflict')
          // Folded only into a snapshot this device has (see foldApplied).
          // The refresh after the drain brings the whole list.
          const next = foldApplied(serverRef.current, landedRef.current, (rows) => reconcileMove(rows, op, row))
          if (next.server !== null) setServer(next.server)
          else {
            landedRef.current = next.landed
            setLanded(next.landed)
          }
          setOffline(false)
          setBehind(false)
          setPaused(false)
          setRetrying(false)
        }
      })
    } finally {
      syncingRef.current = false
    }
    if (!result) return
    if (result.stop === 'offline') {
      setOffline(true)
      return
    }
    // The server answered, so the connection is back whatever said otherwise.
    setOffline(false)
    if (result.stop === 'paused') {
      setPaused(true, result.error)
      return
    }
    if (result.stop === 'retry') {
      const wait = backoffRef.current.failed(result.error)
      setRetrying(true, result.error)
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      retryTimerRef.current = setTimeout(() => void syncNowRef.current(), wait)
      return
    }
    if (result.stop === 'behind') {
      setBehind(true, result.error)
      return
    }
    setBehind(false)
    setPaused(false)
    setRetrying(false)
    // True-up after a drain so the bankroll can never drift from the server.
    if (result.processed > 0 && outboxRef.current.length === 0) await refresh()
  }, [userId, drain, outboxRef, setServer, setBehind, setPaused, setRetrying, refresh])
  syncNowRef.current = syncNow

  // Boot: hydrate this user's cache synchronously for instant paint (the
  // queue is useOpQueue's).
  useEffect(() => {
    serverRef.current = null
    tableMissingRef.current = false
    setServerState(null)
    setOffline(false)
    noticeRef.current.clear()
    pausedNoticeRef.current.clear()
    retryNoticeRef.current.clear()
    backoffRef.current.reset()
    setBehindState(false)
    setPausedState(false)
    setRetryingState(false)
    setTableReady(false)
    landedRef.current = []
    setLanded([])
    if (!userId) return
    const cached = loadMoveCache(userId)
    serverRef.current = cached
    if (cached) setServerState(cached)
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [userId])

  // Another window refreshed the cache: show what it got.
  useEffect(() => {
    if (!userId) return
    const key = queueKeys(userId).movesCache
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== key) return
      const rows = loadMoveCache(userId)
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

  // Realtime from other devices → debounced refetch, once the table is known
  // to exist.
  useEffect(() => {
    if (!userId || !canSync || !tableReady) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeToMoves(userId, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refresh(), REALTIME_DEBOUNCE_MS)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
  }, [userId, canSync, tableReady, refresh])

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
      // Read too while nothing has been read yet, or while the table is
      // missing (see retryPlan): no other event may ever come to do it.
      const plan = retryPlan({ queued: outboxRef.current.length > 0, loaded: serverRef.current !== null, tableMissing: tableMissingRef.current })
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

  const mutate = useCallback(
    async (op: MoveOp): Promise<boolean> => {
      const saved = await enqueue([op])
      setTimeout(() => void syncNowRef.current(), 0)
      return saved
    },
    [enqueue]
  )

  const add = useCallback(
    async (input: MoveInput): Promise<boolean> => {
      const clean = normalizeMove(input) // throws on bad input, before anything is queued
      return mutate({ opId: newId(), kind: 'add', id: newId(), input: clean, queuedAt: new Date().toISOString() })
    },
    [mutate]
  )

  const update = useCallback(
    async (id: string, input: MoveInput): Promise<boolean> => {
      const clean = normalizeMove(input)
      return mutate({ opId: newId(), kind: 'update', id, input: clean, editedAt: new Date().toISOString() })
    },
    [mutate]
  )

  const remove = useCallback((id: string): Promise<boolean> => mutate({ opId: newId(), kind: 'delete', id }), [mutate])

  const restore = useCallback(
    async (m: BankrollMove): Promise<boolean> => {
      const clean = normalizeMove({ date: m.date, amount: m.amount, note: m.note })
      return mutate({ opId: newId(), kind: 'add', id: m.id, input: clean, queuedAt: new Date().toISOString() })
    },
    [mutate]
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

  // Queued changes show even before the first snapshot: a deposit made on a
  // device that has never loaded the list is still the user's deposit.
  const moves = useMemo(() => applyMoveOutbox(server ?? landed, outbox), [server, landed, outbox])

  const status = syncStatus({ canSync, offline, queued: outbox.length, behind, paused, retrying })

  return {
    moves,
    loaded: server !== null,
    status,
    queuedCount: outbox.length,
    blocked: behind && outbox.length > 0,
    unsaved: queue.held && outbox.length > 0,
    refused: queue.refused,
    addMove: add,
    updateMove: update,
    deleteMove: remove,
    restoreMove: restore,
    retryRefused,
    discardRefused,
    saveAgain
  }
}

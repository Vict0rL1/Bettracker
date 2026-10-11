import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BankrollMove, MoveInput } from '../../../shared/types'
import { normalizeMove } from '../lib/validate'
import { afterFailedRead, drainOutbox, migrationNotice, syncStatus, type DrainResult, type SyncStatus } from './drain'
import { getMoves, sendMoveOp, subscribeToMoves } from './moves'
import {
  applyMoveOutbox,
  enqueueOp,
  loadMoveCache,
  loadMoveOutbox,
  reconcileMove,
  saveMoveCache,
  saveMoveOutbox,
  type MoveOp
} from './offline'

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
  addMove: (input: MoveInput) => void
  updateMove: (id: string, input: MoveInput) => void
  deleteMove: (id: string) => void
  /** Undo of a delete: an add with the same id and a fresh queuedAt. */
  restoreMove: (m: BankrollMove) => void
}

const RETRY_INTERVAL_MS = 20_000
const REALTIME_DEBOUNCE_MS = 400

/**
 * Deposits and withdrawals, offline-first exactly like the bets (useBetSync):
 * a device cache for instant paint, an outbox replayed in order by the same
 * queue rules, and a full read as the anchor after a drain and on realtime
 * events.
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
  const [outbox, setOutboxState] = useState<MoveOp[]>([])
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine)
  const [behind, setBehindState] = useState(false)
  // A read went through, so the table exists: only then is there anything to
  // subscribe to.
  const [tableReady, setTableReady] = useState(false)
  // Moves that reached the server before this device had any snapshot. They
  // keep showing until the first read brings the whole list, but are never
  // cached and never make the list count as loaded.
  const [landed, setLanded] = useState<BankrollMove[]>([])

  const serverRef = useRef<BankrollMove[] | null>(null)
  const outboxRef = useRef<MoveOp[]>([])
  const syncingRef = useRef(false)
  const noticeRef = useRef(migrationNotice())
  // The last read found the table missing: keep reading until it is there.
  const tableMissingRef = useRef(false)
  const canSyncRef = useRef(canSync)
  canSyncRef.current = canSync
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const onNoticeRef = useRef(onNotice)
  onNoticeRef.current = onNotice

  const setServer = useCallback(
    (rows: BankrollMove[]) => {
      serverRef.current = rows
      setServerState(rows)
      if (userId) saveMoveCache(userId, rows)
    },
    [userId]
  )

  const setOutbox = useCallback(
    (next: MoveOp[]) => {
      outboxRef.current = next
      setOutboxState(next)
      if (userId) saveMoveOutbox(userId, next)
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

  const syncNow = useCallback(async (): Promise<void> => {
    if (syncingRef.current || !canSyncRef.current || !userId) return
    syncingRef.current = true
    let result: DrainResult
    try {
      result = await drainOutbox<MoveInput, BankrollMove>({
        outbox: () => outboxRef.current,
        setOutbox,
        setSent: (op, sent) =>
          setOutbox(outboxRef.current.map((o) => (o.opId === op.opId ? { ...o, sent: sent ? true : undefined } : o))),
        send: sendMoveOp,
        applied: (op, row, superseded) => {
          // A refused edit lost to a newer one elsewhere, unless a later change
          // of this device to the same move is still queued (see useBetSync).
          if (op.kind === 'update' && row === null && !superseded) onNoticeRef.current?.('conflict')
          // Folded only into a snapshot this device has: one returned row is
          // not the list, and a cache of it would read as a known bankroll.
          // The refresh after the drain brings the whole list.
          if (serverRef.current !== null) setServer(reconcileMove(serverRef.current, op, row))
          else setLanded((rows) => reconcileMove(rows, op, row))
          setOffline(false)
          setBehind(false)
        },
        rejected: (_op, err) => onErrorRef.current(err)
      })
    } finally {
      syncingRef.current = false
    }
    if (result.stop === 'offline') {
      setOffline(true)
      return
    }
    if (result.stop === 'behind') {
      // The server answered, so the connection is back whatever said otherwise.
      setOffline(false)
      setBehind(true, result.error)
      return
    }
    setBehind(false)
    // True-up after a drain so the bankroll can never drift from the server.
    if (result.processed > 0 && outboxRef.current.length === 0) await refresh()
  }, [userId, setServer, setOutbox, setBehind, refresh])

  // Boot: hydrate this user's cache + outbox synchronously for instant paint.
  useEffect(() => {
    serverRef.current = null
    outboxRef.current = []
    tableMissingRef.current = false
    setServerState(null)
    setOutboxState([])
    setOffline(false)
    noticeRef.current.clear()
    setBehindState(false)
    setTableReady(false)
    setLanded([])
    if (!userId) return
    const cached = loadMoveCache(userId)
    const pending = loadMoveOutbox(userId)
    serverRef.current = cached
    outboxRef.current = pending
    if (cached) setServerState(cached)
    setOutboxState(pending)
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
      // While the table is missing, read too: with nothing queued, a window
      // left open would otherwise never notice that 005 has been run.
      if (tableMissingRef.current) void syncNow().then(() => refresh())
      else if (outboxRef.current.length > 0) void syncNow()
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
  }, [userId, syncNow, refresh])

  const mutate = useCallback(
    (op: MoveOp) => {
      setOutbox(enqueueOp<MoveInput>(outboxRef.current, op))
      setTimeout(() => void syncNow(), 0)
    },
    [setOutbox, syncNow]
  )

  const add = useCallback(
    (input: MoveInput) => {
      const clean = normalizeMove(input) // throws on bad input, before anything is queued
      mutate({ opId: crypto.randomUUID(), kind: 'add', id: crypto.randomUUID(), input: clean, queuedAt: new Date().toISOString() })
    },
    [mutate]
  )

  const update = useCallback(
    (id: string, input: MoveInput) => {
      const clean = normalizeMove(input)
      mutate({ opId: crypto.randomUUID(), kind: 'update', id, input: clean, editedAt: new Date().toISOString() })
    },
    [mutate]
  )

  const remove = useCallback(
    (id: string) => {
      mutate({ opId: crypto.randomUUID(), kind: 'delete', id })
    },
    [mutate]
  )

  const restore = useCallback(
    (m: BankrollMove) => {
      const clean = normalizeMove({ date: m.date, amount: m.amount, note: m.note })
      mutate({ opId: crypto.randomUUID(), kind: 'add', id: m.id, input: clean, queuedAt: new Date().toISOString() })
    },
    [mutate]
  )

  // Queued changes show even before the first snapshot: a deposit made on a
  // device that has never loaded the list is still the user's deposit.
  const moves = useMemo(() => applyMoveOutbox(server ?? landed, outbox), [server, landed, outbox])

  const status = syncStatus({ canSync, offline, queued: outbox.length, behind })

  return {
    moves,
    loaded: server !== null,
    status,
    queuedCount: outbox.length,
    blocked: behind && outbox.length > 0,
    addMove: add,
    updateMove: update,
    deleteMove: remove,
    restoreMove: restore
  }
}

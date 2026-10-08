import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Bet, BetInput } from '../../../shared/types'
import { normalizeInput } from '../lib/validate'
import { addBet, addBets, deleteBet, getBets, isNetworkError, subscribeToBets, updateBet } from './bets'
import {
  applyOutbox,
  enqueueOp,
  loadCache,
  loadOutbox,
  opSize,
  reconcile,
  saveCache,
  saveOutbox,
  type PendingOp
} from './offline'

export type SyncStatus = 'synced' | 'syncing' | 'offline'

export interface BetSync {
  /** Server rows with queued local changes applied; null until first load. */
  bets: Bet[] | null
  status: SyncStatus
  /** Rows waiting to reach the server (not bets awaiting settlement). */
  queuedCount: number
  isOffline: boolean
  addBet: (input: BetInput) => void
  updateBet: (id: string, input: BetInput) => void
  deleteBet: (id: string) => void
  /** Queue an imported batch as a single op. Returns how many rows were queued. */
  importBets: (inputs: readonly BetInput[]) => number
}

const RETRY_INTERVAL_MS = 20_000
const REALTIME_DEBOUNCE_MS = 400

/**
 * Offline-first bet state.
 *
 * The device cache renders instantly on boot; mutations apply to the UI
 * immediately and enter a persistent outbox that is replayed against Supabase
 * in order — on enqueue, on reconnect, and on a slow retry timer. A full fetch
 * remains the reconciliation anchor after the queue drains and on realtime
 * events from other devices.
 *
 * `onNotice` is for things that are not errors but the user should hear; it
 * gets a code (not copy) so the app can phrase it in the user's language.
 */
export function useBetSync(
  userId: string | null,
  canSync: boolean,
  onError: (err: unknown) => void,
  onNotice?: (code: 'conflict') => void
): BetSync {
  const [server, setServerState] = useState<Bet[] | null>(null)
  const [outbox, setOutboxState] = useState<PendingOp[]>([])
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine)

  // Refs are the source of truth inside the async sync loop; state mirrors
  // them for rendering.
  const serverRef = useRef<Bet[] | null>(null)
  const outboxRef = useRef<PendingOp[]>([])
  const syncingRef = useRef(false)
  const canSyncRef = useRef(canSync)
  canSyncRef.current = canSync
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const onNoticeRef = useRef(onNotice)
  onNoticeRef.current = onNotice

  const setServer = useCallback(
    (rows: Bet[]) => {
      serverRef.current = rows
      setServerState(rows)
      if (userId) saveCache(userId, rows)
    },
    [userId]
  )

  const setOutbox = useCallback(
    (next: PendingOp[]) => {
      outboxRef.current = next
      setOutboxState(next)
      if (userId) saveOutbox(userId, next)
    },
    [userId]
  )

  const refresh = useCallback(async (): Promise<void> => {
    if (!userId || !canSyncRef.current) return
    try {
      const rows = await getBets()
      setServer(rows)
      setOffline(false)
    } catch (err) {
      if (isNetworkError(err)) setOffline(true)
      else onErrorRef.current(err)
    }
  }, [userId, setServer])

  const syncNow = useCallback(async (): Promise<void> => {
    if (syncingRef.current || !canSyncRef.current || !userId) return
    syncingRef.current = true
    let processed = false
    try {
      while (outboxRef.current.length > 0) {
        const op = outboxRef.current[0]
        try {
          let result: Bet | null = null
          if (op.kind === 'add') result = await addBet(op.input, op.id)
          else if (op.kind === 'update') {
            result = await updateBet(op.id, op.input, op.editedAt)
            // A refused update lost to a newer edit elsewhere (or the bet is
            // gone). Nothing to retry: the refresh after the drain shows the
            // version that won.
            if (result === null) onNoticeRef.current?.('conflict')
          } else if (op.kind === 'bulk-add') await addBets(op.entries)
          else await deleteBet(op.id)

          setServer(reconcile(serverRef.current ?? [], op, result))
          setOutbox(outboxRef.current.slice(1))
          setOffline(false)
          processed = true
        } catch (err) {
          if (isNetworkError(err)) {
            // Unreachable — keep the op and try again later, in order.
            setOffline(true)
            return
          }
          // The server rejected this op (validation, RLS, row gone). Drop it
          // so it can't block the queue, surface the error, and keep going.
          setOutbox(outboxRef.current.slice(1))
          onErrorRef.current(err)
        }
      }
    } finally {
      syncingRef.current = false
    }
    // True-up after a drain so totals can never drift from the server.
    if (processed && outboxRef.current.length === 0) await refresh()
  }, [userId, setServer, setOutbox, refresh])

  // Boot: hydrate this user's cache + outbox synchronously for instant paint.
  useEffect(() => {
    serverRef.current = null
    outboxRef.current = []
    setServerState(null)
    setOutboxState([])
    setOffline(false)
    if (!userId) return
    const cached = loadCache(userId)
    const pending = loadOutbox(userId)
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
      if (outboxRef.current.length > 0) void syncNow()
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
    (op: PendingOp) => {
      setOutbox(enqueueOp(outboxRef.current, op))
      setTimeout(() => void syncNow(), 0)
    },
    [setOutbox, syncNow]
  )

  const add = useCallback(
    (input: BetInput) => {
      const clean = normalizeInput(input) // throws on bad input, before anything is queued
      mutate({
        opId: crypto.randomUUID(),
        kind: 'add',
        id: crypto.randomUUID(),
        input: clean,
        queuedAt: new Date().toISOString()
      })
    },
    [mutate]
  )

  const update = useCallback(
    (id: string, input: BetInput) => {
      const clean = normalizeInput(input)
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

  const importBets = useCallback(
    (inputs: readonly BetInput[]): number => {
      // Validate the whole batch up front so a bad row fails the import instead
      // of half-writing it.
      const entries = inputs.map((input) => ({ id: crypto.randomUUID(), input: normalizeInput(input) }))
      if (entries.length === 0) return 0
      mutate({ opId: crypto.randomUUID(), kind: 'bulk-add', entries, queuedAt: new Date().toISOString() })
      return entries.length
    },
    [mutate]
  )

  const bets = useMemo(() => {
    if (server === null && outbox.length === 0) return null
    return applyOutbox(server ?? [], outbox)
  }, [server, outbox])

  const status: SyncStatus = !canSync || offline ? 'offline' : outbox.length > 0 ? 'syncing' : 'synced'

  // Rows waiting to sync, not ops — one queued import of 40 bets reads as 40.
  const queuedCount = useMemo(() => outbox.reduce((n, op) => n + opSize(op), 0), [outbox])

  return {
    bets,
    status,
    queuedCount,
    isOffline: status === 'offline',
    addBet: add,
    updateBet: update,
    deleteBet: remove,
    importBets
  }
}

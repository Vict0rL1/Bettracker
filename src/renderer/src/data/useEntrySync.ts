import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BetEntry, EntryInput } from '../../../shared/types'
import { normalizeInput } from '../lib/validate'
import { addEntry, deleteEntry, getEntries, isNetworkError, subscribeToEntries, updateEntry } from './entries'
import {
  applyOutbox,
  enqueueOp,
  loadCache,
  loadOutbox,
  reconcile,
  saveCache,
  saveOutbox,
  type PendingOp
} from './offline'

export type SyncStatus = 'synced' | 'syncing' | 'offline'

export interface EntrySync {
  /** Server rows with pending local changes applied; null until first load. */
  entries: BetEntry[] | null
  status: SyncStatus
  pendingCount: number
  isOffline: boolean
  addSession: (input: EntryInput) => void
  updateSession: (id: string, input: EntryInput) => void
  deleteSession: (id: string) => void
}

const RETRY_INTERVAL_MS = 20_000
const REALTIME_DEBOUNCE_MS = 400

/**
 * Offline-first entry state.
 *
 * The device cache renders instantly on boot; mutations apply to the UI
 * immediately and enter a persistent outbox that is replayed against Supabase
 * in order — on enqueue, on reconnect, and on a slow retry timer. A full fetch
 * remains the reconciliation anchor after the queue drains and on realtime
 * events from other devices.
 */
export function useEntrySync(
  userId: string | null,
  canSync: boolean,
  onError: (err: unknown) => void
): EntrySync {
  const [server, setServerState] = useState<BetEntry[] | null>(null)
  const [outbox, setOutboxState] = useState<PendingOp[]>([])
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine)

  // Refs are the source of truth inside the async sync loop; state mirrors
  // them for rendering.
  const serverRef = useRef<BetEntry[] | null>(null)
  const outboxRef = useRef<PendingOp[]>([])
  const syncingRef = useRef(false)
  const canSyncRef = useRef(canSync)
  canSyncRef.current = canSync
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const setServer = useCallback(
    (rows: BetEntry[]) => {
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
      const rows = await getEntries()
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
          let result: BetEntry | null = null
          if (op.kind === 'add') result = await addEntry(op.input, op.id)
          else if (op.kind === 'update') result = await updateEntry(op.id, op.input)
          else await deleteEntry(op.id)

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
    const unsubscribe = subscribeToEntries(userId, () => {
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

  const addSession = useCallback(
    (input: EntryInput) => {
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

  const updateSession = useCallback(
    (id: string, input: EntryInput) => {
      const clean = normalizeInput(input)
      mutate({ opId: crypto.randomUUID(), kind: 'update', id, input: clean })
    },
    [mutate]
  )

  const deleteSession = useCallback(
    (id: string) => {
      mutate({ opId: crypto.randomUUID(), kind: 'delete', id })
    },
    [mutate]
  )

  const entries = useMemo(() => {
    if (server === null && outbox.length === 0) return null
    return applyOutbox(server ?? [], outbox)
  }, [server, outbox])

  const status: SyncStatus = !canSync || offline ? 'offline' : outbox.length > 0 ? 'syncing' : 'synced'

  return {
    entries,
    status,
    pendingCount: outbox.length,
    isOffline: status === 'offline',
    addSession,
    updateSession,
    deleteSession
  }
}

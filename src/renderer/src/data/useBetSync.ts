import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Bet, BetInput } from '../../../shared/types'
import { normalizeInput } from '../lib/validate'
import { addBet, addBets, deleteBet, getBets, subscribeToBets, updateBet } from './bets'
import { drainOutbox, type DrainResult } from './drain'
import { isNetworkError } from './errors'
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

/** 'behind': changes are queued because the database is missing a migration. */
export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'behind'

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
  /** Several edits at once (bulk retag/settle, and Undo of either): one state update, one op per bet. */
  updateBets: (changes: readonly { id: string; input: BetInput }[]) => void
  deleteBets: (ids: readonly string[]) => void
  /** Undo of a delete: re-add the rows with their original ids, through the outbox like everything else. */
  restoreBets: (bets: readonly Bet[]) => void
}

const RETRY_INTERVAL_MS = 20_000
const REALTIME_DEBOUNCE_MS = 400

/** One queued op, sent. Resolves with the row the server returned, when there is one. */
async function sendOp(op: PendingOp): Promise<Bet | null> {
  if (op.kind === 'add') return addBet(op.input, op.id)
  if (op.kind === 'update') return updateBet(op.id, op.input, op.editedAt)
  if (op.kind === 'bulk-add') await addBets(op.entries)
  else await deleteBet(op.id)
  return null
}

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
  const [behind, setBehindState] = useState(false)

  // Refs are the source of truth inside the async sync loop; state mirrors
  // them for rendering.
  const serverRef = useRef<Bet[] | null>(null)
  const outboxRef = useRef<PendingOp[]>([])
  const syncingRef = useRef(false)
  const behindRef = useRef(false)
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

  // The database is missing a migration. The hint is shown once, when that is
  // first found, not on every retry; any op that goes through clears it.
  const setBehind = useCallback((next: boolean, err?: unknown) => {
    if (next && !behindRef.current) onErrorRef.current(err)
    behindRef.current = next
    setBehindState(next)
  }, [])

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
    let result: DrainResult
    try {
      result = await drainOutbox({
        outbox: () => outboxRef.current,
        setOutbox,
        send: sendOp,
        applied: (op, row) => {
          // A refused update lost to a newer edit elsewhere (or the bet is
          // gone). Nothing to retry: the refresh after the drain shows the
          // version that won.
          if (op.kind === 'update' && row === null) onNoticeRef.current?.('conflict')
          setServer(reconcile(serverRef.current ?? [], op, row))
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
      setBehind(true, result.error)
      return
    }
    // True-up after a drain so totals can never drift from the server.
    if (result.processed > 0 && outboxRef.current.length === 0) await refresh()
  }, [userId, setServer, setOutbox, setBehind, refresh])

  // Boot: hydrate this user's cache + outbox synchronously for instant paint.
  useEffect(() => {
    serverRef.current = null
    outboxRef.current = []
    setServerState(null)
    setOutboxState([])
    setOffline(false)
    behindRef.current = false
    setBehindState(false)
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

  const mutateMany = useCallback(
    (ops: readonly PendingOp[]) => {
      if (ops.length === 0) return
      let next = outboxRef.current
      for (const op of ops) next = enqueueOp(next, op)
      setOutbox(next)
      setTimeout(() => void syncNow(), 0)
    },
    [setOutbox, syncNow]
  )

  const mutate = useCallback((op: PendingOp) => mutateMany([op]), [mutateMany])

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

  const updateBets = useCallback(
    (changes: readonly { id: string; input: BetInput }[]) => {
      const editedAt = new Date().toISOString()
      // Validate the whole batch first so a bad row fails the edit instead of half-applying it.
      const ops: PendingOp[] = changes.map(({ id, input }) => ({ opId: crypto.randomUUID(), kind: 'update', id, input: normalizeInput(input), editedAt }))
      mutateMany(ops)
    },
    [mutateMany]
  )

  const deleteBets = useCallback(
    (ids: readonly string[]) => {
      mutateMany(ids.map((id) => ({ opId: crypto.randomUUID(), kind: 'delete', id })))
    },
    [mutateMany]
  )

  const restoreBets = useCallback(
    (rows: readonly Bet[]) => {
      const queuedAt = new Date().toISOString()
      mutateMany(
        rows.map((b) => ({
          opId: crypto.randomUUID(),
          kind: 'add',
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

  const bets = useMemo(() => {
    if (server === null && outbox.length === 0) return null
    return applyOutbox(server ?? [], outbox)
  }, [server, outbox])

  const status: SyncStatus = !canSync || offline ? 'offline' : outbox.length === 0 ? 'synced' : behind ? 'behind' : 'syncing'

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
    importBets,
    updateBets,
    deleteBets,
    restoreBets
  }
}

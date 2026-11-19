import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newId } from '../lib/uuid'
import { MAX_READS, REREAD_MS, sharedLog } from './confirmed'
import { afterFailedRead, backoff, confirmedLog, foldApplied, migrationNotice, retryPlan, sharedMigrationNotice, syncStatus, type DrainResult, type SharedMigrationNotice, type SyncStatus } from './drain'
import { SignedOutError } from './errors'
import { drainTurns, oneAtATime } from './oneAtATime'
import { confirmedKey, rowKeys, writable, type PendingOp, type Refused } from './offline'
import { addManyOps, addOp, answerNotice, restoreOp } from './rowOps'
import { applyRowOutbox, loadRowCache, loadRowRefused, readRowOutbox, reconcileRow, saveRowCache, saveRowOutbox, saveRowRefused, type RowBase } from './rowStorage'
import type { RowTable } from './rowTable'
import { useOpQueue } from './useOpQueue'

export interface RowSyncOptions<T extends RowBase, I> {
  table: RowTable<T, I>
  userId: string | null
  canSync: boolean
  onError: (err: unknown) => void
  onNotice?: (code: 'conflict') => void
  /** The "database is behind" notice, shared by the three hooks so 008 missing is said once (App creates one per user). */
  notice?: SharedMigrationNotice
}

export interface RowSync<T, I> {
  /** Server rows with queued changes on top; before the first snapshot, only what this device queued or got back. */
  rows: T[]
  /** A snapshot exists: a cache, a successful read, or the [] a missing table means. */
  loaded: boolean
  /** A read or a write of the table went through in this session: positive evidence that 008 has run. */
  tableReady: boolean
  /** The last read found the table missing (008 not run); false again once a read or a write goes through. */
  tableMissing: boolean
  status: SyncStatus
  queuedCount: number
  /** A queued change waits for migration 008 (a write was refused for the missing table). */
  blocked: boolean
  /** Storage refused the queue: these changes are only in this window until they sync. */
  unsaved: boolean
  /** Changes the server refused for good, kept to send again or let go. */
  refused: Refused<I>[]
  /** Storage refused the list of refused changes: they are only in this window. */
  refusedUnsaved: boolean
  /** As useBetSync's: a refused change waits in the queue for room to be set apart. */
  refusalBlocked: boolean
  /**
   * Each resolves once queued; `saved`: this device's storage holds it. Throws InputError before queueing.
   * `after`: the updatedAt of the last row this device knew under `id` (a stable id set again after it was cleared);
   * the add is stamped readdStamp([{ updatedAt: after }]) so 007's tombstone of that row can't swallow it.
   */
  add: (input: I, opts?: { id?: string; after?: string }) => Promise<{ saved: boolean; id: string }>
  /** All validated first (none queued if one fails), one stamp, one queue write. */
  addMany: (inputs: readonly I[]) => Promise<{ saved: boolean; ids: string[] }>
  update: (id: string, input: I) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  removeMany: (ids: readonly string[]) => Promise<boolean>
  /** Undo of a delete: an add with the same id stamped just after it (readdStamp), keeping its createdAt (see restoreOp). */
  restore: (row: T) => Promise<boolean>
  retryRefused: () => Promise<boolean>
  discardRefused: () => Promise<void>
  saveAgain: () => Promise<boolean>
  syncNow: () => Promise<void>
}

const RETRY_INTERVAL_MS = 20_000
const REALTIME_DEBOUNCE_MS = 400

/**
 * One simple user-owned table (the expenses, cards or budgets of migration
 * 008), offline-first exactly like the deposits and withdrawals (useMoves),
 * without what only bets and moves have: imports, restores and their Undo.
 * A device cache for instant paint, an outbox shared by every window and
 * replayed in order by the same queue rules, and a full read as the anchor
 * after a drain and on realtime events.
 *
 * The tables come with migration 008, which the app can run ahead of. A read
 * that finds one missing is not an error: there are no rows on the server
 * yet, so the list is empty, nothing is said, and the hook keeps reading on
 * the slow timer to notice the migration. A change made meanwhile waits in
 * the queue ('behind'), never refused, and its refused write says why once
 * per episode, for the three tables together (`notice`). Only a read or a
 * write that goes through proves the table (`tableReady`).
 *
 * The expenses can also wait for migration 009 alone: the table is there and
 * reads fine, but every add and edit names the three columns 009 adds, so
 * the database refuses the write (PGRST204, 'behind' too). It waits the same
 * way, and is sent by itself once 009 has run (`migration009` below).
 */
export function useRowSync<T extends RowBase, I>(o: RowSyncOptions<T, I>): RowSync<T, I> {
  const { table, userId, canSync } = o
  const spec = table.spec

  const [server, setServerState] = useState<T[] | null>(null)
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine)
  const [behind, setBehindState] = useState(false)
  const [paused, setPausedState] = useState(false)
  const [retrying, setRetryingState] = useState(false)
  // A read or a write went through, so the table exists: only then is there
  // anything to subscribe to, and only then may App write what needs 008.
  const [tableReady, setTableReady] = useState(false)
  // The last read found the table missing (mirrors tableMissingRef, for App's banner).
  const [tableMissing, setTableMissing] = useState(false)
  // Rows that reached the server before this device had any snapshot. They
  // keep showing until the first read brings the whole list, but are never
  // cached and never make the list count as loaded.
  const [landed, setLanded] = useState<T[]>([])
  const landedRef = useRef<T[]>([])

  const serverRef = useRef<T[] | null>(null)
  // As useBetSync: what a read out while a change was confirmed lays over what it got.
  const confirmedRef = useRef(confirmedLog<T>())
  // The user whose sync is running, if any, and whether one more was asked for meanwhile.
  const turnsRef = useRef(drainTurns<string>())
  // As useBetSync: what a sync of an earlier user brings back is dropped.
  const userRef = useRef(userId)
  userRef.current = userId
  // The migration notice: App's, shared by the three tables, or this hook's
  // own. This table's episode is its own in it (see sharedMigrationNotice):
  // another table's queue emptying says nothing about this one's.
  const ownNoticeRef = useRef(sharedMigrationNotice())
  const noticeRef = useRef<SharedMigrationNotice>(o.notice ?? ownNoticeRef.current)
  noticeRef.current = o.notice ?? ownNoticeRef.current
  const pausedNoticeRef = useRef(migrationNotice())
  const retryNoticeRef = useRef(migrationNotice())
  const backoffRef = useRef(backoff())
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The last read found the table missing: keep reading until it is there.
  const tableMissingRef = useRef(false)
  const canSyncRef = useRef(canSync)
  canSyncRef.current = canSync
  const onErrorRef = useRef(o.onError)
  onErrorRef.current = o.onError
  const onNoticeRef = useRef(o.onNotice)
  onNoticeRef.current = o.onNotice

  // As useBetSync: confirmations for reads in other windows (see confirmed.ts).
  // Never written once this user is signed out here (a late answer would leave a row behind).
  const shared = useMemo(
    () => (userId ? sharedLog<{ op: PendingOp<I>; row: T | null }>(confirmedKey(userId, spec.name), { canWrite: () => writable(userId) }) : null),
    [userId, spec.name]
  )
  useEffect(() => () => shared?.close(), [shared])

  const queue = useOpQueue<I>({
    userId,
    name: spec.name,
    keys: (uid) => {
      const k = rowKeys(uid, spec.name)
      return { queue: k.outbox, refused: k.refused }
    },
    read: (uid) => readRowOutbox<I>(uid, spec.name),
    save: (uid, q) => saveRowOutbox(uid, spec.name, q),
    readRefused: (uid) => loadRowRefused<I>(uid, spec.name),
    saveRefused: (uid, list) => saveRowRefused(uid, spec.name, list),
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
    (rows: T[]) => {
      if (userRef.current !== userId) return
      serverRef.current = rows
      setServerState(rows)
      if (userId) saveRowCache(userId, spec, rows)
    },
    [userId, spec]
  )

  // A write found the table missing. The hint is shown once, when that is
  // first found (for the three tables together), not on every retry or
  // resume; a request of this table that goes through, or its queue
  // emptying, ends its episode, and the hint's once the last one has ended.
  // Reads never start one.
  const name = spec.name
  const setBehind = useCallback(
    (next: boolean, err?: unknown) => {
      if (next && noticeRef.current.found(name)) onErrorRef.current(err)
      if (!next) noticeRef.current.clear(name)
      setBehindState(next)
    },
    [name]
  )

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

  // The table is there: a read or a write of it went through.
  const proven = useCallback(() => {
    tableMissingRef.current = false
    setTableMissing(false)
    setTableReady(true)
  }, [])

  // As useBetSync: a read the shared log could not vouch for, read again later.
  const rereadRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshRef = useRef<() => Promise<void>>(async () => {})

  /** As useBetSync's readOnce. */
  const readOnce = useCallback(async (): Promise<void> => {
    if (!userId || !canSyncRef.current) return
    if (rereadRef.current) clearTimeout(rereadRef.current)
    rereadRef.current = null
    for (let i = 0; i < MAX_READS; i++) {
      const read = confirmedRef.current.read()
      let elsewhere: Awaited<ReturnType<NonNullable<typeof shared>['begin']>> | null = null
      try {
        elsewhere = shared ? await shared.begin() : null
      } catch (err) {
        // Not out after all: this window's log stops holding changes for it.
        read.end()
        throw err
      }
      let got: T[]
      try {
        got = await table.fetchAll(userId)
      } catch (err) {
        read.end()
        elsewhere?.cancel()
        if (userRef.current !== userId) return
        const failed = afterFailedRead(err, serverRef.current)
        setOffline(failed.offline)
        // Only the missing table changes the snapshot: no table, no rows yet.
        if (failed.server !== null && failed.server !== serverRef.current) setServer(failed.server)
        if (failed.tableMissing) {
          tableMissingRef.current = true
          setTableMissing(true)
        }
        if (failed.report) onErrorRef.current(err)
        return
      }
      if (userRef.current !== userId) {
        read.end()
        elsewhere?.cancel()
        return
      }
      const install = (rows: T[]): void => {
        setServer(rows)
        setOffline(false)
        proven()
        // The table is there, so nothing queued for it waits for it any more. Unless its writes can wait for a column
        // while it reads fine (the expenses and 009): then only a write that goes through ends the wait, or every
        // read would end the episode and the next retry say "your database is behind" again.
        if (!spec.columnsMayLag) setBehind(false)
      }
      let installed = true
      try {
        // Every change confirmed since, in the server's order: this window's from its own log, by tag (see confirmed.ts).
        if (elsewhere) installed = await elsewhere.finish(got, (acc, c) => reconcileRow(spec, acc, c.op, c.row), install, read.since)
        else install(read.over(got))
      } finally {
        read.end()
      }
      if (installed || userRef.current !== userId) return
    }
    rereadRef.current = setTimeout(() => void refreshRef.current(), REREAD_MS)
  }, [userId, table, spec, setServer, setBehind, proven, shared])

  const refresh = useMemo(() => oneAtATime(readOnce, () => userRef.current === userId), [readOnce, userId])
  refreshRef.current = refresh

  useEffect(() => {
    if (!shared) return
    return shared.onGap(() => void refreshRef.current())
  }, [shared])

  const syncNowRef = useRef<() => Promise<void>>(async () => {})

  const syncNow = useCallback(async (): Promise<void> => {
    if (!canSyncRef.current || !userId) return
    if (backoffRef.current.waiting || refusalBlockedRef.current) return
    // A drain is out: one more after it, since it may have read the queue (or
    // met the connection) before what this call is about.
    if (!turnsRef.current.start(userId)) return
    let result: DrainResult | null
    try {
      result = await drain<T>({
        send: (op) => table.send(op, userId),
        applied: async (op, row, superseded) => {
          if (userRef.current !== userId) return
          // An edit that lost, or a budget set again but let go by 007 (see answerNotice).
          const notice = answerNotice(op, row, superseded, spec.stableIds === true)
          if (notice) onNoticeRef.current?.(notice)
          // A request went through: the table is there. The banner and the
          // editors waiting on 008 clear at once.
          proven()
          // Folded only into a snapshot this device has (see foldApplied).
          // The refresh after the drain brings the whole list.
          const change = (rows: readonly T[]): T[] => reconcileRow(spec, rows, op, row)
          const tag = confirmedRef.current.confirmed(change)
          // Into the shared log before anything shows or caches it (see confirmed.ts).
          await shared?.record({ op, row }, tag)
          if (userRef.current !== userId) return
          const next = foldApplied(serverRef.current, landedRef.current, change)
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
      if (turnsRef.current.end(userId)) setTimeout(() => void syncNowRef.current(), 0)
    }
    if (!result || userRef.current !== userId) return
    if (result.stop === 'offline') {
      setOffline(true)
      return
    }
    // The server answered, so the connection is back whatever said otherwise.
    setOffline(false)
    // Each stop says what holds the queue back now (see useMoves).
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
    // A refused change waits for room (see refusalBlocked).
    if (result.stop === 'storage') return
    setBehind(false)
    setPaused(false)
    setRetrying(false)
    // True-up after a drain so the list can never drift from the server.
    if (result.processed > 0 && outboxRef.current.length === 0) await refresh()
  }, [userId, table, spec, drain, outboxRef, setServer, setBehind, setPaused, setRetrying, proven, refresh, shared])
  syncNowRef.current = syncNow

  // Boot: hydrate this user's cache synchronously for instant paint (the
  // queue is useOpQueue's).
  useEffect(() => {
    serverRef.current = null
    tableMissingRef.current = false
    setServerState(null)
    setOffline(false)
    noticeRef.current.clear(spec.name)
    pausedNoticeRef.current.clear()
    retryNoticeRef.current.clear()
    backoffRef.current.reset()
    setBehindState(false)
    setPausedState(false)
    setRetryingState(false)
    setTableReady(false)
    setTableMissing(false)
    landedRef.current = []
    setLanded([])
    confirmedRef.current = confirmedLog<T>()
    if (!userId) return
    const cached = loadRowCache(userId, spec)
    serverRef.current = cached
    if (cached) setServerState(cached)
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
      if (rereadRef.current) clearTimeout(rereadRef.current)
      rereadRef.current = null
    }
  }, [userId, spec])

  // Another window refreshed the cache: show what it got.
  useEffect(() => {
    if (!userId) return
    const key = rowKeys(userId, spec.name).cache
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== key) return
      const rows = loadRowCache(userId, spec)
      if (rows) {
        serverRef.current = rows
        setServerState(rows)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [userId, spec])

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
    const unsubscribe = table.subscribe(userId, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refresh(), REALTIME_DEBOUNCE_MS)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
  }, [userId, canSync, tableReady, table, refresh])

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

  const mutateMany = useCallback(
    async (ops: readonly PendingOp<I>[]): Promise<boolean> => {
      if (ops.length === 0) return true
      const saved = await enqueue(ops)
      setTimeout(() => void syncNowRef.current(), 0)
      return saved
    },
    [enqueue]
  )
  const mutate = useCallback((op: PendingOp<I>) => mutateMany([op]), [mutateMany])

  const add = useCallback(
    async (input: I, opts?: { id?: string; after?: string }): Promise<{ saved: boolean; id: string }> => {
      const op = addOp(spec.normalize, input, opts ?? {}, newId) // throws on bad input, before anything is queued
      return { saved: await mutate(op), id: op.id }
    },
    [spec, mutate]
  )

  const addMany = useCallback(
    async (inputs: readonly I[]): Promise<{ saved: boolean; ids: string[] }> => {
      // All checked before any is queued, one stamp, one queue write.
      const ops = addManyOps(spec.normalize, inputs, newId)
      return { saved: await mutateMany(ops), ids: ops.map((op) => op.id) }
    },
    [spec, mutateMany]
  )

  const update = useCallback(
    async (id: string, input: I): Promise<boolean> => {
      const clean = spec.normalize(input)
      return mutate({ opId: newId(), kind: 'update', id, input: clean, editedAt: new Date().toISOString() })
    },
    [spec, mutate]
  )

  const remove = useCallback((id: string): Promise<boolean> => mutate({ opId: newId(), kind: 'delete', id }), [mutate])

  const removeMany = useCallback(
    (ids: readonly string[]): Promise<boolean> => mutateMany(ids.map((id) => ({ opId: newId(), kind: 'delete', id }))),
    [mutateMany]
  )

  // Async, so bad input rejects the promise rather than throwing (as add does).
  const restore = useCallback(async (row: T): Promise<boolean> => mutate(restoreOp(spec, row, newId)), [spec, mutate])

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

  // Queued changes show even before the first snapshot: an expense added on a
  // device that has never loaded the list is still the user's expense.
  const rows = useMemo(() => applyRowOutbox(spec, server ?? landed, outbox), [spec, server, landed, outbox])

  const status = syncStatus({ canSync, offline, queued: outbox.length, behind, paused, retrying })

  return {
    rows,
    loaded: server !== null,
    tableReady,
    tableMissing,
    status,
    queuedCount: outbox.length,
    blocked: behind && outbox.length > 0,
    unsaved: queue.held && outbox.length > 0,
    refused: queue.refused,
    refusedUnsaved: queue.refusedHeld && queue.refused.length > 0,
    refusalBlocked,
    add,
    addMany,
    update,
    remove,
    removeMany,
    restore,
    retryRefused,
    discardRefused,
    saveAgain,
    syncNow
  }
}

/**
 * What the tables of migration 008 say together. `has008`: a read or a write
 * of one of them went through in this session (positive evidence: anything
 * that would write the expenses' currency or a budget waits for it).
 * `needs008`: a read found one missing and nothing has proved 008 since (the
 * Expenses view's banner). Offline since boot, neither.
 */
export function migration008(tables: readonly Pick<RowSync<unknown, unknown>, 'tableReady' | 'tableMissing'>[]): { has008: boolean; needs008: boolean } {
  const has008 = tables.some((t) => t.tableReady)
  return { has008, needs008: !has008 && tables.some((t) => t.tableMissing) }
}

/**
 * Whether the expenses wait for migration 009 (an expense paid in another
 * currency: three columns every add and edit names). Known only from a write
 * the database refused for them: the expenses table itself has been read or
 * written in this session (so it is not 008 that is missing) and a queued
 * change of it waits for a migration. With nothing queued there is nothing
 * to say, and nothing that waits.
 */
export function migration009(expenses: Pick<RowSync<unknown, unknown>, 'tableReady' | 'blocked'>, needs008: boolean): boolean {
  return !needs008 && expenses.tableReady && expenses.blocked
}

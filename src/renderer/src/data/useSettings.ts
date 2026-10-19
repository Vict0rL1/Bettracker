import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch } from '../../../shared/types'
import {
  afterSettingsAnswer,
  loadSettingsCache,
  loadSettingsOutbox,
  queueKeys,
  saveSettingsCache,
  saveSettingsOutbox,
  type PendingSettings
} from './offline'
import { backoff, migrationNotice, pushSettings, retryPlan, syncStatus, type SettingsPushResult, type SyncStatus } from './drain'
import { classifySyncError, SignedOutError } from './errors'
import { getSettings, saveSettings, subscribeToSettings } from './settings'
import { queueStore, withLock } from './store'

export interface SettingsSync {
  /** Last-known row with any pending edit applied; defaults until the first load. */
  settings: Settings
  /** True while a change is waiting to reach the server. */
  dirty: boolean
  /** True while the database is missing the settings migration: a change waits for it, not for the connection. */
  blocked: boolean
  /**
   * The user's row is known: cached, read, or known not to exist yet (a
   * database without the settings table has only the defaults). Until then
   * `settings` holds defaults, which say nothing about, say, the starting
   * bankroll.
   */
  loaded: boolean
  /** Storage refused the pending change: it is only in this window until it syncs. */
  unsaved: boolean
  /** For the badge, while a change is pending: on its way, or what holds it back. */
  status: SyncStatus
  /** Resolves once the change is pending: true when this device's storage holds it. */
  update: (patch: SettingsPatch) => Promise<boolean>
  saveAgain: () => Promise<boolean>
}

const RETRY_INTERVAL_MS = 20_000

/**
 * Per-user settings, offline-first like the bets but far simpler: there is
 * one row, so the outbox is at most one merged patch, kept in storage and
 * changed under a lock every window shares (see store.ts). Edits apply to the
 * UI at once and are pushed on enqueue, reconnect, resume and a slow retry;
 * the same last-write-wins-by-edit-time rule as bets decides conflicts. An
 * answer settles only the patch that went: what was edited meanwhile stays.
 */
export function useSettings(
  userId: string | null,
  canSync: boolean,
  onError: (err: unknown) => void,
  onNotice?: (code: 'conflict') => void
): SettingsSync {
  const [server, setServerState] = useState<Settings | null>(null)
  const [pending, setPendingState] = useState<PendingSettings | null>(null)
  const [held, setHeld] = useState(false)
  // Edits on their way to storage: on screen at once, before the lock and the
  // write (see store.ts) are through, so what reads the settings next sees them.
  const [storing, setStoring] = useState<SettingsPatch[]>([])
  const [blocked, setBlockedState] = useState(false)
  // What stopped the last push short of an answer: the connection, the
  // session or key, or a server failure that passes. Cleared by an answer.
  const [stopped, setStopped] = useState<'offline' | 'paused' | 'retrying' | null>(null)
  const blockedRef = useRef(false)
  const setBlocked = useCallback((next: boolean) => {
    blockedRef.current = next
    setBlockedState(next)
  }, [])
  const serverRef = useRef<Settings | null>(null)
  const pendingRef = useRef<PendingSettings | null>(null)
  // The user whose push is running, if any.
  const syncingRef = useRef<string | null>(null)
  // As useBetSync: what a sync of an earlier user brings back is dropped.
  const userRef = useRef(userId)
  userRef.current = userId
  const noticeRef = useRef(migrationNotice())
  const failNoticeRef = useRef(migrationNotice())
  const backoffRef = useRef(backoff())
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canSyncRef = useRef(canSync)
  canSyncRef.current = canSync
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const onNoticeRef = useRef(onNotice)
  onNoticeRef.current = onNotice

  const store = useMemo(
    () =>
      userId
        ? queueStore<PendingSettings | null>({
            lock: `bettracker:queue:settings:${userId}`,
            load: () => loadSettingsOutbox(userId),
            save: (p) => saveSettingsOutbox(userId, p)
          })
        : null,
    [userId]
  )

  const setServer = useCallback(
    (s: Settings) => {
      if (userRef.current !== userId) return
      serverRef.current = s
      setServerState(s)
      if (userId) saveSettingsCache(userId, s)
    },
    [userId]
  )
  const mirror = useCallback(
    (p: PendingSettings | null) => {
      if (userRef.current !== userId) return
      pendingRef.current = p
      setPendingState(p)
      setHeld(store?.held ?? false)
    },
    [userId, store]
  )
  const change = useCallback(
    async (fn: (current: PendingSettings | null) => PendingSettings | null) => {
      if (!store) return false
      const r = await store.update(fn)
      mirror(r.value)
      return r.saved
    },
    [store, mirror]
  )

  // A request failed. Unreachable is silent; a missing migration, a key
  // Supabase refuses and a passing server failure are said once per episode,
  // until a request goes through again; a refusal for good, each time.
  const report = useCallback((err: unknown) => {
    const failure = classifySyncError(err)
    if (failure === 'rejected') onErrorRef.current(err)
    else if (failure === 'behind') {
      setBlocked(true)
      if (noticeRef.current.found()) onErrorRef.current(err)
    } else if ((failure === 'retry' || failure === 'paused') && !(err instanceof SignedOutError) && failNoticeRef.current.found()) onErrorRef.current(err)
  }, [setBlocked])
  const reached = useCallback(() => {
    noticeRef.current.clear()
    failNoticeRef.current.clear()
    backoffRef.current.reset()
    setBlocked(false)
    setStopped(null)
  }, [setBlocked])

  const refresh = useCallback(async (): Promise<void> => {
    if (!userId || !canSyncRef.current) return
    try {
      const row = await getSettings(userId)
      if (userRef.current !== userId) return
      reached()
      setServer(row ?? { ...DEFAULT_SETTINGS })
    } catch (err) {
      if (userRef.current !== userId) return
      // A read is retried by the timer anyway: only what it can't fix is said.
      const failure = classifySyncError(err)
      if (failure !== 'retry' && failure !== 'paused') report(err)
    }
  }, [userId, setServer, report, reached])

  const syncNowRef = useRef<() => Promise<void>>(async () => {})

  const syncNow = useCallback(async (): Promise<void> => {
    if (syncingRef.current === userId || !canSyncRef.current || !userId || !store || !pendingRef.current) return
    if (backoffRef.current.waiting) return
    syncingRef.current = userId
    let out: SettingsPushResult | null
    try {
      out = await withLock(`bettracker:drain:settings:${userId}`, () =>
        pushSettings({
          pending: () => store.fresh(),
          settle: async (sent) => void (await change((current) => afterSettingsAnswer(current, sent))),
          save: (p) => saveSettings(p.patch, p.editedAt, userId)
        })
      )
    } finally {
      if (syncingRef.current === userId) syncingRef.current = null
    }
    if (userRef.current !== userId) return
    if (out?.stop === 'saved') {
      reached()
      setServer(out.row)
    } else if (out?.stop === 'conflict') {
      reached()
      onNoticeRef.current?.('conflict')
      await refresh()
    } else if (out?.stop === 'retry') {
      setStopped('retrying')
      report(out.error)
      const wait = backoffRef.current.failed(out.error)
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      retryTimerRef.current = setTimeout(() => void syncNowRef.current(), wait)
    } else if (out?.stop === 'offline') setStopped('offline')
    else if (out?.stop === 'behind' || out?.stop === 'rejected' || out?.stop === 'paused') {
      setStopped(out.stop === 'paused' ? 'paused' : null)
      report(out.error)
    }
    // Answered (saved, beaten or refused): an edit made while it was out is
    // still pending, and goes now.
    if ((out?.stop === 'saved' || out?.stop === 'conflict' || out?.stop === 'rejected') && pendingRef.current) setTimeout(() => void syncNowRef.current(), 0)
  }, [userId, store, change, setServer, refresh, report, reached])
  syncNowRef.current = syncNow

  // Boot from the device cache.
  useEffect(() => {
    serverRef.current = null
    pendingRef.current = null
    noticeRef.current.clear()
    failNoticeRef.current.clear()
    backoffRef.current.reset()
    setBlocked(false)
    setServerState(null)
    setPendingState(null)
    setHeld(false)
    setStoring([])
    setStopped(null)
    if (!userId) return
    const cached = loadSettingsCache(userId)
    const queued = loadSettingsOutbox(userId)
    serverRef.current = cached
    pendingRef.current = queued
    if (cached) setServerState(cached)
    setPendingState(queued)
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [userId, setBlocked])

  // Another window changed the pending patch, or refreshed the cached row.
  useEffect(() => {
    if (!userId || !store) return
    const keys = queueKeys(userId)
    const onStorage = (e: StorageEvent): void => {
      if ((e.key === keys.settings || e.key === null) && !store.held) mirror(store.read())
      if (e.key === keys.settingsCache) {
        const cached = loadSettingsCache(userId)
        if (cached) {
          serverRef.current = cached
          setServerState(cached)
        }
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [userId, store, mirror])

  useEffect(() => {
    if (!userId || !canSync) return
    void syncNow().then(() => refresh())
  }, [userId, canSync, syncNow, refresh])

  useEffect(() => {
    if (!userId || !canSync) return
    return subscribeToSettings(userId, () => void refresh())
  }, [userId, canSync, refresh])

  useEffect(() => {
    if (!userId) return
    const kick = (): void => void syncNow().then(() => refresh())
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') kick()
    }
    const timer = setInterval(() => {
      // Read again while the row has never been read (a failed first read on a
      // connection the browser still thinks is up sends no online event).
      const plan = retryPlan({ queued: pendingRef.current !== null, loaded: serverRef.current !== null || blockedRef.current })
      if (plan === 'read') kick()
      else if (plan === 'drain') void syncNow()
    }, RETRY_INTERVAL_MS)
    window.addEventListener('online', kick)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', kick)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [userId, syncNow, refresh])

  const update = useCallback(
    async (patch: SettingsPatch): Promise<boolean> => {
      const editedAt = new Date().toISOString()
      setStoring((xs) => [...xs, patch])
      try {
        // Merged into what is pending now, other windows' edits included.
        const saved = await change((current) => ({ patch: { ...(current?.patch ?? {}), ...patch }, editedAt }))
        setTimeout(() => void syncNowRef.current(), 0)
        return saved
      } finally {
        setStoring((xs) => xs.filter((x) => x !== patch))
      }
    },
    [change]
  )

  const saveAgain = useCallback(async (): Promise<boolean> => {
    const saved = await change((current) => current)
    if (saved) setTimeout(() => void syncNowRef.current(), 0)
    return saved
  }, [change])

  const settings: Settings = { ...DEFAULT_SETTINGS, ...(server ?? {}), ...(pending?.patch ?? {}), ...Object.assign({}, ...storing) }

  const dirty = pending !== null || storing.length > 0
  const status = syncStatus({ canSync, offline: stopped === 'offline', queued: dirty ? 1 : 0, behind: blocked, paused: stopped === 'paused', retrying: stopped === 'retrying' })

  return { settings, dirty, blocked, loaded: server !== null || blocked, unsaved: held && pending !== null, status, update, saveAgain }
}

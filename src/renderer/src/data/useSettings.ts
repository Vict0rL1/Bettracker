import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch } from '../../../shared/types'
import { loadSettingsCache, loadSettingsOutbox, saveSettingsCache, saveSettingsOutbox, type PendingSettings } from './offline'
import { migrationNotice, pushSettings } from './drain'
import { classifySyncError } from './errors'
import { getSettings, saveSettings, subscribeToSettings } from './settings'

export interface SettingsSync {
  /** Last-known row with any pending edit applied; defaults until the first load. */
  settings: Settings
  /** True while a change is waiting to reach the server. */
  dirty: boolean
  /** True while the database is missing the settings migration: a change waits for it, not for the connection. */
  blocked: boolean
  update: (patch: SettingsPatch) => void
}

const RETRY_INTERVAL_MS = 20_000

/**
 * Per-user settings, offline-first like the bets but far simpler: there is
 * one row, so the outbox is at most one merged patch. Edits apply to the UI
 * at once and are pushed on enqueue, reconnect, resume and a slow retry; the
 * same last-write-wins-by-edit-time rule as bets decides conflicts.
 */
export function useSettings(
  userId: string | null,
  canSync: boolean,
  onError: (err: unknown) => void,
  onNotice?: (code: 'conflict') => void
): SettingsSync {
  const [server, setServerState] = useState<Settings | null>(null)
  const [pending, setPendingState] = useState<PendingSettings | null>(null)
  const [blocked, setBlocked] = useState(false)
  const serverRef = useRef<Settings | null>(null)
  const pendingRef = useRef<PendingSettings | null>(null)
  const syncingRef = useRef(false)
  const noticeRef = useRef(migrationNotice())
  const canSyncRef = useRef(canSync)
  canSyncRef.current = canSync
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const onNoticeRef = useRef(onNotice)
  onNoticeRef.current = onNotice

  const setServer = useCallback(
    (s: Settings) => {
      serverRef.current = s
      setServerState(s)
      if (userId) saveSettingsCache(userId, s)
    },
    [userId]
  )
  const setPending = useCallback(
    (p: PendingSettings | null) => {
      pendingRef.current = p
      setPendingState(p)
      if (userId) saveSettingsOutbox(userId, p)
    },
    [userId]
  )

  // A request failed. Unreachable is silent; a missing migration is said once,
  // not on every retry or resume, until a request goes through again.
  const report = useCallback((err: unknown) => {
    const failure = classifySyncError(err)
    if (failure === 'rejected') onErrorRef.current(err)
    else if (failure === 'behind') {
      setBlocked(true)
      if (noticeRef.current.found()) onErrorRef.current(err)
    }
  }, [])
  const reached = useCallback(() => {
    noticeRef.current.clear()
    setBlocked(false)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    if (!userId || !canSyncRef.current) return
    try {
      const row = await getSettings()
      reached()
      setServer(row ?? { ...DEFAULT_SETTINGS })
    } catch (err) {
      report(err)
    }
  }, [userId, setServer, report, reached])

  const syncNow = useCallback(async (): Promise<void> => {
    if (syncingRef.current || !canSyncRef.current || !userId || !pendingRef.current) return
    syncingRef.current = true
    try {
      const out = await pushSettings({
        pending: () => pendingRef.current,
        setPending,
        save: (p) => saveSettings(p.patch, p.editedAt)
      })
      if (out?.stop === 'saved') {
        reached()
        setServer(out.row)
      } else if (out?.stop === 'conflict') {
        reached()
        onNoticeRef.current?.('conflict')
        await refresh()
      } else if (out?.stop === 'behind' || out?.stop === 'rejected') report(out.error)
    } finally {
      syncingRef.current = false
    }
  }, [userId, setPending, setServer, refresh, report, reached])

  // Boot from the device cache.
  useEffect(() => {
    serverRef.current = null
    pendingRef.current = null
    noticeRef.current.clear()
    setBlocked(false)
    setServerState(null)
    setPendingState(null)
    if (!userId) return
    const cached = loadSettingsCache(userId)
    const queued = loadSettingsOutbox(userId)
    serverRef.current = cached
    pendingRef.current = queued
    if (cached) setServerState(cached)
    setPendingState(queued)
  }, [userId])

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
      if (pendingRef.current) void syncNow()
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
    (patch: SettingsPatch) => {
      const merged: PendingSettings = { patch: { ...(pendingRef.current?.patch ?? {}), ...patch }, editedAt: new Date().toISOString() }
      setPending(merged)
      setTimeout(() => void syncNow(), 0)
    },
    [setPending, syncNow]
  )

  const settings: Settings = { ...DEFAULT_SETTINGS, ...(server ?? {}), ...(pending?.patch ?? {}) }

  return { settings, dirty: pending !== null, blocked, update }
}

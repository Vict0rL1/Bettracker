import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch } from '../../../shared/types'
import {
  afterSettingsAnswer,
  editSettings,
  fieldTime,
  loadSettingsCache,
  loadSettingsOutbox,
  pendingWrite,
  queueKeys,
  saveSettingsCache,
  saveSettingsOutbox,
  supersededBy,
  type PendingSettings
} from './offline'
import { backoff, migrationNotice, pushSettings, retryPlan, settingsReadClears, syncStatus, type SettingsAnswer, type SettingsPushResult, type SyncStatus } from './drain'
import { classifySyncError, SignedOutError } from './errors'
import { getSettings, getSettingsRead, saveSettings, subscribeToSettings } from './settings'
import { journalEntry, journalRemove, newerSettings, replayJournals, type JournalEdit, type SettingsSaveState } from './settingsJournal'
import { freshImports, journalWanted } from './imports'
import { queueStore, withLock } from './store'

export type { SettingsSaveState }

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
  /**
   * Where the last changes are: 'saving' (on screen, not yet stored on this
   * device), 'local' (stored here, waiting for the cloud), 'unsaved' (storage
   * refused them: only in this window), 'synced'.
   */
  saveState: SettingsSaveState
  /** The edits waiting to reach the server, field by field (null: none). */
  pendingPatch: SettingsPatch | null
  /** The operation each pending field's write belongs to (see PendingSettings.fieldOrigin). */
  pendingOrigins: Partial<Record<keyof SettingsPatch, string>>
  /** True while storage refuses the pending patch (it is in this window only). */
  held: boolean
  /**
   * Resolves once the change is pending: true when this device's storage
   * holds it. `guard`: fields that apply only where the server still holds
   * that value (see PendingSettings.guard). `origin`: the operation the write
   * is part of, which hears its answer (see settingsOutcomes); `editedAt`:
   * the time it was made (its generation); `once`: not again when that write
   * is pending already (a resume after the mark was lost).
   */
  update: (patch: SettingsPatch, opts?: { guard?: SettingsPatch; origin?: string; editedAt?: string; once?: boolean }) => Promise<boolean>
  saveAgain: () => Promise<boolean>
  /** The pending patch as stored, read under its lock. */
  queueFresh: () => Promise<PendingSettings | null>
}

/** What a write of an operation came to, field by field (see settingsOutcomes). */
export interface SettingsOutcomeEvent {
  origin: string
  /** When the write was made: its generation. */
  editedAt?: string
  confirmed: (keyof SettingsPatch)[]
  kept: (keyof SettingsPatch)[]
  rejected: (keyof SettingsPatch)[]
  reason?: string
  /**
   * The server's row as known with this answer (null: there is none, the
   * defaults hold), when known: what a kept field holds there, to tell a
   * change made since from a write that just did not land (see App).
   */
  row?: Settings | null
}

/** Equal as settings: numbers within a cent (the server rounds), anything else exactly. */
const sameSetting = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 0.005 : Object.is(a ?? null, b ?? null)

/** One statement a pending patch is sent as (see settingsGroups). */
export interface SettingsGroup {
  origin?: string
  editedAt: string
  patch: SettingsPatch
  guard?: SettingsPatch
}

/**
 * The statements a pending patch is sent as: each operation's write (see
 * PendingSettings.fieldOrigin) at the time it was made, and the user's own
 * fields at the latest time one of them was edited, oldest first. Sent as one
 * at the latest time, an older write — a restore's, or the user's own — would
 * land over a change made on another device after it, only because something
 * else was changed here later.
 */
export function settingsGroups(p: PendingSettings): SettingsGroup[] {
  const by = new Map<string, SettingsGroup>()
  const own: SettingsPatch = {}
  const put = (target: SettingsPatch, k: keyof SettingsPatch, v: unknown): void => {
    ;(target as Record<string, unknown>)[k] = v
  }
  for (const k of Object.keys(p.patch) as (keyof SettingsPatch)[]) {
    const origin = p.fieldOrigin?.[k]
    if (!origin) {
      put(own, k, p.patch[k])
      continue
    }
    const editedAt = fieldTime(p, k)
    const key = `${origin}|${editedAt}`
    const g = by.get(key) ?? { origin, editedAt, patch: {} }
    put(g.patch, k, p.patch[k])
    if (p.guard && k in p.guard) put((g.guard ??= {}), k, p.guard[k])
    by.set(key, g)
  }
  const groups = [...by.values()]
  const ownFields = Object.keys(own) as (keyof SettingsPatch)[]
  if (ownFields.length > 0) {
    const guard = p.guard ? (Object.fromEntries(Object.entries(p.guard).filter(([k]) => k in own)) as SettingsPatch) : undefined
    const editedAt = ownFields.map((k) => fieldTime(p, k)).reduce((a, b) => (b > a ? b : a))
    groups.push({ editedAt, patch: own, ...(guard && Object.keys(guard).length > 0 ? { guard } : {}) })
  }
  // Oldest first: a statement made later never makes an earlier one lose.
  return groups.sort((a, b) => (a.editedAt < b.editedAt ? -1 : a.editedAt > b.editedAt ? 1 : 0))
}

/** What one statement of a patch came to: the row it answered with (null: a newer edit won), or a refusal. */
export interface GroupAnswer {
  origin?: string
  fields: (keyof SettingsPatch)[]
  row?: Settings | null
  error?: unknown
}

/**
 * Send a pending patch statement by statement (see settingsGroups), each
 * answer into `answers` as it comes. A statement the server refuses for good
 * does not stop the others; the refusal is thrown once they are through (the
 * patch is let go, as a refused one is). Any other failure stops it there: the
 * patch stays, and goes again whole. Resolves with the last row, or null when
 * a statement lost to a newer edit (a conflict: the caller reads the row).
 */
export async function saveGroups(
  p: PendingSettings,
  save: (patch: SettingsPatch, editedAt: string, guard?: SettingsPatch) => Promise<Settings | null>,
  answers: GroupAnswer[]
): Promise<Settings | null> {
  let last: Settings | null = null
  let beaten = false
  let refused: { error: unknown } | null = null
  for (const g of settingsGroups(p)) {
    const fields = Object.keys(g.patch) as (keyof SettingsPatch)[]
    try {
      const row = await save(g.patch, g.editedAt, g.guard)
      answers.push({ ...(g.origin ? { origin: g.origin } : {}), fields, row })
      if (row) last = row
      else beaten = true
    } catch (err) {
      if (classifySyncError(err) !== 'rejected') throw err
      answers.push({ ...(g.origin ? { origin: g.origin } : {}), fields, error: err })
      refused ??= { error: err }
    }
  }
  if (refused) throw refused.error
  return beaten ? null : last
}

/**
 * The answer to a sent patch, for each operation that wrote some of it (see
 * PendingSettings.fieldOrigin), by the time each write was made: a field the
 * saved row holds as written is confirmed; one it holds otherwise, or a patch
 * beaten by a newer edit, kept (a later change won, or the write did not
 * land: App tells them apart by `row`); a refusal, rejected. A field the user
 * set (no origin) is nobody's to hear. `groups`: the answer of each statement
 * (see saveGroups), over the patch's; `latest`: the row read after a
 * statement lost (null: none). A statement that lost while the row could not
 * be read tells nothing of its fields: without the row, "changed later" and
 * "did not land" can't be told apart, and Check again asks the server.
 */
export function settingsOutcomes(
  sent: PendingSettings,
  out: SettingsAnswer,
  opts: { groups?: readonly GroupAnswer[]; latest?: Settings | null } = {}
): SettingsOutcomeEvent[] {
  const by = new Map<string, SettingsOutcomeEvent>()
  const answerOf = (k: keyof SettingsPatch): SettingsAnswer => {
    const g = opts.groups?.find((x) => x.fields.includes(k))
    if (!g) return out
    if (g.error !== undefined) return { stop: 'rejected', error: g.error }
    return g.row ? { stop: 'saved', row: g.row } : { stop: 'conflict' }
  }
  for (const k of Object.keys(sent.patch) as (keyof SettingsPatch)[]) {
    const origin = sent.fieldOrigin?.[k]
    if (!origin) continue
    const editedAt = fieldTime(sent, k)
    const key = `${origin}|${editedAt}`
    const a = answerOf(k)
    const e: SettingsOutcomeEvent = by.get(key) ?? { origin, editedAt, confirmed: [], kept: [], rejected: [] }
    if (a.stop === 'rejected') {
      e.rejected.push(k)
      e.reason ??= a.error instanceof Error ? a.error.message : String(a.error)
    } else if (a.stop === 'saved') {
      if (sameSetting(a.row[k as keyof Settings], sent.patch[k])) e.confirmed.push(k)
      else e.kept.push(k)
      e.row = a.row
    } else {
      // Lost, and the row is not known: no answer for it (see above).
      if (opts.groups && opts.latest === undefined) continue
      e.kept.push(k)
      if (opts.latest !== undefined && e.row === undefined) e.row = opts.latest
    }
    by.set(key, e)
  }
  return [...by.values()]
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
  onNotice?: (code: 'conflict') => void,
  onOutcome?: (e: SettingsOutcomeEvent) => void | Promise<void>
): SettingsSync {
  const [server, setServerState] = useState<Settings | null>(null)
  const [pending, setPendingState] = useState<PendingSettings | null>(null)
  const [held, setHeld] = useState(false)
  // Edits on their way to storage: on screen at once, before the lock and the
  // write (see store.ts) are through, so what reads the settings next sees them.
  // `journaled`: written to this window's journal meanwhile (see
  // settingsJournal.ts), so stored on this device even before the lock.
  const [storing, setStoring] = useState<{ patch: SettingsPatch; journaled: boolean }[]>([])
  // An edit storage refused that the journal did not take either.
  const [journalFailed, setJournalFailed] = useState(false)
  // Journal entries of edits the queue's storage refused (held in this
  // window): out of the journal once the queue is stored.
  const heldJournalRef = useRef<JournalEdit[]>([])
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
  const onOutcomeRef = useRef(onOutcome)
  onOutcomeRef.current = onOutcome
  // An operation's write answered: into its history. Never in the way of the sync.
  const tellOutcome = useCallback(async (e: SettingsOutcomeEvent): Promise<void> => {
    if (userRef.current !== userId) return
    try {
      await onOutcomeRef.current?.(e)
    } catch {
      // The history is not in the way of the settings.
    }
  }, [userId])

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

  // Only ever forward: a read answered before a save landed (or before the
  // row existed, as none) must not put back what the save replaced, here or
  // in the cache other windows show (see newerSettings).
  const setServer = useCallback(
    (s: Settings) => {
      if (userRef.current !== userId) return
      if (!newerSettings(serverRef.current, s)) return
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
      const read = await getSettingsRead(userId)
      if (userRef.current !== userId) return
      // The table is there. Whatever stops the writes is theirs to clear,
      // except a missing column a queued patch needs: a read of the table
      // doesn't add the currency column of 008 (the first one added after
      // 004), so the patch that names it still can't go, and saying so again
      // on every resume, or "Syncing" for a write that can't go, would be
      // wrong (see settingsReadClears).
      if (settingsReadClears(read.hasCurrencyColumn, pendingRef.current)) {
        noticeRef.current.clear()
        setBlocked(false)
      }
      setServer(read.settings ?? { ...DEFAULT_SETTINGS })
    } catch (err) {
      if (userRef.current !== userId) return
      // A read is retried by the timer anyway: only what it can't fix is said.
      const failure = classifySyncError(err)
      if (failure !== 'retry' && failure !== 'paused') report(err)
    }
  }, [userId, setServer, report, setBlocked])

  const syncNowRef = useRef<() => Promise<void>>(async () => {})

  const syncNow = useCallback(async (): Promise<void> => {
    if (syncingRef.current === userId || !canSyncRef.current || !userId || !store || !pendingRef.current) return
    if (backoffRef.current.waiting) return
    syncingRef.current = userId
    let out: SettingsPushResult | null
    // What each statement of the patch came to (see saveGroups).
    const answers: GroupAnswer[] = []
    try {
      out = await withLock(`bettracker:drain:settings:${userId}`, () =>
        pushSettings({
          pending: () => store.fresh(),
          settle: async (sent) => void (await change((current) => afterSettingsAnswer(current, sent))),
          // Statement by statement: each operation's write at its own time (see settingsGroups).
          save: (p) => saveGroups(p, (patch, editedAt, guard) => saveSettings(patch, editedAt, userId, guard), answers),
          answered: async (sent, answer) => {
            // A write that lost: the row as it is now tells a change made since from one that did not land.
            const lost = answers.some((g) => g.row === null && g.origin !== undefined)
            const latest = lost ? await getSettings(userId).catch(() => undefined) : undefined
            for (const e of settingsOutcomes(sent, answer, { groups: answers, ...(latest !== undefined ? { latest } : {}) })) await tellOutcome(e)
          }
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
  }, [userId, store, change, setServer, refresh, report, reached, tellOutcome])
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
    setJournalFailed(false)
    heldJournalRef.current = []
    setStopped(null)
    if (!userId) return
    const cached = loadSettingsCache(userId)
    const queued = loadSettingsOutbox(userId)
    serverRef.current = cached
    pendingRef.current = queued
    if (cached) setServerState(cached)
    setPendingState(queued)
    // Edits a window closed (or reloaded) before it could queue them, kept in
    // its journal: queued now, then out of the journal.
    let live = true
    void replayJournals(userId, async (all) => {
      if (!live || !store) return false
      // An operation's write only while that part is still to be queued (see journalWanted).
      const history = all.some((e) => e.origin) ? await freshImports(userId) : []
      const edits = all.filter((e) => journalWanted(history, e))
      if (edits.length === 0) return true
      const r = await store.update((current) => edits.reduce<PendingSettings | null>((acc, e) => editSettings(acc, e.patch, e.editedAt, e.guard, e.origin), current))
      if (live) mirror(r.value)
      if (r.saved) setTimeout(() => void syncNowRef.current(), 0)
      return r.saved
    })
    return () => {
      live = false
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [userId, setBlocked, store, mirror])

  // Another window changed the pending patch, or refreshed the cached row.
  useEffect(() => {
    if (!userId || !store) return
    const keys = queueKeys(userId)
    const onStorage = (e: StorageEvent): void => {
      if ((e.key === keys.settings || e.key === null) && !store.held) mirror(store.read())
      if (e.key === keys.settingsCache) {
        const cached = loadSettingsCache(userId)
        // Another window's copy, unless this one already knows a newer row.
        if (cached && newerSettings(serverRef.current, cached)) {
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
    async (patch: SettingsPatch, opts: { guard?: SettingsPatch; origin?: string; editedAt?: string; once?: boolean } = {}): Promise<boolean> => {
      if (!userId) return false
      const editedAt = opts.editedAt ?? new Date().toISOString()
      // Into this window's journal first, at once: the queue waits for a lock
      // other windows share, and a reload or a closed window meanwhile must
      // not lose the edit (the next start queues it, see replayJournals).
      const entry = journalEntry(userId, { patch, editedAt, ...(opts.guard ? { guard: opts.guard } : {}), ...(opts.origin ? { origin: opts.origin } : {}) })
      const item = { patch, journaled: entry !== null }
      setStoring((xs) => [...xs, item])
      // Decided once, on the patch as stored then (the change may be replayed, see store.ts).
      let decided: { skip: boolean; superseded: ReturnType<typeof supersededBy> } | null = null
      try {
        // Merged into what is pending now, other windows' edits included,
        // field by field by edit time (see editSettings).
        const saved = await change((current) => {
          decided ??= {
            skip: opts.once === true && opts.origin !== undefined && pendingWrite(current, opts.origin, editedAt),
            superseded: supersededBy(current, patch, editedAt, opts.origin)
          }
          return decided.skip ? current : editSettings(current, patch, editedAt, opts.guard, opts.origin)
        })
        // Writes of operations this edit replaced before they went: a later change won.
        const replaced = decided as { skip: boolean; superseded: ReturnType<typeof supersededBy> } | null
        if (replaced && !replaced.skip) for (const x of replaced.superseded) await tellOutcome({ origin: x.origin, editedAt: x.editedAt, confirmed: [], kept: x.fields, rejected: [] })
        // In the queue's storage now (with any edit held before it): out of
        // the journal. Storage refused the queue: the journal keeps it on
        // this device until the queue is stored.
        if (saved) {
          journalRemove(userId, [...(entry ? [entry] : []), ...heldJournalRef.current])
          heldJournalRef.current = []
          setJournalFailed(false)
        } else if (entry) heldJournalRef.current = [...heldJournalRef.current, entry]
        else setJournalFailed(true)
        setTimeout(() => void syncNowRef.current(), 0)
        // The user's edit, journaled, is on this device (the next start queues
        // it). An operation's is held: its journal entry is replayed only while
        // the operation says so (see journalWanted), and it says so for held.
        return opts.origin !== undefined ? saved : saved || entry !== null
      } finally {
        setStoring((xs) => xs.filter((x) => x !== item))
      }
    },
    [userId, change, tellOutcome]
  )

  const saveAgain = useCallback(async (): Promise<boolean> => {
    const saved = await change((current) => current)
    if (saved) {
      setJournalFailed(false)
      // What the journal kept while storage refused the queue is in it now.
      if (userId) journalRemove(userId, heldJournalRef.current)
      heldJournalRef.current = []
      setTimeout(() => void syncNowRef.current(), 0)
    }
    return saved
  }, [change, userId])

  const settings: Settings = { ...DEFAULT_SETTINGS, ...(server ?? {}), ...(pending?.patch ?? {}), ...Object.assign({}, ...storing.map((x) => x.patch)) }

  const dirty = pending !== null || storing.length > 0
  const status = syncStatus({ canSync, offline: stopped === 'offline', queued: dirty ? 1 : 0, behind: blocked, paused: stopped === 'paused', retrying: stopped === 'retrying' })
  const unsaved = held && pending !== null && journalFailed
  const saveState: SettingsSaveState = unsaved
    ? 'unsaved'
    : storing.some((x) => !x.journaled)
      ? 'saving'
      : dirty
        ? 'local'
        : 'synced'

  const pendingPatch = pending || storing.length > 0 ? { ...(pending?.patch ?? {}), ...Object.assign({}, ...storing.map((x) => x.patch)) } : null
  const pendingOrigins = useMemo(() => ({ ...(pending?.fieldOrigin ?? {}) }), [pending])
  const queueFresh = useCallback(async (): Promise<PendingSettings | null> => (store ? store.fresh() : pendingRef.current), [store])

  return { settings, dirty, blocked, loaded: server !== null || blocked, unsaved, status, saveState, pendingPatch, pendingOrigins, held, update, saveAgain, queueFresh }
}

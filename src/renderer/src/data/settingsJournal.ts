import type { Settings, SettingsPatch } from '../../../shared/types'
import { WINDOW_ID } from './confirmed'
import { settingsJournalPrefix } from './offline'
import { writeDurable } from './store'

/**
 * Where a settings change is, as the settings dialog says it:
 *  - 'saving':  on screen, not yet stored on this device;
 *  - 'local':   stored on this device, waiting to reach the cloud;
 *  - 'unsaved': storage refused it: only in this window until it syncs;
 *  - 'synced':  nothing waiting.
 */
export type SettingsSaveState = 'saving' | 'local' | 'unsaved' | 'synced'

/**
 * A settings edit goes into the queue under a lock every window shares (see
 * store.ts), which another window may hold for a moment (seconds, when
 * IndexedDB is slow to answer). An edit waiting for it is only in memory: a
 * reload or a closed window then would lose it. So each edit is first
 * written, at once and without the lock, to a journal of this window's own,
 * and taken out once the queue holds it. A window that starts queues what a
 * closed window left in its journal (editSettings merges by edit time, so an
 * edit queued twice is queued once).
 *
 * Each window holds a lock named after it while it is open, so a starting
 * window leaves the journals of open ones to them. Where Web Locks are
 * missing every journal is taken, open windows' too: harmless, as above.
 */
export interface JournalEdit {
  patch: SettingsPatch
  editedAt: string
  guard?: SettingsPatch
}

const windowLock = (id: string): string => `bettracker:window:${id}`
let holding = false

/** Hold this window's lock until it closes. */
function holdWindowLock(): void {
  if (holding) return
  holding = true
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (locks && typeof locks.request === 'function') void locks.request(windowLock(WINDOW_ID), () => new Promise<void>(() => {}))
}
holdWindowLock()

const keyOf = (userId: string, win: string = WINDOW_ID): string => settingsJournalPrefix(userId) + win

function read(key: string): JournalEdit[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    return Array.isArray(raw) ? (raw as JournalEdit[]).filter((e) => typeof e?.editedAt === 'string' && typeof e.patch === 'object' && e.patch !== null) : []
  } catch {
    return []
  }
}

const same = (a: JournalEdit, b: JournalEdit): boolean => a.editedAt === b.editedAt && JSON.stringify(a.patch) === JSON.stringify(b.patch)

/** Write an edit to this window's journal. Null when storage refused it. */
export function journalEntry(userId: string, edit: JournalEdit): JournalEdit | null {
  try {
    writeDurable(keyOf(userId), [...read(keyOf(userId)), edit])
    return edit
  } catch {
    return null
  }
}

/** Take these edits out of a journal (this window's unless `win` names another). */
export function journalRemove(userId: string, edits: readonly JournalEdit[], win: string = WINDOW_ID): void {
  const key = keyOf(userId, win)
  try {
    const left = read(key).filter((e) => !edits.some((x) => same(x, e)))
    if (left.length === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(left))
  } catch {
    // Left in the journal: queued once more next time, which changes nothing.
  }
}

/** The windows open now, by their locks; null where that can't be known. */
async function openWindows(): Promise<Set<string> | null> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks || typeof locks.query !== 'function') return null
  try {
    const snap = await locks.query()
    const names = [...(snap.held ?? []), ...(snap.pending ?? [])].map((l) => l.name ?? '')
    return new Set(names.filter((n) => n.startsWith(windowLock(''))).map((n) => n.slice(windowLock('').length)))
  } catch {
    return null
  }
}

/**
 * Queue what journals hold (`apply` resolves true once the queue's storage
 * holds them), then take them out: closed windows' journals, or with `own`
 * this window's.
 */
export async function replayJournals(userId: string, apply: (edits: JournalEdit[]) => Promise<boolean>, opts: { own?: boolean } = {}): Promise<void> {
  const prefix = settingsJournalPrefix(userId)
  const open = opts.own ? null : await openWindows()
  const wins: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(prefix)) wins.push(k.slice(prefix.length))
    }
  } catch {
    return
  }
  for (const win of wins) {
    if (opts.own ? win !== WINDOW_ID : win === WINDOW_ID || open?.has(win)) continue
    const edits = read(keyOf(userId, win))
    if (edits.length === 0) continue
    if (await apply(edits)) journalRemove(userId, edits, win)
  }
}

/**
 * Whether `incoming` may replace `current` as the server's row: only forward
 * in time. Every save moves `updated_at` forward (see saveSettings), so a
 * row with an earlier one is a read answered before a save landed, and "no
 * row" (the defaults, no `updated_at`) is older than any row.
 */
export function newerSettings(current: Settings | null, incoming: Settings): boolean {
  if (!current) return true
  const now = Date.parse(current.updatedAt)
  if (!Number.isFinite(now)) return true
  const next = Date.parse(incoming.updatedAt)
  return Number.isFinite(next) && next >= now
}

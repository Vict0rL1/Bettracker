import { isBetStatus, type BetStatus } from '../../../shared/types'
import { draftKey } from './offline'

/**
 * Unfinished forms. Closing a form by accident (Escape, a tap on the
 * backdrop, a reload) keeps what was typed: it opens again with it, and only
 * a save or an explicit Discard lets it go.
 *
 * The quick add keeps one draft; the day's form one per day for a new bet
 * and one per bet being edited (the newest MAX_DAY_DRAFTS), so starting on
 * another day never overwrites the first. In localStorage; where storage
 * refuses them they are kept in this window instead, so a closed form still
 * opens with its draft. A sign-out forgets both (clearUserData, forgetDrafts).
 */

/** The quick add, as typed. */
export interface QuickDraft {
  stake: string
  odds: string
  sport: string
  book: string
  betType: string
  profit: string
}

/** The day's form: a new bet for `date`, or the edit of `editingId`. */
export interface DayDraft {
  /** When it was last typed in: the oldest go first past MAX_DAY_DRAFTS. */
  savedAt: string
  date: string
  editingId: string | null
  status: BetStatus
  amount: string
  stake: string
  odds: string
  closing: string
  note: string
  sport: string
  book: string
  betType: string
}

/** The newest day drafts kept; an older one goes when another is started. */
export const MAX_DAY_DRAFTS = 20

const QUICK_FIELDS = ['stake', 'odds', 'sport', 'book', 'betType', 'profit'] as const
const DAY_FIELDS = ['savedAt', 'date', 'amount', 'stake', 'odds', 'closing', 'note', 'sport', 'book', 'betType'] as const

const memory = new Map<string, unknown>()

const hasStrings = (r: Record<string, unknown>, fields: readonly string[]): boolean => fields.every((f) => typeof r[f] === 'string')
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** What storage holds, if it is a quick draft: an older or hand-edited value is none. */
const validQuick = (raw: unknown): QuickDraft | null => (isRecord(raw) && hasStrings(raw, QUICK_FIELDS) ? (raw as unknown as QuickDraft) : null)

const validDay = (raw: unknown): raw is DayDraft =>
  isRecord(raw) && hasStrings(raw, DAY_FIELDS) && isBetStatus(raw.status) && (raw.editingId === null || typeof raw.editingId === 'string')

function readSlot(key: string): unknown {
  if (memory.has(key)) return memory.get(key)
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? null : JSON.parse(raw)
  } catch {
    return null
  }
}

function writeSlot(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
    // Stored: every window reads it from there.
    memory.delete(key)
  } catch {
    // Kept in this window only (see above).
    memory.set(key, value)
  }
}

export const loadQuickDraft = (userId: string): QuickDraft | null => validQuick(readSlot(draftKey(userId, 'quick')))

/** Keep the quick draft, or let it go (null). */
export const saveQuickDraft = (userId: string, draft: QuickDraft | null): void => writeSlot(draftKey(userId, 'quick'), draft)

/** Where a day draft is filed: a new bet on its date, or the bet it edits. */
export const dayDraftId = (date: string, editingId: string | null): string => (editingId === null ? `new:${date}` : `edit:${editingId}`)

/** Every day draft kept, newest first. */
export function loadDayDrafts(userId: string): DayDraft[] {
  const raw = readSlot(draftKey(userId, 'day'))
  if (!isRecord(raw)) return []
  return Object.values(raw)
    .filter(validDay)
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
}

/** The draft of a new bet on `date`, or of the edit of `editingId`. */
export const loadDayDraft = (userId: string, date: string, editingId: string | null): DayDraft | null =>
  loadDayDrafts(userId).find((d) => dayDraftId(d.date, d.editingId) === dayDraftId(date, editingId)) ?? null

/** Keep a day draft (filed by its date or bet), or let the one at `id` go (null). */
export function saveDayDraft(userId: string, id: string, draft: DayDraft | null): void {
  const rest = loadDayDrafts(userId).filter((d) => dayDraftId(d.date, d.editingId) !== id)
  const next = (draft ? [draft, ...rest] : rest).slice(0, MAX_DAY_DRAFTS)
  writeSlot(draftKey(userId, 'day'), next.length === 0 ? null : Object.fromEntries(next.map((d) => [dayDraftId(d.date, d.editingId), d])))
}

/** Signed out: this window forgets the user's drafts too. */
export function forgetDrafts(userId: string): void {
  memory.delete(draftKey(userId, 'quick'))
  memory.delete(draftKey(userId, 'day'))
}

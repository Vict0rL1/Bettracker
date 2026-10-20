import { importsKey } from './offline'

/**
 * The imports made on this device: which file, when, and the ids of the bets
 * each one added, so a whole import can be undone later (the bets it added
 * that are still there are deleted, through the outbox like any delete), and
 * the same file picked again is recognised. The ids are this device's own:
 * an import is one queued op whose rows get their ids here (see importBets).
 *
 * Kept in localStorage per user, the newest MAX_IMPORTS; where storage
 * refuses them they are kept in this window only. Losing this list loses
 * the Undo of an old import, never a bet.
 */
export interface ImportBatch {
  /** The queued op that carries it: while it is still in the outbox, the import is on its way. */
  id: string
  at: string
  file: string
  fingerprint: string
  ids: string[]
  /** A backup restored: the deposits and withdrawals it added, which its Undo deletes too. */
  moveIds?: string[]
  /** 'restore' for a backup; an import of a CSV otherwise. */
  kind?: 'restore'
  /** Undone: its bets were deleted (or were already gone). */
  undone?: boolean
}

export const MAX_IMPORTS = 20

const memory = new Map<string, ImportBatch[]>()

const isBatch = (v: unknown): v is ImportBatch => {
  if (typeof v !== 'object' || v === null) return false
  const b = v as Record<string, unknown>
  return (
    typeof b.id === 'string' &&
    typeof b.at === 'string' &&
    typeof b.file === 'string' &&
    typeof b.fingerprint === 'string' &&
    Array.isArray(b.ids) &&
    b.ids.every((id) => typeof id === 'string')
  )
}

/** This user's imports, newest first. */
export function loadImports(userId: string): ImportBatch[] {
  const key = importsKey(userId)
  const kept = memory.get(key)
  if (kept) return kept
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter(isBatch) : []
  } catch {
    return []
  }
}

function save(userId: string, list: ImportBatch[]): void {
  const key = importsKey(userId)
  const next = list.slice(0, MAX_IMPORTS)
  try {
    localStorage.setItem(key, JSON.stringify(next))
    // Stored: every window reads it from there.
    memory.delete(key)
  } catch {
    // Kept in this window only (see above).
    memory.set(key, next)
  }
}

export function recordImport(userId: string, batch: ImportBatch): void {
  save(userId, [batch, ...loadImports(userId).filter((b) => b.id !== batch.id)])
}

export function markUndone(userId: string, id: string, undone = true): void {
  save(
    userId,
    loadImports(userId).map((b) => (b.id === id ? { ...b, undone } : b))
  )
}

/** Signed out: this window forgets the user's imports too (clearUserData clears storage). */
export function forgetImports(userId: string): void {
  memory.delete(importsKey(userId))
}

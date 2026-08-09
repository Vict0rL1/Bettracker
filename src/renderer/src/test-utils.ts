import type { BetEntry } from '../../shared/types'

let seq = 0

/**
 * A bet entry with sensible defaults, so each test only states the fields it
 * actually cares about. `createdAt` increments so same-day ordering is stable.
 */
export function entry(over: Partial<BetEntry> = {}): BetEntry {
  seq++
  const date = over.date ?? '2026-01-01'
  return {
    id: over.id ?? `e${seq}`,
    date,
    amount: over.amount ?? 0,
    stake: over.stake === undefined ? null : over.stake,
    note: over.note ?? '',
    sport: over.sport ?? '',
    book: over.book ?? '',
    betType: over.betType ?? '',
    createdAt: over.createdAt ?? `${date}T${String(seq % 24).padStart(2, '0')}:00:00.000Z`,
    updatedAt: over.updatedAt ?? `${date}T${String(seq % 24).padStart(2, '0')}:00:00.000Z`
  }
}

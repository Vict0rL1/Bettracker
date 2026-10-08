import { statusForAmount, type Bet } from '../../shared/types'

let seq = 0

/**
 * A bet with sensible defaults, so each test only states the fields it
 * actually cares about. Status follows the amount unless given; a bet asked
 * to be pending gets no amount, whatever was passed. `createdAt` increments
 * so same-day ordering is stable.
 */
export function bet(over: Partial<Bet> = {}): Bet {
  seq++
  const date = over.date ?? '2026-01-01'
  const status = over.status ?? statusForAmount(over.amount ?? 0)
  const amount = status === 'pending' ? null : (over.amount ?? 0)
  return {
    id: over.id ?? `b${seq}`,
    date,
    amount,
    stake: over.stake === undefined ? null : over.stake,
    odds: over.odds === undefined ? null : over.odds,
    status,
    note: over.note ?? '',
    sport: over.sport ?? '',
    book: over.book ?? '',
    betType: over.betType ?? '',
    createdAt: over.createdAt ?? `${date}T${String(seq % 24).padStart(2, '0')}:00:00.000Z`,
    updatedAt: over.updatedAt ?? `${date}T${String(seq % 24).padStart(2, '0')}:00:00.000Z`
  }
}

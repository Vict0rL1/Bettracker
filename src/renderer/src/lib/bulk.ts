import type { Bet, BetInput, BetStatus } from '../../../shared/types'
import { suggestedAmount } from './validate'

/** A bet's editable fields, as the form and the outbox take them. */
export const toInput = (b: Bet): BetInput => ({
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
})

export interface Change {
  id: string
  input: BetInput
}

/**
 * A bulk edit and its exact reverse. `next` is what to write; `prev` is what
 * each touched bet looked like before, so Undo is just writing `prev` back
 * through the same outbox — which is why it works offline.
 */
export interface Plan {
  next: Change[]
  prev: Change[]
}

/** Tags to set; a missing key leaves that tag alone. */
export interface TagPatch {
  sport?: string
  book?: string
  betType?: string
}

/** Retag the given bets, touching only the ones that actually change. */
export function retagPlan(bets: readonly Bet[], patch: TagPatch): Plan {
  const next: Change[] = []
  const prev: Change[] = []
  for (const b of bets) {
    const input = { ...toInput(b), ...patch }
    if (input.sport === b.sport && input.book === b.book && input.betType === b.betType) continue
    next.push({ id: b.id, input })
    prev.push({ id: b.id, input: toInput(b) })
  }
  return { next, prev }
}

export interface SettlePlan extends Plan {
  /** Pending wins without odds: their profit can't be worked out, so they are left alone. */
  skipped: number
}

/** Settle the pending bets among the given ones with the result their stake and odds imply. */
export function settlePlan(bets: readonly Bet[], status: Exclude<BetStatus, 'pending'>): SettlePlan {
  const next: Change[] = []
  const prev: Change[] = []
  let skipped = 0
  for (const b of bets) {
    if (b.status !== 'pending') continue
    const amount = suggestedAmount(status, b.stake, b.odds)
    if (status === 'won' && amount === null) {
      skipped++
      continue
    }
    next.push({ id: b.id, input: { ...toInput(b), status, amount } })
    prev.push({ id: b.id, input: toInput(b) })
  }
  return { next, prev, skipped }
}

import type { EntryInput } from '../../../shared/types'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Single source of truth for the amount ceiling — the form and the writer agree. */
export const MAX_AMOUNT = 100_000_000
export const MAX_NOTE_LENGTH = 500
export const MAX_TAG_LENGTH = 40

export function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false
  const [y, m, d] = date.split('-').map(Number)
  const parsed = new Date(y, m - 1, d)
  return parsed.getFullYear() === y && parsed.getMonth() === m - 1 && parsed.getDate() === d
}

export const round2 = (n: number): number => Math.round(n * 100) / 100

/** Tags are free text: collapse whitespace, cap the length, keep the user's casing. */
function cleanTag(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH)
}

export interface CleanEntry {
  date: string
  amount: number
  stake: number | null
  note: string
  sport: string
  book: string
  betType: string
}

/** Validate and clean a raw entry before it is written to the backend. Throws on bad input. */
export function normalizeInput(input: EntryInput): CleanEntry {
  if (!isValidDate(input.date)) {
    throw new Error(`"${input.date}" is not a valid calendar date`)
  }
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount)) {
    throw new Error('Amount must be a finite number')
  }
  if (Math.abs(input.amount) > MAX_AMOUNT) {
    throw new Error('Amount is out of range')
  }

  // Undefined/null both mean "not recorded" and stay null — only a real number
  // becomes a stake, so ROI is never computed against a value nobody entered.
  let stake: number | null = null
  if (input.stake !== undefined && input.stake !== null) {
    if (typeof input.stake !== 'number' || !Number.isFinite(input.stake)) {
      throw new Error('Stake must be a finite number')
    }
    if (input.stake < 0) {
      throw new Error('Stake cannot be negative — it is the amount you risked')
    }
    if (input.stake > MAX_AMOUNT) {
      throw new Error('Stake is out of range')
    }
    stake = round2(input.stake)
  }

  return {
    date: input.date,
    amount: round2(input.amount),
    stake,
    note: (input.note ?? '').trim().slice(0, MAX_NOTE_LENGTH),
    sport: cleanTag(input.sport),
    book: cleanTag(input.book),
    betType: cleanTag(input.betType)
  }
}

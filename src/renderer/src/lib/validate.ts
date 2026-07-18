import type { EntryInput } from '../../../shared/types'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_AMOUNT = 100_000_000
const MAX_NOTE_LENGTH = 500

export function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false
  const [y, m, d] = date.split('-').map(Number)
  const parsed = new Date(y, m - 1, d)
  return parsed.getFullYear() === y && parsed.getMonth() === m - 1 && parsed.getDate() === d
}

/** Validate and clean a raw entry before it is written to the backend. Throws on bad input. */
export function normalizeInput(input: EntryInput): { date: string; amount: number; note: string } {
  if (!isValidDate(input.date)) {
    throw new Error(`"${input.date}" is not a valid calendar date`)
  }
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount)) {
    throw new Error('Amount must be a finite number')
  }
  if (Math.abs(input.amount) > MAX_AMOUNT) {
    throw new Error('Amount is out of range')
  }
  return {
    date: input.date,
    amount: Math.round(input.amount * 100) / 100,
    note: (input.note ?? '').trim().slice(0, MAX_NOTE_LENGTH)
  }
}

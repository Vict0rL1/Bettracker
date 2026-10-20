import type { Bet, BetInput } from '../../../shared/types'
import type { ImportResult, Rejection } from './csv'
import { normalizeInput, type CleanBet } from './validate'

/** One row of a file, as it would be imported. */
export interface PlannedRow {
  /** Its line in the file (the header is line 1). */
  line: number
  input: BetInput
}

/**
 * What an import would do, for the review step: the rows that go in, the
 * ones that look like bets already here, and the lines that can't go in.
 */
export interface ImportPlan {
  /** Rows that match nothing already here. */
  fresh: PlannedRow[]
  /**
   * Rows that match a bet already here. Each existing bet is matched at most
   * once: a file with two identical rows against one bet here has one fresh
   * row and one possible duplicate.
   */
  duplicates: PlannedRow[]
  rejected: Rejection[]
  /** Rows identical to an earlier row of the same file: kept, and said. */
  sameInFile: number
  noStake: number
}

const money = (n: number | null): string => (n === null ? '-' : n.toFixed(2))
const tag = (s: string): string => s.trim().toLowerCase()

/**
 * The fields that make two bets the same bet for an import: date, result,
 * amount, stake, odds and tags. Not the note or the closing odds, which are
 * often added later: an export re-imported after a note was edited still
 * matches. A loose match on purpose: a possible duplicate is shown and the
 * user decides, never dropped unseen.
 */
export function duplicateKey(b: Pick<CleanBet, 'date' | 'status' | 'amount' | 'stake' | 'odds' | 'sport' | 'book' | 'betType'>): string {
  return [b.date, b.status, money(b.amount), money(b.stake), b.odds === null ? '-' : b.odds.toFixed(3), tag(b.sport), tag(b.book), tag(b.betType)].join('|')
}

/** Sort a parsed file against the bets already here. */
export function planImport(parsed: Pick<ImportResult, 'rows' | 'lines' | 'rejected' | 'noStake'>, existing: readonly Bet[]): ImportPlan {
  const here = new Map<string, number>()
  for (const b of existing) {
    const key = duplicateKey(b)
    here.set(key, (here.get(key) ?? 0) + 1)
  }
  const seen = new Set<string>()
  const fresh: PlannedRow[] = []
  const duplicates: PlannedRow[] = []
  let sameInFile = 0
  parsed.rows.forEach((input, i) => {
    const key = duplicateKey(normalizeInput(input))
    const row = { line: parsed.lines[i], input }
    if (seen.has(key)) sameInFile++
    seen.add(key)
    const left = here.get(key) ?? 0
    if (left > 0) {
      here.set(key, left - 1)
      duplicates.push(row)
    } else fresh.push(row)
  })
  return { fresh, duplicates, rejected: parsed.rejected, sameInFile, noStake: parsed.noStake }
}

/**
 * A short fingerprint of a file's text, to recognise the same file picked
 * again (FNV-1a, 52 bits: not for security, only to tell files apart).
 */
export function fingerprint(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0
  }
  return `${text.length.toString(36)}-${h1.toString(36)}-${(h2 & 0xfffff).toString(36)}`
}

import type { ExtractResult } from '../../../shared/expenseExtraction'
import type { Expense, ExpenseCard, ExpenseCategory, ExpenseInput } from '../../../shared/types'
import type { Problem } from './betForm'
import { matchCard } from './cardMatch'
import { currencyDigits } from './currency'
import { expenseAmountProblem, expenseDateProblem, formatAmountText, parseAmountText } from './expenseForm'

/**
 * What an AI reading becomes before anything is saved: one editable row per
 * expense read, ticked unless it looks like an expense already saved. The
 * person checks and adds; nothing is added unseen.
 */

export interface ReviewRow {
  /** `r${index}`, stable for the review. */
  key: string
  include: boolean
  /** The row's fields are open for editing (rows with a problem start open). */
  open: boolean
  /** YYYY-MM-DD; today when the model gave none or an implausible one. */
  date: string
  dateGuessed: boolean
  /** Unsigned, as typed (parseAmountText). */
  amount: string
  /** The sheet's Spent/Refund model: true = a negative amount. */
  refund: boolean
  merchant: string
  category: ExpenseCategory
  cardId: string | null
  /** How the card was chosen: by the image's digits, by its name, not at all, or by the person on this row. */
  cardHow: 'last4' | 'name' | 'none' | 'user'
  /** The image showed card digits that match none of the active cards (an Apple Pay device number, another card). */
  cardUnknownLast4: string | null
  note: string
  pending: boolean
  confidence: 'high' | 'medium' | 'low'
  duplicateOf: Expense | null
}

const NOISE_START = new Set(['sq', 'tst', 'pp'])
const NOISE_END = new Set(['inc', 'llc', 'sa', 'sl', 'sas', 'cv'])

/** lowercase, accents stripped, non-alnum → space, drop "#123", leading "sq", "tst", "pp", trailing "inc|llc|sa|sl|sas|cv", collapse. */
export function normalizeMerchant(s: string): string {
  const words = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/#\s*\d+/g, ' ')
    // "S.A.", "C.V.": one word each.
    .replace(/\b([a-z])\.([a-z])\b\.?/g, '$1$2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '')
  while (words.length > 1 && NOISE_START.has(words[0])) words.shift()
  // Company forms at the end ("S.A. de C.V." too).
  for (let popped = false; words.length > 1; ) {
    const last = words[words.length - 1]
    if (!NOISE_END.has(last) && !(popped && last === 'de')) break
    words.pop()
    popped = true
  }
  return words.join(' ')
}

/** Either empty, equal, or one starts with the other and the shorter is ≥ 4 chars ("starbucks" and "starbucks coffee"). */
export function similarMerchant(a: string, b: string): boolean {
  const x = normalizeMerchant(a)
  const y = normalizeMerchant(b)
  if (x === '' || y === '' || x === y) return true
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x]
  return shorter.length >= 4 && longer.startsWith(shorter)
}

const cents = (n: number): number => Math.round(n * 100)

/**
 * The saved expense this one repeats, if any: same cents (signed), same date, a compatible card (equal, or either has
 * none) and a similar merchant. Candidates oldest first; `taken` (filled here) stops one expense matching twice.
 */
export function findDuplicate(c: { date: string; amount: number; cardId: string | null; merchant: string }, existing: readonly Expense[], taken: Set<string>): Expense | null {
  const want = cents(c.amount)
  const oldestFirst = [...existing].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const hit = oldestFirst.find(
    (e) =>
      !taken.has(e.id) &&
      e.date === c.date &&
      cents(e.amount) === want &&
      (e.cardId === null || c.cardId === null || e.cardId === c.cardId) &&
      similarMerchant(e.merchant, c.merchant)
  )
  if (!hit) return null
  taken.add(hit.id)
  return hit
}

/** expenseAmountProblem(row.amount, currency), then field.dateInvalid. */
export function reviewRowProblem(row: ReviewRow, currency: string): Problem | null {
  return expenseAmountProblem(row.amount, currency) ?? expenseDateProblem(row.date)
}

/**
 * The rows of a reading. Card: by the digits the image shows, else by its name (cardMatch). Digits that match no
 * active card rule out a card found by name only when that card has digits of its own recorded (they differ); last 4
 * is optional, so a card saved without them is still found by its name. A row left without a card by such digits says
 * so (`cardUnknownLast4`). A row like an expense already saved (queued ones too) starts unticked, next to its match; a
 * guessed date, low confidence or a problem opens the row.
 */
export function buildReview(result: ExtractResult, ctx: { today: string; cards: readonly ExpenseCard[]; existing: readonly Expense[]; currency: string }): ReviewRow[] {
  const active = ctx.cards.filter((c) => !c.archived)
  const taken = new Set<string>()
  return result.expenses.map((e, i) => {
    const unknownDigits = e.cardLast4 !== null && !active.some((c) => c.last4 === e.cardLast4)
    const found = matchCard({ last4: e.cardLast4, name: e.cardHint }, ctx.cards)
    // Unknown digits leave only a name match, and veto it when the card named has other digits on record.
    const vetoed = unknownDigits && found.cardId !== null && active.some((c) => c.id === found.cardId && c.last4 !== '')
    const match = vetoed ? null : found
    const date = e.date ?? ctx.today
    const cardId = match?.cardId ?? null
    const duplicateOf = findDuplicate({ date, amount: e.amount, cardId, merchant: e.merchant }, ctx.existing, taken)
    const row: ReviewRow = {
      key: `r${i}`,
      include: duplicateOf === null,
      open: false,
      date,
      dateGuessed: e.date === null,
      amount: formatAmountText(Math.abs(e.amount), ctx.currency),
      refund: e.amount < 0,
      merchant: e.merchant,
      category: e.category,
      cardId,
      cardHow: match?.how ?? 'none',
      cardUnknownLast4: unknownDigits && cardId === null ? e.cardLast4 : null,
      note: e.note,
      pending: e.pending,
      confidence: e.confidence,
      duplicateOf
    }
    row.open = row.dateGuessed || row.confidence === 'low' || reviewRowProblem(row, ctx.currency) !== null
    return row
  })
}

/**
 * The card for every row still on 'none' (a Wallet screen is one card). Those rows stay 'none', so choosing again
 * changes them again; a card picked on a row itself ('user') or read from the image is never overwritten.
 */
export function applyCardToUnmatched(rows: readonly ReviewRow[], cardId: string | null): ReviewRow[] {
  return rows.map((r) => (r.cardHow === 'none' ? { ...r, cardId } : r))
}

/** Included rows only; amount = ±parseAmountText; source 'ai'. Call once no included row has a problem. */
export function reviewInputs(rows: readonly ReviewRow[], currency: string): ExpenseInput[] {
  const digits = currencyDigits(currency)
  const out: ExpenseInput[] = []
  for (const r of rows) {
    if (!r.include) continue
    const n = parseAmountText(r.amount, digits)
    if (typeof n !== 'number') continue
    out.push({ date: r.date, amount: r.refund ? -n : n, cardId: r.cardId, merchant: r.merchant, category: r.category, note: r.note, source: 'ai' })
  }
  return out
}

export const setAllIncluded = (rows: readonly ReviewRow[], include: boolean): ReviewRow[] => rows.map((r) => (r.include === include ? r : { ...r, include }))

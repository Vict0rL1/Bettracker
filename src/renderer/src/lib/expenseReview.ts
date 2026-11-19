import type { ExtractedExpense, ExtractResult } from '../../../shared/expenseExtraction'
import { isCurrencyCode, type Expense, type ExpenseCard, type ExpenseCategory, type ExpenseInput } from '../../../shared/types'
import type { Problem } from './betForm'
import { matchCard } from './cardMatch'
import { currencyDigits } from './currency'
import { expenseAmountProblem, expenseDateProblem, formatAmountText, paidInAnother, parseAmountText } from './expenseForm'
import { chargedFx, fxInput, fxView, NO_ORIGINAL, rateKey, type Charged, type FxAuto, type FxTyped, type FxView } from './expenseFx'
import { mostRecentFirst } from './spend'

/**
 * What an AI reading becomes before anything is saved: one editable row per
 * expense read, ticked unless it looks like an expense already saved. The
 * person checks and adds; nothing is added unseen.
 *
 * Each row is in its own currency: a Wallet list can mix purchases in CAD and
 * in USD, and a bare "$" can be any dollar. A row's currency is the one the
 * image shows for it (its code, or the place a bare "$" was paid in); else
 * the one the person last paid in at the same merchant; else the picture's
 * one currency; else the main currency (rowCurrency). The person can change
 * it on the row, or for every row at once. A row in a currency that is not
 * the main one is an expense paid in another currency: what was read is the
 * original, and the amount in the main currency is what the picture says the
 * card was charged in it, its day's rate, the rate typed for that currency's
 * rows without one, or what the person types on the row (lib/expenseFx.ts).
 * A row with no rate is not added until it has one.
 */

/**
 * How a row's currency was chosen: the image shows it ('read'); the merchant's
 * last expense was paid in it ('memory'); the reading's one currency for the
 * picture ('picture'); the main currency, for want of any ('main'); the person
 * ('user').
 */
export type CurrencyHow = 'read' | 'memory' | 'picture' | 'main' | 'user'

export interface ReviewRow {
  /** `r${index}`, stable for the review. */
  key: string
  include: boolean
  /** The row's fields are open for editing (rows with a problem start open). */
  open: boolean
  /** YYYY-MM-DD; today when the model gave none or an implausible one. */
  date: string
  dateGuessed: boolean
  /** Unsigned, as typed (parseAmountText), in the row's currency. */
  amount: string
  /** The sheet's Spent/Refund model: true = a negative amount. */
  refund: boolean
  /** The currency the row was paid in: what `amount` is in. */
  currency: string
  currencyHow: CurrencyHow
  /** Neither read nor remembered, in a review where that matters (see buildReview): the row says its currency was assumed. */
  currencyAssumed: boolean
  /** What the picture says the card was charged for it in another currency (as read; used when that is the main one). */
  charged: Charged | null
  /** In another currency: what the person typed on this row as its rate or its amount in the main currency (null: nothing). */
  fx: FxTyped | null
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

/** The main currency of a review and the rates it has. */
export interface ReviewMoney {
  /** The user's main currency: what is saved as `amount`. */
  main: string
  /** The rate fetched for each currency and date (rateKey('USD', '2026-11-13')) that has one. */
  rates: Readonly<Record<string, FxAuto | undefined>>
  /** The rate typed for every row of a currency that has none, by currency, when it is one. */
  all: Readonly<Record<string, number | undefined>>
}

/** A review with no rate yet: rows in the main currency need none. */
export const sameMoney = (main: string): ReviewMoney => ({ main, rates: {}, all: {} })

/** The one currency of a picture, as the reading names it; else the main one. */
export const pictureCurrency = (result: Pick<ExtractResult, 'currency'>, main: string): string => (isCurrencyCode(result.currency) ? result.currency : main)

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

/** The currency each merchant was last paid in, by its normalized name (normalizeMerchant). */
export type MerchantMemory = ReadonlyMap<string, string>

/**
 * What the saved expenses remember of each merchant's currency: the currency
 * of the latest expense (by date, then by when it was added) of each
 * normalized merchant name, its original currency when it was paid in
 * another one, else the main currency. "SQ *Blue Bottle Coffee #12" and
 * "Blue Bottle Coffee" are one merchant; an expense with no merchant is none.
 * One pass over the expenses, so a long history costs one normalization each.
 */
export function merchantMemory(existing: readonly Expense[], main: string): MerchantMemory {
  const latest = new Map<string, Expense>()
  for (const e of existing) {
    const key = normalizeMerchant(e.merchant)
    if (key === '') continue
    const seen = latest.get(key)
    if (seen === undefined || mostRecentFirst(e, seen) < 0) latest.set(key, e)
  }
  const memory = new Map<string, string>()
  for (const [key, e] of latest) memory.set(key, paidInAnother(e, main) ? e.originalCurrency : main)
  return memory
}

/** The currency a merchant was last paid in, or null when none of the saved expenses is at that merchant. */
export function rememberedCurrency(memory: MerchantMemory, merchant: string): string | null {
  const key = normalizeMerchant(merchant)
  return key === '' ? null : (memory.get(key) ?? null)
}

/**
 * The currency a row read starts in, and how it was chosen: the one the image
 * shows for it (its code, or the place a bare "$" was paid in); else the one
 * the merchant was last paid in; else the picture's one currency; else the
 * main currency.
 */
export function rowCurrency(read: Pick<ExtractedExpense, 'currency' | 'currencyBasis'>, o: { remembered: string | null; picture: string | null; main: string }): { currency: string; how: CurrencyHow } {
  if (read.currencyBasis !== 'none' && isCurrencyCode(read.currency)) return { currency: read.currency, how: 'read' }
  if (isCurrencyCode(o.remembered)) return { currency: o.remembered, how: 'memory' }
  if (isCurrencyCode(o.picture)) return { currency: o.picture, how: 'picture' }
  return { currency: o.main, how: 'main' }
}

/** What the picture says the card was charged, as a row keeps it (unsigned, with what was paid as read). */
export const chargedOf = (e: Pick<ExtractedExpense, 'amount' | 'chargedAmount' | 'chargedCurrency'>): Charged | null =>
  e.chargedAmount !== null && e.chargedCurrency !== null && isCurrencyCode(e.chargedCurrency) ? { amount: Math.abs(e.chargedAmount), currency: e.chargedCurrency, paid: Math.abs(e.amount) } : null

/** The row is paid in another currency and the picture says what it was charged in the main one: no rate is asked for. */
export const rowAsCharged = (row: Pick<ReviewRow, 'currency' | 'charged'>, main: string): boolean => row.currency !== main && chargedFx(row.charged, main) !== null

const cents = (n: number): number => Math.round(n * 100)

/** What a row would be saved as, as far as it is known, for telling a duplicate. */
export interface DuplicateCandidate {
  date: string
  /** Signed, in the main currency; null when it is not known yet (paid in another currency, no rate so far). */
  amount: number | null
  /** Paid in another currency: what was paid (signed) and in what. */
  original?: { amount: number; currency: string } | null
  cardId: string | null
  merchant: string
}

/**
 * The saved expense this one repeats, if any: the same money, same date, a compatible card (equal, or either has
 * none) and a similar merchant. The same money is the same amount in the main currency (signed, to the cent), or,
 * for one paid in another currency, the same amount paid in the same currency: the same purchase read twice has the
 * same original even when the rate (and so the main amount) differs. Candidates oldest first; `taken` (filled here)
 * stops one expense matching twice.
 */
export function findDuplicate(c: DuplicateCandidate, existing: readonly Expense[], taken: Set<string>): Expense | null {
  const want = c.amount === null ? null : cents(c.amount)
  const paid = c.original ? { cents: cents(c.original.amount), currency: c.original.currency } : null
  const sameMoney = (e: Expense): boolean =>
    (want !== null && cents(e.amount) === want) || (paid !== null && e.originalAmount !== null && e.originalCurrency === paid.currency && cents(e.originalAmount) === paid.cents)
  const oldestFirst = [...existing].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const hit = oldestFirst.find(
    (e) => !taken.has(e.id) && e.date === c.date && sameMoney(e) && (e.cardId === null || c.cardId === null || e.cardId === c.cardId) && similarMerchant(e.merchant, c.merchant)
  )
  if (!hit) return null
  taken.add(hit.id)
  return hit
}

/** What a row's amount comes to. */
export interface RowMoney {
  /** The row is an expense paid in another currency (its currency is not the main one). */
  foreign: boolean
  /** What was read, unsigned, when the box holds a usable number. */
  paid: number | null
  /** Paid in another currency: the rate and the amount in the main currency, as far as they are known. */
  view: FxView | null
  /** Signed, in the main currency: what the row would be saved as; null while it is not known. */
  amount: number | null
}

export function rowMoney(row: Pick<ReviewRow, 'amount' | 'refund' | 'date' | 'fx' | 'currency' | 'charged'>, m: ReviewMoney): RowMoney {
  const n = parseAmountText(row.amount, currencyDigits(row.currency))
  const paid = typeof n === 'number' && expenseAmountProblem(row.amount, row.currency) === null ? n : null
  const sign = row.refund ? -1 : 1
  if (row.currency === m.main) return { foreign: false, paid, view: null, amount: paid === null ? null : sign * paid }
  const view = fxView({ typed: row.fx, charged: chargedFx(row.charged, m.main), auto: m.rates[rateKey(row.currency, row.date)] ?? null, all: m.all[row.currency] ?? null, amount: paid, main: m.main })
  return { foreign: true, paid, view, amount: paid === null || view.converted === null || view.rate === null ? null : sign * view.converted }
}

/** What a row is compared with the saved expenses by. */
function candidate(row: Pick<ReviewRow, 'amount' | 'refund' | 'date' | 'fx' | 'currency' | 'charged' | 'cardId' | 'merchant'>, m: ReviewMoney): DuplicateCandidate | null {
  const money = rowMoney(row, m)
  if (money.paid === null) return null
  const sign = row.refund ? -1 : 1
  return { date: row.date, amount: money.amount, original: money.foreign ? { amount: sign * money.paid, currency: row.currency } : null, cardId: row.cardId, merchant: row.merchant }
}

/**
 * What keeps a ticked row from being added and needs the person: the amount box, then the date, then (paid in another
 * currency) a rate or a main-currency amount typed on the row that can't be read. A row that simply has no rate yet
 * is not a problem to fix on the row: see rowReady. `m` may be the main currency alone.
 */
export function reviewRowProblem(row: ReviewRow, m: ReviewMoney | string): Problem | null {
  const money = typeof m === 'string' ? sameMoney(m) : m
  const basic = expenseAmountProblem(row.amount, row.currency) ?? expenseDateProblem(row.date)
  if (basic || row.currency === money.main || row.fx === null) return basic
  const view = rowMoney(row, money).view
  if (view === null) return null
  // Emptied and not left yet: it will fall back to the day's rate; nothing to fix.
  if (row.fx.text.trim() === '') return null
  return row.fx.lead === 'rate' ? (view.rateProblem ?? view.convertedProblem) : (view.convertedProblem ?? view.rateProblem)
}

/** A row that can be saved as it is: no problem, and (paid in another currency) a rate and an amount in the main currency. */
export function rowReady(row: ReviewRow, m: ReviewMoney): boolean {
  if (reviewRowProblem(row, m) !== null) return false
  return rowMoney(row, m).amount !== null
}

/** A row paid in another currency that has no rate from anywhere yet (nothing typed or charged, none fetched, none typed for its currency). */
export function rowLacksRate(row: ReviewRow, m: ReviewMoney): boolean {
  if (row.currency === m.main) return false
  const view = rowMoney(row, m).view
  return view !== null && view.rate === null && view.rateProblem?.key === 'field.rateRequired' && (row.fx === null || row.fx.text.trim() === '')
}

/**
 * The rates a review asks for: one per currency and date of the rows paid in another currency that the person has not
 * typed a rate or an amount for, and whose charge in the main currency the picture doesn't show. Each once.
 */
export function wantedRates(rows: readonly ReviewRow[], main: string): { from: string; date: string }[] {
  const out: { from: string; date: string }[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (r.currency === main || (r.fx !== null && r.fx.text.trim() !== '') || rowAsCharged(r, main)) continue
    const key = rateKey(r.currency, r.date)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ from: r.currency, date: r.date })
  }
  return out
}

/**
 * The rows of a reading. Card: by the digits the image shows, else by its name (cardMatch). Digits that match no
 * active card rule out a card found by name only when that card has digits of its own recorded (they differ); last 4
 * is optional, so a card saved without them is still found by its name. A row left without a card by such digits says
 * so (`cardUnknownLast4`). A row like an expense already saved (queued ones too) starts unticked, next to its match; a
 * guessed date, low confidence or a problem opens the row.
 *
 * Currency: rowCurrency, with the merchant memory of `existing`; the amounts are written in each row's own. A row
 * whose currency was neither read nor remembered is marked `currencyAssumed` when that matters: the person has
 * expenses paid in another currency, the rows are not all in one currency, or the picture shows what the row was
 * charged in another one. A picture that is all in the main currency, for someone who never pays in another, says
 * nothing.
 * `currency` is the main currency. No rate is known yet, so a row paid in another currency is matched with the saved
 * expenses by what was paid (and by what it was charged in the main currency, when the picture says) until its rate
 * comes (refreshDuplicates).
 */
export function buildReview(result: ExtractResult, ctx: { today: string; cards: readonly ExpenseCard[]; existing: readonly Expense[]; currency: string }): ReviewRow[] {
  const main = ctx.currency
  const active = ctx.cards.filter((c) => !c.archived)
  const taken = new Set<string>()
  const memory = merchantMemory(ctx.existing, main)
  const picture = isCurrencyCode(result.currency) ? result.currency : null
  const chosen = result.expenses.map((e) => rowCurrency(e, { remembered: rememberedCurrency(memory, e.merchant), picture, main }))
  const matters = ctx.existing.some((e) => paidInAnother(e, main)) || new Set(chosen.map((c) => c.currency)).size > 1
  return result.expenses.map((e, i) => {
    const { currency, how } = chosen[i]
    const unknownDigits = e.cardLast4 !== null && !active.some((c) => c.last4 === e.cardLast4)
    const found = matchCard({ last4: e.cardLast4, name: e.cardHint }, ctx.cards)
    // Unknown digits leave only a name match, and veto it when the card named has other digits on record.
    const vetoed = unknownDigits && found.cardId !== null && active.some((c) => c.id === found.cardId && c.last4 !== '')
    const match = vetoed ? null : found
    const date = e.date ?? ctx.today
    const cardId = match?.cardId ?? null
    const charged = chargedOf(e)
    const foreign = currency !== main
    const asCharged = foreign ? chargedFx(charged, main) : null
    const sign = e.amount < 0 ? -1 : 1
    const duplicateOf = findDuplicate(
      { date, amount: foreign ? (asCharged ? sign * asCharged.converted : null) : e.amount, original: foreign ? { amount: e.amount, currency } : null, cardId, merchant: e.merchant },
      ctx.existing,
      taken
    )
    const unread = how === 'picture' || how === 'main'
    const row: ReviewRow = {
      key: `r${i}`,
      include: duplicateOf === null,
      open: false,
      date,
      dateGuessed: e.date === null,
      amount: formatAmountText(Math.abs(e.amount), currency),
      refund: e.amount < 0,
      currency,
      currencyHow: how,
      // A charge in another currency means the purchase wasn't in that one: the currency matters even when it is the default.
      currencyAssumed: unread && (matters || charged !== null),
      charged,
      fx: null,
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
    row.open = row.dateGuessed || row.confidence === 'low' || reviewRowProblem(row, main) !== null
    return row
  })
}

/**
 * The row in another currency, as the person chose it: no longer assumed. A rate typed on it was for the other
 * currency and goes; an amount typed in the main currency (what the bank charged) stays, unless the row is now in the
 * main currency itself. Choosing the currency it already has only confirms it.
 */
export function setRowCurrency(row: ReviewRow, currency: string, main: string): ReviewRow {
  if (currency === row.currency) return row.currencyHow === 'user' && !row.currencyAssumed ? row : { ...row, currencyHow: 'user', currencyAssumed: false }
  const fx = currency !== main && row.fx?.lead === 'converted' ? row.fx : null
  return { ...row, currency, currencyHow: 'user', currencyAssumed: false, fx }
}

/** "Currency of all rows": every row in that one. */
export const setAllCurrencies = (rows: readonly ReviewRow[], currency: string, main: string): ReviewRow[] => rows.map((r) => setRowCurrency(r, currency, main))

/** The currency every row is in, or null when they differ (or there are none). */
export function commonCurrency(rows: readonly Pick<ReviewRow, 'currency'>[]): string | null {
  const first = rows[0]?.currency ?? null
  return first !== null && rows.every((r) => r.currency === first) ? first : null
}

/**
 * The rows with their duplicates looked up again: the saved expenses changed (one was added or deleted elsewhere), a
 * row's currency changed or a rate arrived. A row that gains or loses its match is unticked or ticked with it; the
 * others keep what the person chose. The same array when nothing changed.
 */
export function refreshDuplicates(rows: readonly ReviewRow[], existing: readonly Expense[], m: ReviewMoney): readonly ReviewRow[] {
  if (rows.length === 0) return rows
  const taken = new Set<string>()
  let changed = false
  const next = rows.map((r) => {
    const c = candidate(r, m)
    const dup = c === null ? null : findDuplicate(c, existing, taken)
    if ((dup?.id ?? null) === (r.duplicateOf?.id ?? null)) return r
    changed = true
    return { ...r, duplicateOf: dup, include: dup === null }
  })
  return changed ? next : rows
}

/**
 * The card for every row still on 'none' (a Wallet screen is one card). Those rows stay 'none', so choosing again
 * changes them again; a card picked on a row itself ('user') or read from the image is never overwritten.
 */
export function applyCardToUnmatched(rows: readonly ReviewRow[], cardId: string | null): ReviewRow[] {
  return rows.map((r) => (r.cardHow === 'none' ? { ...r, cardId } : r))
}

/**
 * What "Add N" adds: the ticked rows that are ready (rowReady), as inputs with source 'ai', and their keys. In the
 * main currency: amount = ±what was read. In another: that is the original, with its currency, the rate and the
 * amount in the main currency. A ticked row without a rate is left out (and stays in the review).
 */
export function reviewAdds(rows: readonly ReviewRow[], m: ReviewMoney): { inputs: ExpenseInput[]; keys: string[] } {
  const inputs: ExpenseInput[] = []
  const keys: string[] = []
  for (const r of rows) {
    if (!r.include || !rowReady(r, m)) continue
    const money = rowMoney(r, m)
    if (money.paid === null || money.amount === null) continue
    const rest = { date: r.date, cardId: r.cardId, merchant: r.merchant, category: r.category, note: r.note, source: 'ai' as const }
    if (!money.foreign || money.view === null) inputs.push({ ...rest, amount: money.amount, ...NO_ORIGINAL })
    else inputs.push({ ...rest, ...fxInput(money.view, money.paid, r.currency, r.refund) })
    keys.push(r.key)
  }
  return { inputs, keys }
}

/** Included rows only; amount = ±parseAmountText; source 'ai'. Call once no included row has a problem. Rows in the main currency (see reviewAdds for the others, which need a rate). */
export function reviewInputs(rows: readonly ReviewRow[], currency: string): ExpenseInput[] {
  return reviewAdds(rows, sameMoney(currency)).inputs
}

export const setAllIncluded = (rows: readonly ReviewRow[], include: boolean): ReviewRow[] => rows.map((r) => (r.include === include ? r : { ...r, include }))

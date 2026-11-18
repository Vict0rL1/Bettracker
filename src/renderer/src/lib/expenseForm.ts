import type { Expense, ExpenseCard, ExpenseCategory, ExpenseInput, ExpenseSource } from '../../../shared/types'
import type { ExpenseLast } from '../data/expenseLast'
import type { Problem } from './betForm'
import { currencyDigits, EXPENSE_CURRENCIES } from './currency'
import { isValidDate, MAX_AMOUNT } from './validate'

/**
 * The expense sheet's boxes as typed, and what they mean. Amounts are typed
 * as text and read the way the person meant them (parseAmountText), never
 * with parseFloat: "4,50", "1.234,50" and "12.500" (pesos) are all common.
 * The sign is never typed: the sheet's Spent/Refund toggle sets it.
 */

export interface ExpenseDraft {
  /** Unsigned, as typed. */
  amount: string
  /** true: a refund or credit (a negative amount). */
  refund: boolean
  date: string
  cardId: string | null
  category: ExpenseCategory
  merchant: string
  note: string
}

/** Defaults: today, `preferCardId` if active, else last card if still active, else the only active card, else null; last category else 'other'. */
export function initialDraft(o: { today: string; last: ExpenseLast | null; cards: readonly ExpenseCard[]; preferCardId?: string }): ExpenseDraft {
  const active = o.cards.filter((c) => !c.archived)
  const isActive = (id: string | null | undefined): id is string => id !== null && id !== undefined && active.some((c) => c.id === id)
  const cardId = isActive(o.preferCardId) ? o.preferCardId : isActive(o.last?.cardId) ? (o.last?.cardId ?? null) : active.length === 1 ? active[0].id : null
  return { amount: '', refund: false, date: o.today, cardId, category: o.last?.category ?? 'other', merchant: '', note: '' }
}

/** A draft handed back after "Add card": what was typed, with the card added then chosen while it is active (else the draft's own card). */
export function resumedDraft(draft: ExpenseDraft, cards: readonly ExpenseCard[], addedCardId: string | null): ExpenseDraft {
  const added = addedCardId === null ? undefined : cards.find((c) => c.id === addedCardId && !c.archived)
  return added ? { ...draft, cardId: added.id } : draft
}

/** Boxes that take typed text. */
const TYPED_INPUTS: ReadonlySet<string> = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])

/** What pasteIsTyping reads of the paste's target (an element; plain objects in tests). */
export interface PasteTarget {
  tagName?: string
  type?: string
  readOnly?: boolean
  disabled?: boolean
  isContentEditable?: boolean
}

/**
 * A paste the sheet leaves to the box it lands in: text (text/plain on the clipboard) into a box that takes typed text
 * (Amount, Merchant, Note). Excel and Word copy a picture of the cells beside their text, and that picture is no
 * receipt: reading it would drop the text and pay for an AI call. An image pasted without text, or anywhere else in
 * the sheet, is still read.
 */
export function pasteIsTyping(target: PasteTarget | null, types: readonly string[]): boolean {
  if (target === null || !types.includes('text/plain')) return false
  if (target.isContentEditable) return true
  if (target.readOnly || target.disabled) return false
  const tag = (target.tagName ?? '').toUpperCase()
  return tag === 'TEXTAREA' || (tag === 'INPUT' && TYPED_INPUTS.has((target.type || 'text').toLowerCase()))
}

/** A saved expense in the sheet's boxes: refund = amount < 0, the amount unsigned (formatAmountText). */
export function draftOf(e: Expense, currency: string): ExpenseDraft {
  return {
    amount: formatAmountText(Math.abs(e.amount), currency),
    refund: e.amount < 0,
    date: e.date,
    cardId: e.cardId,
    category: e.category,
    merchant: e.merchant,
    note: e.note
  }
}

/** amount = ±parseAmountText(text, currencyDigits(currency)); call only when expenseAmountProblem is null. */
export function draftToInput(d: ExpenseDraft, source: ExpenseSource, currency: string): ExpenseInput {
  const n = parseAmountText(d.amount, currencyDigits(currency))
  // Anything but a number is refused by normalizeExpense (amountNumber), as it should never get here.
  const amount = typeof n === 'number' ? (d.refund ? -n : n) : Number.NaN
  return { date: d.date, amount, cardId: d.cardId, category: d.category, merchant: d.merchant, note: d.note, source }
}

/** Rounded half up at that many decimals, as written: 4.505 → 4.51 (4.505 × 100 is 450.4999… in binary). */
function roundTo(n: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(Number((n * f).toPrecision(15))) / f
}

/** "1.234.567" / "1,234": the groups after the first are 3 digits each. */
const groupsOk = (parts: readonly string[]): boolean => parts.every((p, i) => (i === 0 ? /^\d+$/.test(p) : /^\d{3}$/.test(p)))

/**
 * The number in what was typed: from its first digit (or the separator just before it: ".5", "$.50", but not the dot
 * that ends a sign such as "S/." or "Bs.") to its last digit or separator. Whatever stands around it must be a currency
 * mark (isCurrencyMark).
 */
const NUMBER = /(?:(?<![\p{L}/])[.,])?\d(?:[\d.,\s]*[\d.,])?/u

/** Signs of the picker's currencies written in letters: quetzal, lempira, sol, boliviano, guaraní. */
const LETTER_SIGNS: ReadonlySet<string> = new Set(['Q', 'L', 'S/', 'S/.', 'Bs', 'Bs.', 'Gs', 'Gs.'])

let isoCodes: ReadonlySet<string> | null = null
/** A currency's ISO code in any case ("COP", "usd"): the picker's, and every one Intl knows. "mil" is none. */
function isIsoCode(w: string): boolean {
  isoCodes ??= new Set<string>([...EXPENSE_CURRENCIES, ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : [])])
  return /^[a-z]{3}$/i.test(w) && isoCodes.has(w.toUpperCase())
}

/**
 * What may stand before or after an amount's digits, spaces aside: nothing; a currency symbol with up to 3 letters on
 * either side ("$", "€", "US$", "MX$", "R$", "RD$", "$U"); a currency's ISO code ("COP", "usd"); or a letter sign of a
 * picker currency ("Q", "S/", "Bs"). Any other letter ("12k", "12 mil", "1e3", "1O.50") makes the amount unreadable:
 * it is never dropped unseen.
 */
function isCurrencyMark(text: string): boolean {
  const w = text.replace(/\s/g, '')
  return w === '' || /^\p{L}{0,3}\p{Sc}+\p{L}{0,3}$/u.test(w) || isIsoCode(w) || LETTER_SIGNS.has(w)
}

/**
 * What a person typed as an amount, read the way they meant it. A currency mark before or after the number is left
 * out ("$", "€", "COP", "MX$", "4.50 USD"; isCurrencyMark); a letter anywhere else makes it 'invalid'. Spaces inside
 * the number group thousands only ("12 500", "1 234,50": the separator after them is the decimal one). Then:
 *  - "," and "." both present → the LAST one is the decimal separator, the other is grouping ("1.234,50", "1,234.50");
 *  - one kind present once, followed by exactly 3 digits → grouping ("12.500" = 12500, "4,500" = 4500), except after a
 *    lone 0 ("0.500" is a half) and for a currency with 3 minor digits (a dinar's "1.500" is one and a half);
 *  - one kind present once otherwise → decimal ("4,50", "12.5");
 *  - one kind present more than once → grouping ("1.234.567");
 *  - for a 0-digit currency (COP, CLP, PYG), a fraction of zeros is dropped ("12.500,00", as invoices print it) and any
 *    other fraction → 'noMinorUnits'; more fraction digits than the currency has → rounded to the currency's digits
 *    (2-digit currencies: cents).
 * '' → null; anything else that isn't a finite number → 'invalid'. Never negative (the Spent/Refund toggle sets the sign).
 */
export function parseAmountText(text: string, digits: number): number | null | 'invalid' | 'noMinorUnits' {
  if (text.trim() === '') return null
  const found = NUMBER.exec(text)
  if (!found) return 'invalid'
  const s = found[0]
  if (!isCurrencyMark(text.slice(0, found.index)) || !isCurrencyMark(text.slice(found.index + s.length))) return 'invalid'
  const dots = s.split('.').length - 1
  const commas = s.split(',').length - 1
  let whole: string
  let fraction = ''
  if (/\s/.test(s)) {
    const spaced = /^(\d{1,3}(?:\s+\d{3})+)(?:[.,](\d*))?$/u.exec(s)
    if (!spaced) return 'invalid'
    whole = spaced[1].replace(/\s+/g, '')
    fraction = spaced[2] ?? ''
  } else if (dots > 0 && commas > 0) {
    const decimal = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ','
    const grouping = decimal === '.' ? ',' : '.'
    const at = s.lastIndexOf(decimal)
    if (s.indexOf(decimal) !== at) return 'invalid'
    const head = s.slice(0, at)
    if (!groupsOk(head.split(grouping))) return 'invalid'
    whole = head.split(grouping).join('')
    fraction = s.slice(at + 1)
  } else if (dots + commas === 0) {
    whole = s
  } else {
    const sep = dots > 0 ? '.' : ','
    const parts = s.split(sep)
    if (parts.length > 2) {
      if (!groupsOk(parts)) return 'invalid'
      whole = parts.join('')
    } else if (/^[1-9]\d*$/.test(parts[0]) && /^\d{3}$/.test(parts[1]) && digits !== 3) {
      whole = parts.join('')
    } else {
      whole = parts[0] === '' ? '0' : parts[0]
      fraction = parts[1]
    }
  }
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) return 'invalid'
  if (digits === 0 && /^0*$/.test(fraction)) fraction = ''
  if (fraction !== '' && digits === 0) return 'noMinorUnits'
  const n = Number(fraction === '' ? whole : `${whole}.${fraction}`)
  if (!Number.isFinite(n)) return 'invalid'
  return fraction.length > digits ? roundTo(n, digits) : n
}

/**
 * A number back as box text: "." decimal, the currency's digits, no grouping (what parseAmountText reads back unchanged).
 * An amount with cents a currency doesn't have (saved before the currency changed to pesos) keeps them, so the box
 * says so instead of rounding them away unseen.
 */
export function formatAmountText(n: number, currency: string): string {
  const digits = currencyDigits(currency)
  const fixed = n.toFixed(digits)
  return Math.round(Number(fixed) * 100) === Math.round(n * 100) ? fixed : n.toFixed(Math.max(2, digits))
}

/** The positive amount box: field.resultRequired / resultInvalid / field.noMinorUnits {currency} / tooBig / resultRoundsZero. */
export function expenseAmountProblem(text: string, currency: string): Problem | null {
  const n = parseAmountText(text, currencyDigits(currency))
  if (n === null) return { key: 'field.resultRequired' }
  if (n === 'invalid') return { key: 'field.resultInvalid' }
  if (n === 'noMinorUnits') return { key: 'field.noMinorUnits', vars: { currency } }
  if (n > MAX_AMOUNT) return { key: 'field.tooBig' }
  // Judged as stored: to the cent ("0.004" was read as 0, but something was typed).
  if (Math.round(n * 100) === 0) return { key: /[1-9]/.test(text) ? 'field.resultRoundsZero' : 'field.resultRequired' }
  return null
}

export const expenseDateProblem = (text: string): Problem | null => (isValidDate(text) ? null : { key: 'field.dateInvalid' })

/** A merchant as an accessible name or a sentence part: the merchant, or t('explist.noMerchant') when ''. */
export const merchantLabel = (m: string, t: (k: 'explist.noMerchant') => string): string => (m.trim() === '' ? t('explist.noMerchant') : m)

/**
 * How "delete" treats a card (decision 4): 'delete' only when the expense list is known for sure — loaded AND read from the
 * server in this session (`readThisSession` = expenses.tableReady) — and no expense references the card; otherwise 'archive'
 * (archiving is reversible, a hard delete is made permanent by 007's tombstone).
 */
export function cardDeleteMode(card: ExpenseCard, expenses: readonly Expense[], known: { loaded: boolean; readThisSession: boolean }): 'delete' | 'archive' {
  if (!known.loaded || !known.readThisSession) return 'archive'
  const id = card.id.toLowerCase()
  return expenses.some((e) => e.cardId !== null && e.cardId.toLowerCase() === id) ? 'archive' : 'delete'
}

/**
 * What committing a budget box means: null = nothing to do (the box holds no edit of the user's, or the value is unchanged),
 * 'revert' = refused text, else the limit to set (null clears it). `pending` is useBox().pending().
 */
export function budgetCommit(pending: string | null, current: number | null, currency: string): { limit: number | null } | 'revert' | null {
  if (pending === null) return null
  const n = parseAmountText(pending, currencyDigits(currency))
  if (n === 'invalid' || n === 'noMinorUnits') return 'revert'
  const c = n === null ? 0 : Math.round(n * 100)
  if (c === 0) return current === null ? null : { limit: null }
  if (n !== null && n > MAX_AMOUNT) return 'revert'
  if (current !== null && Math.round(current * 100) === c) return null
  return { limit: c / 100 }
}

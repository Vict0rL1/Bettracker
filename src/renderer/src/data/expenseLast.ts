import { isCurrencyCode, type ExpenseCategory } from '../../../shared/types'
import { isExpenseCategory } from '../lib/categories'
import { expenseLastKey, readJson, writable } from './offline'
import { writeExpendable } from './store'

/**
 * The card and category the expense sheet last used, per user, on this device (never synced), and the last currency
 * other than the main one an expense was paid in: the sheet offers it first after the main one.
 */
export interface ExpenseLast {
  cardId: string | null
  category: ExpenseCategory
  /** An ISO code; absent until an expense in another currency is added here. */
  currency?: string
}

/** What the sheet last used here, or null (never used, or a shape this version can't read). */
export function loadExpenseLast(userId: string): ExpenseLast | null {
  const raw = readJson<unknown>(expenseLastKey(userId))
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as { cardId?: unknown; category?: unknown; currency?: unknown }
  if (!isExpenseCategory(r.category)) return null
  if (r.cardId !== null && (typeof r.cardId !== 'string' || r.cardId === '')) return null
  // Written by a version from before currencies, or with something that is no code: none.
  return { cardId: r.cardId, category: r.category, ...(isCurrencyCode(r.currency) ? { currency: r.currency } : {}) }
}

/**
 * A convenience, so failing to store it is fine; nothing is stored for a user signed out here. The other currency
 * last used stays when this expense has none (`currency` left out): one coffee in the main currency doesn't forget it.
 */
export function saveExpenseLast(userId: string, v: ExpenseLast): void {
  if (!writable(userId)) return
  const currency = isCurrencyCode(v.currency) ? v.currency : loadExpenseLast(userId)?.currency
  writeExpendable(expenseLastKey(userId), { cardId: v.cardId, category: v.category, ...(currency ? { currency } : {}) })
}

/** After a scan in another currency: that currency is remembered, and the card and category last used stay as they are. */
export function rememberPayCurrency(userId: string, currency: string): void {
  if (!isCurrencyCode(currency)) return
  const last = loadExpenseLast(userId)
  saveExpenseLast(userId, { cardId: last?.cardId ?? null, category: last?.category ?? 'other', currency })
}

import type { ExpenseCategory } from '../../../shared/types'
import { isExpenseCategory } from '../lib/categories'
import { expenseLastKey, readJson, writable } from './offline'
import { writeExpendable } from './store'

/** The card and category the expense sheet last used, per user, on this device (never synced). */
export interface ExpenseLast {
  cardId: string | null
  category: ExpenseCategory
}

/** What the sheet last used here, or null (never used, or a shape this version can't read). */
export function loadExpenseLast(userId: string): ExpenseLast | null {
  const raw = readJson<unknown>(expenseLastKey(userId))
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as { cardId?: unknown; category?: unknown }
  if (!isExpenseCategory(r.category)) return null
  if (r.cardId !== null && (typeof r.cardId !== 'string' || r.cardId === '')) return null
  return { cardId: r.cardId, category: r.category }
}

/** A convenience, so failing to store it is fine; nothing is stored for a user signed out here. */
export function saveExpenseLast(userId: string, v: ExpenseLast): void {
  if (writable(userId)) writeExpendable(expenseLastKey(userId), { cardId: v.cardId, category: v.category })
}

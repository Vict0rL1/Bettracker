import { EXPENSE_CATEGORIES, type ExpenseCategory } from '../../../shared/types'
import type { StringKey } from './strings'

export { EXPENSE_CATEGORIES, type ExpenseCategory } from '../../../shared/types'

/** One of the fixed expense categories (exactly as stored: lowercase keys). */
export const isExpenseCategory = (v: unknown): v is ExpenseCategory => (EXPENSE_CATEGORIES as readonly unknown[]).includes(v)

/** A category as the app files it: a key it doesn't know (from a cache, the server, a newer app or the AI) is 'other'. */
export const toCategory = (v: unknown): ExpenseCategory => (isExpenseCategory(v) ? v : 'other')

/** The label's key in the dictionaries ("Coffee" / "Café"). */
export const categoryKey = (c: ExpenseCategory): StringKey => `cat.${c}`

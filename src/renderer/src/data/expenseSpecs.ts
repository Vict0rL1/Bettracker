import {
  BUDGET_SCOPES,
  type BudgetScope,
  type CardKind,
  type Expense,
  type ExpenseBudget,
  type ExpenseBudgetInput,
  type ExpenseCard,
  type ExpenseCardInput,
  type ExpenseInput
} from '../../../shared/types'
import { toCategory } from '../lib/categories'
import { isValidDate, normalizeBudget, normalizeCard, normalizeExpense } from '../lib/validate'
import type { RowTableSpec } from './rowTable'

/**
 * The three tables of migration 008 as row-table specs (data/rowTable.ts,
 * data/useRowSync.ts): how each is read, written, cached and ordered. Pure:
 * no Supabase here, so the tests can run every spec through the same cases
 * (data/expenses.ts makes the network tables from them).
 */

type Row = Record<string, unknown>

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const finite = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const kindOf = (v: unknown): CardKind => (v === 'debit' ? 'debit' : 'credit')
const isScope = (v: unknown): v is BudgetScope => BUDGET_SCOPES.includes(v as BudgetScope)

/** By createdAt, then id: the order cards and budgets were made in, the same on every device. */
const byCreated = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number => {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** By date, then createdAt, then id (as the bets and moves are). */
const byDateThenCreated = (a: Expense, b: Expense): number => {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  return byCreated(a, b)
}

/** An expense's fields from an input (a clean one: queued inputs are normalized before they are queued). */
const expenseFields = (input: ExpenseInput): Omit<Expense, 'id' | 'createdAt' | 'updatedAt'> => ({
  date: input.date,
  amount: input.amount,
  cardId: typeof input.cardId === 'string' && input.cardId !== '' ? input.cardId : null,
  merchant: input.merchant ?? '',
  category: toCategory(input.category),
  note: input.note ?? '',
  source: input.source === 'ai' ? 'ai' : 'manual'
})

const cardFields = (input: ExpenseCardInput): Omit<ExpenseCard, 'id' | 'createdAt' | 'updatedAt'> => ({
  name: input.name,
  last4: input.last4 ?? '',
  kind: kindOf(input.kind),
  archived: input.archived === true
})

const budgetFields = (input: ExpenseBudgetInput): Omit<ExpenseBudget, 'id' | 'createdAt' | 'updatedAt'> => ({
  scope: input.scope,
  target: input.target,
  monthlyLimit: input.monthlyLimit
})

export const EXPENSES_SPEC: RowTableSpec<Expense, ExpenseInput> = {
  name: 'expenses',
  table: 'expenses',
  channel: 'expenses-sync',
  order: ['date', 'created_at', 'id'],
  // PostgREST returns numeric columns as strings to preserve precision: coerced.
  fromRow: (row: Row): Expense => ({
    id: text(row.id),
    date: text(row.date),
    amount: Number(row.amount),
    cardId: typeof row.card_id === 'string' ? row.card_id : null,
    merchant: text(row.merchant),
    category: toCategory(row.category),
    note: text(row.note),
    source: row.source === 'ai' ? 'ai' : 'manual',
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at)
  }),
  toColumns: (clean) => {
    const f = expenseFields(clean)
    return { date: f.date, amount: f.amount, card_id: f.cardId, merchant: f.merchant, category: f.category, note: f.note, source: f.source }
  },
  normalize: normalizeExpense,
  toInput: (e) => ({ date: e.date, amount: e.amount, cardId: e.cardId, merchant: e.merchant, category: e.category, note: e.note, source: e.source }),
  // A cached row that would poison the totals (no id, no date, an amount that is no number or the 0 the database refuses) is left out.
  hydrate: (raw) => {
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as Partial<Record<keyof Expense, unknown>>
    if (typeof r.id !== 'string' || r.id === '' || typeof r.date !== 'string' || !isValidDate(r.date)) return null
    const amount = finite(r.amount)
    if (amount === null || amount === 0) return null
    return {
      id: r.id,
      date: r.date,
      amount,
      cardId: typeof r.cardId === 'string' && r.cardId !== '' ? r.cardId : null,
      merchant: text(r.merchant),
      category: toCategory(r.category),
      note: text(r.note),
      source: r.source === 'ai' ? 'ai' : 'manual',
      createdAt: text(r.createdAt),
      updatedAt: text(r.updatedAt)
    }
  },
  fromInput: (id, input, createdAt, updatedAt) => ({ id, ...expenseFields(input), createdAt, updatedAt }),
  withInput: (row, input, updatedAt) => ({ ...row, ...expenseFields(input), updatedAt }),
  compare: byDateThenCreated
}

export const CARDS_SPEC: RowTableSpec<ExpenseCard, ExpenseCardInput> = {
  name: 'expense-cards',
  table: 'expense_cards',
  channel: 'expense-cards-sync',
  order: ['created_at', 'id'],
  fromRow: (row: Row): ExpenseCard => ({
    id: text(row.id),
    name: text(row.name),
    last4: text(row.last4),
    kind: kindOf(row.kind),
    archived: row.archived === true,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at)
  }),
  toColumns: (clean) => {
    const f = cardFields(clean)
    return { name: f.name, last4: f.last4, kind: f.kind, archived: f.archived }
  },
  normalize: normalizeCard,
  toInput: (c) => ({ name: c.name, last4: c.last4, kind: c.kind, archived: c.archived }),
  hydrate: (raw) => {
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as Partial<Record<keyof ExpenseCard, unknown>>
    if (typeof r.id !== 'string' || r.id === '' || typeof r.name !== 'string' || r.name.trim() === '') return null
    return {
      id: r.id,
      name: r.name,
      last4: typeof r.last4 === 'string' && /^\d{4}$/.test(r.last4) ? r.last4 : '',
      kind: kindOf(r.kind),
      archived: r.archived === true,
      createdAt: text(r.createdAt),
      updatedAt: text(r.updatedAt)
    }
  },
  fromInput: (id, input, createdAt, updatedAt) => ({ id, ...cardFields(input), createdAt, updatedAt }),
  withInput: (row, input, updatedAt) => ({ ...row, ...cardFields(input), updatedAt }),
  compare: byCreated
}

export const BUDGETS_SPEC: RowTableSpec<ExpenseBudget, ExpenseBudgetInput> = {
  name: 'expense-budgets',
  table: 'expense_budgets',
  channel: 'expense-budgets-sync',
  order: ['created_at', 'id'],
  fromRow: (row: Row): ExpenseBudget => ({
    id: text(row.id),
    scope: row.scope as BudgetScope,
    target: text(row.target),
    monthlyLimit: Number(row.monthly_limit),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at)
  }),
  toColumns: (clean) => {
    const f = budgetFields(clean)
    return { scope: f.scope, target: f.target, monthly_limit: f.monthlyLimit }
  },
  normalize: normalizeBudget,
  toInput: (b) => ({ scope: b.scope, target: b.target, monthlyLimit: b.monthlyLimit }),
  hydrate: (raw) => {
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as Partial<Record<keyof ExpenseBudget, unknown>>
    if (typeof r.id !== 'string' || r.id === '' || !isScope(r.scope)) return null
    const limit = finite(r.monthlyLimit)
    if (limit === null || limit <= 0) return null
    return { id: r.id, scope: r.scope, target: text(r.target), monthlyLimit: limit, createdAt: text(r.createdAt), updatedAt: text(r.updatedAt) }
  },
  fromInput: (id, input, createdAt, updatedAt) => ({ id, ...budgetFields(input), createdAt, updatedAt }),
  withInput: (row, input, updatedAt) => ({ ...row, ...budgetFields(input), updatedAt }),
  compare: byCreated,
  // Ids come from (user, scope, target) (lib/stableId.ts): an add can meet a row this device never saw.
  stableIds: true,
  uniqueKey: (clean) => [
    ['scope', clean.scope],
    ['target', clean.target]
  ]
}

/** The three specs, for tests that run the same cases over each. */
export const ROW_SPECS = [EXPENSES_SPEC, CARDS_SPEC, BUDGETS_SPEC] as const

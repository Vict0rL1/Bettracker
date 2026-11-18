import { createRowTable } from './rowTable'
import { BUDGETS_SPEC, CARDS_SPEC, EXPENSES_SPEC } from './expenseSpecs'

/** The tables of migration 008 on the server (see data/rowTable.ts). Module constants: hooks may depend on them. */
export const expensesTable = createRowTable(EXPENSES_SPEC)
export const cardsTable = createRowTable(CARDS_SPEC)
export const budgetsTable = createRowTable(BUDGETS_SPEC)

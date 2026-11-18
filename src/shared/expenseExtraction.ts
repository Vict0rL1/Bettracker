/**
 * What the app and the AI reading of receipts (the `extract-expenses` Edge
 * Function) share about expenses. Zero imports and no `export … from`: the
 * renderer, vitest (Node) and Deno all load this one file, so it must stand
 * alone (see the guard test).
 *
 * For now it holds the fixed list of expense categories; the request and
 * answer contract, the prompt, the schema and the validators join it with the
 * AI reading.
 */

/** The fixed expense categories, in the order the app offers them. A key the app doesn't know reads as 'other'. */
export const EXPENSE_CATEGORIES = ['coffee', 'food', 'groceries', 'transport', 'shopping', 'entertainment', 'health', 'home', 'subscriptions', 'travel', 'other'] as const
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]

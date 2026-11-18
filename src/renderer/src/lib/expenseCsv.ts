import type { Expense, ExpenseCard } from '../../../shared/types'
import { escapeField, guardCell } from './csv'
import { todayStr } from './dates'

/**
 * The expenses as a CSV file, for a spreadsheet. Written the way the bets'
 * export is (BOM + CRLF, formula guard on every text cell); the bets' CSV
 * itself is unchanged. The amounts are as stored (+ spent, − refunded) in the
 * expense currency, which every row names.
 */

/**
 * The last three came with expenses paid in another currency (migration 009),
 * at the END so a sheet built on the first nine keeps working: what was paid
 * (signed like `amount`), its ISO code, and the rate to `currency`. All three
 * are empty for an expense in the user's own currency.
 */
export const EXPENSE_COLUMNS = ['date', 'amount', 'currency', 'card', 'card_last4', 'merchant', 'category', 'note', 'source', 'original_amount', 'original_currency', 'fx_rate'] as const

/** A rate as written: up to 8 decimals (as stored), without the zeros that say nothing ("1.4034", "0.00034123", "2"). */
const rateText = (rate: number): string => rate.toFixed(8).replace(/\.?0+$/, '')

const text = (s: string): string => escapeField(guardCell(s))

/**
 * BOM + CRLF like betsToCsv; sorted by date then createdAt; amount toFixed(2) signed; text cells through guardCell +
 * escapeField; unknown card → ''. The original amount is written like the amount (toFixed(2), signed) and the rate with
 * up to 8 decimals; both, and the code, are '' for an expense in the user's own currency.
 */
export function expensesToCsv(list: readonly Expense[], cards: readonly ExpenseCard[], currency: string): string {
  const byId = new Map(cards.map((c) => [c.id, c]))
  const sorted = [...list].sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  )
  const lines = [
    EXPENSE_COLUMNS.join(','),
    ...sorted.map((e) => {
      const card = e.cardId === null ? undefined : byId.get(e.cardId)
      const foreign = e.originalAmount !== null && e.originalCurrency !== null && e.fxRate !== null
      return [
        e.date,
        e.amount.toFixed(2),
        text(currency),
        text(card?.name ?? ''),
        text(card?.last4 ?? ''),
        text(e.merchant),
        text(e.category),
        text(e.note),
        text(e.source),
        foreign ? (e.originalAmount as number).toFixed(2) : '',
        foreign ? text(e.originalCurrency as string) : '',
        foreign ? rateText(e.fxRate as number) : ''
      ].join(',')
    })
  ]
  return '﻿' + lines.join('\r\n') + '\r\n'
}

/** Downloads bettracker-expenses-YYYY-MM-DD.csv (local date); returns the row count. Works in the PWA and Electron alike. */
export function downloadExpensesCsv(list: readonly Expense[], cards: readonly ExpenseCard[], currency: string): number {
  const blob = new Blob([expensesToCsv(list, cards, currency)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `bettracker-expenses-${todayStr()}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return list.length
}

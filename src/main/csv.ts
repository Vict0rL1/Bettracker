import type { BetEntry } from '../shared/types'

function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** UTF-8 BOM + CRLF so Excel opens the file cleanly on every platform. */
export function entriesToCsv(entries: readonly BetEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : 1))
  const lines = ['date,amount,note', ...sorted.map((e) => `${e.date},${e.amount.toFixed(2)},${escapeField(e.note)}`)]
  return '\ufeff' + lines.join('\r\n') + '\r\n'
}

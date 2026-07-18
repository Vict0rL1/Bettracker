import type { BetEntry } from '../../../shared/types'

function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** UTF-8 BOM + CRLF so Excel opens the file cleanly on every platform. */
export function entriesToCsv(entries: readonly BetEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : 1))
  const lines = [
    'date,amount,note',
    ...sorted.map((e) => `${e.date},${e.amount.toFixed(2)},${escapeField(e.note)}`)
  ]
  return '\ufeff' + lines.join('\r\n') + '\r\n'
}

/** Trigger a browser download of the entries as a CSV file. Works in the PWA and Electron alike. */
export function downloadCsv(entries: readonly BetEntry[]): number {
  const stamp = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const name = `bettracker-export-${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}.csv`
  const blob = new Blob([entriesToCsv(entries)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return entries.length
}

import type { BetEntry, EntryInput } from '../../../shared/types'
import { isValidDate } from './validate'

const COLUMNS = ['date', 'stake', 'amount', 'sport', 'book', 'bet_type', 'note'] as const

function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** UTF-8 BOM + CRLF so Excel opens the file cleanly on every platform. */
export function entriesToCsv(entries: readonly BetEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : 1))
  const lines = [
    COLUMNS.join(','),
    ...sorted.map((e) =>
      [
        e.date,
        e.stake === null ? '' : e.stake.toFixed(2),
        e.amount.toFixed(2),
        escapeField(e.sport),
        escapeField(e.book),
        escapeField(e.betType),
        escapeField(e.note)
      ].join(',')
    )
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

/**
 * Split CSV text into rows of fields, honouring quoted fields that contain
 * commas, quotes ("" escapes) and newlines. Accepts CRLF or LF line endings.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  const endField = (): void => {
    row.push(field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    // Ignore blank trailing lines rather than importing an empty bet.
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }

  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"' && field === '') quoted = true
    else if (c === ',') endField()
    else if (c === '\n') endRow()
    else if (c === '\r') continue
    else field += c
  }
  if (field !== '' || row.length > 0) endRow()
  return rows
}

export interface ImportResult {
  rows: EntryInput[]
  /** Human-readable problems, one per rejected line, capped for display. */
  errors: string[]
  skipped: number
}

const ALIASES: Record<string, (typeof COLUMNS)[number]> = {
  date: 'date',
  day: 'date',
  stake: 'stake',
  risk: 'stake',
  wagered: 'stake',
  amount: 'amount',
  result: 'amount',
  profit: 'amount',
  pl: 'amount',
  'p/l': 'amount',
  sport: 'sport',
  league: 'sport',
  book: 'book',
  bookmaker: 'book',
  sportsbook: 'book',
  bet_type: 'bet_type',
  bettype: 'bet_type',
  type: 'bet_type',
  market: 'bet_type',
  note: 'note',
  notes: 'note',
  comment: 'note'
}

/** Money may arrive as "$1,234.50", "(45.00)" for negatives, or plain "-45". */
function parseMoney(raw: string): number | null {
  const cleaned = raw.trim().replace(/[$\s,]/g, '')
  if (cleaned === '') return null
  const negated = /^\(.*\)$/.test(cleaned)
  const body = negated ? cleaned.slice(1, -1) : cleaned
  const n = Number(body)
  if (!Number.isFinite(n)) return null
  return negated ? -n : n
}

/**
 * Turn CSV text into entries ready to import.
 *
 * A header row is required so columns can be matched by name — order and extra
 * columns don't matter, and common aliases from other trackers are accepted.
 * Bad lines are reported rather than silently dropped or half-guessed.
 */
export function parseEntriesCsv(text: string): ImportResult {
  const rows = parseCsv(text)
  if (rows.length === 0) return { rows: [], errors: ['The file is empty.'], skipped: 0 }

  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''))
  const index: Partial<Record<(typeof COLUMNS)[number], number>> = {}
  header.forEach((name, i) => {
    const key = ALIASES[name]
    if (key && index[key] === undefined) index[key] = i
  })

  if (index.date === undefined || index.amount === undefined) {
    return {
      rows: [],
      errors: ['The file needs a header row with at least a "date" and an "amount" column.'],
      skipped: 0
    }
  }

  const at = (row: string[], key: (typeof COLUMNS)[number]): string => {
    const i = index[key]
    return i === undefined ? '' : (row[i] ?? '')
  }

  const out: EntryInput[] = []
  const errors: string[] = []
  let skipped = 0

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const line = r + 1
    const date = at(row, 'date').trim()
    if (!isValidDate(date)) {
      skipped++
      if (errors.length < 5) errors.push(`Line ${line}: "${date}" is not a YYYY-MM-DD date.`)
      continue
    }
    const amount = parseMoney(at(row, 'amount'))
    if (amount === null) {
      skipped++
      if (errors.length < 5) errors.push(`Line ${line}: "${at(row, 'amount')}" is not a number.`)
      continue
    }
    const stakeRaw = at(row, 'stake')
    const stake = parseMoney(stakeRaw)
    if (stakeRaw.trim() !== '' && (stake === null || stake < 0)) {
      skipped++
      if (errors.length < 5) errors.push(`Line ${line}: "${stakeRaw}" is not a valid stake.`)
      continue
    }
    out.push({
      date,
      amount,
      stake,
      sport: at(row, 'sport').trim(),
      book: at(row, 'book').trim(),
      betType: at(row, 'bet_type').trim(),
      note: at(row, 'note').trim()
    })
  }

  if (skipped > errors.length) errors.push(`…and ${skipped - errors.length} more skipped ${skipped - errors.length === 1 ? 'line' : 'lines'}.`)
  return { rows: out, errors, skipped }
}

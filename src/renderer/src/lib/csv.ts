import type { Bet, BetInput, BetStatus } from '../../../shared/types'
import { isValidDate, normalizeInput } from './validate'

const COLUMNS = ['date', 'status', 'stake', 'odds', 'amount', 'sport', 'book', 'bet_type', 'note'] as const
type Column = (typeof COLUMNS)[number]

function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * Spreadsheets read a cell that starts with one of these as a formula, so a
 * note like "=HYPERLINK(...)" typed into the app would run when the export is
 * opened in Excel. A leading apostrophe makes the cell plain text.
 *
 * The apostrophe itself is in the set, so a value that genuinely starts with
 * one is written with two: `unguardCell` strips exactly one, and the round
 * trip is lossless either way.
 */
const FORMULA_START = /^[=+\-@\t\r']/

export const guardCell = (value: string): string => (FORMULA_START.test(value) ? `'${value}` : value)

export const unguardCell = (value: string): string => (value.startsWith("'") ? value.slice(1) : value)

const money = (n: number | null): string => (n === null ? '' : n.toFixed(2))
const odds = (n: number | null): string => (n === null ? '' : String(n))

/** UTF-8 BOM + CRLF so Excel opens the file cleanly on every platform. */
export function betsToCsv(bets: readonly Bet[]): string {
  const sorted = [...bets].sort((a, b) => (a.date < b.date ? -1 : 1))
  const lines = [
    COLUMNS.join(','),
    ...sorted.map((b) =>
      [
        b.date,
        b.status,
        money(b.stake),
        odds(b.odds),
        money(b.amount),
        escapeField(guardCell(b.sport)),
        escapeField(guardCell(b.book)),
        escapeField(guardCell(b.betType)),
        escapeField(guardCell(b.note))
      ].join(',')
    )
  ]
  return '﻿' + lines.join('\r\n') + '\r\n'
}

/** Trigger a browser download of the bets as a CSV file. Works in the PWA and Electron alike. */
export function downloadCsv(bets: readonly Bet[]): number {
  const stamp = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const name = `bettracker-export-${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}.csv`
  const blob = new Blob([betsToCsv(bets)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return bets.length
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
  rows: BetInput[]
  /** Human-readable problems, one per rejected line, capped for display. */
  errors: string[]
  skipped: number
  /** Imported rows that carry no stake — they'll stay out of ROI. */
  noStake: number
}

/**
 * Header names this importer understands, mapped to our columns. Covers our
 * own exports (every version), and the words other trackers tend to use.
 * `session` is what a row used to be called here, before one row meant one
 * bet; a column by that name carries the description, so it lands in the note.
 */
const ALIASES: Record<string, Column> = {
  date: 'date',
  day: 'date',
  placed: 'date',
  placed_on: 'date',
  status: 'status',
  result: 'status',
  outcome: 'status',
  stake: 'stake',
  risk: 'stake',
  wagered: 'stake',
  wager: 'stake',
  odds: 'odds',
  price: 'odds',
  decimal_odds: 'odds',
  'decimal odds': 'odds',
  amount: 'amount',
  profit: 'amount',
  net: 'amount',
  pl: 'amount',
  'p/l': 'amount',
  sport: 'sport',
  league: 'sport',
  book: 'book',
  bookmaker: 'book',
  sportsbook: 'book',
  bet_type: 'bet_type',
  bettype: 'bet_type',
  'bet type': 'bet_type',
  type: 'bet_type',
  market: 'bet_type',
  note: 'note',
  notes: 'note',
  comment: 'note',
  session: 'note',
  selection: 'note'
}

const STATUS_WORDS: Record<string, BetStatus> = {
  won: 'won',
  win: 'won',
  w: 'won',
  winner: 'won',
  lost: 'lost',
  loss: 'lost',
  lose: 'lost',
  l: 'lost',
  push: 'push',
  p: 'push',
  tie: 'push',
  draw: 'push',
  void: 'void',
  v: 'void',
  cancelled: 'void',
  canceled: 'void',
  refund: 'void',
  refunded: 'void',
  pending: 'pending',
  open: 'pending',
  unsettled: 'pending'
}

/** Money may arrive as "$1,234.50", "(45.00)" for negatives, or plain "-45". */
function parseMoney(raw: string): number | null {
  const cleaned = raw.trim().replace(/[$€£\s,]/g, '')
  if (cleaned === '') return null
  const negated = /^\(.*\)$/.test(cleaned)
  const body = negated ? cleaned.slice(1, -1) : cleaned
  const n = Number(body)
  if (!Number.isFinite(n)) return null
  return negated ? -n : n
}

/** Decimal odds only for now: "1.91", "2,50" (European comma) and "2.5" all read. */
function parseOdds(raw: string): number | null {
  const cleaned = raw.trim().replace(',', '.')
  if (cleaned === '') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/**
 * Turn CSV text into bets ready to import.
 *
 * A header row is required so columns can be matched by name — order and extra
 * columns don't matter, and common aliases from other trackers are accepted.
 * Files from before odds and statuses existed import unchanged: the status is
 * whatever the amount implies, as it always was. Bad lines are reported rather
 * than silently dropped or half-guessed.
 */
export function parseBetsCsv(text: string): ImportResult {
  const rows = parseCsv(text)
  if (rows.length === 0) return { rows: [], errors: ['The file is empty.'], skipped: 0, noStake: 0 }

  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''))
  const index: Partial<Record<Column, number>> = {}
  header.forEach((name, i) => {
    const key = ALIASES[name]
    if (key && index[key] === undefined) index[key] = i
  })

  // Some trackers call the net result "result". If that column holds numbers
  // rather than won/lost words — and there is no amount column — it IS the
  // amount, and reading it as a status would reject every line.
  if (index.amount === undefined && index.status !== undefined && header[index.status] === 'result') {
    const col = index.status
    const values = rows.slice(1).map((r) => (r[col] ?? '').trim()).filter(Boolean)
    if (values.length > 0 && values.every((v) => parseMoney(v) !== null)) {
      index.amount = col
      delete index.status
    }
  }

  if (index.date === undefined || (index.amount === undefined && index.status === undefined)) {
    return {
      rows: [],
      errors: ['The file needs a header row with a "date" column and an "amount" or "status" column.'],
      skipped: 0,
      noStake: 0
    }
  }

  const at = (row: string[], key: Column): string => {
    const i = index[key]
    return i === undefined ? '' : (row[i] ?? '')
  }

  const out: BetInput[] = []
  const errors: string[] = []
  let skipped = 0
  let noStake = 0
  const reject = (line: number, why: string): void => {
    skipped++
    if (errors.length < 5) errors.push(`Line ${line}: ${why}`)
  }

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const line = r + 1
    const date = at(row, 'date').trim()
    if (!isValidDate(date)) {
      reject(line, `"${date}" is not a YYYY-MM-DD date.`)
      continue
    }

    const amountRaw = at(row, 'amount')
    const amount = parseMoney(amountRaw)
    if (amountRaw.trim() !== '' && amount === null) {
      reject(line, `"${amountRaw}" is not a number.`)
      continue
    }

    // A status word wins; anything else (blank, or a number from a tracker
    // that calls the result column "result") falls back to the amount's sign.
    const statusRaw = at(row, 'status').trim().toLowerCase()
    const status: BetStatus | undefined = STATUS_WORDS[statusRaw]
    if (status === undefined && amount === null) {
      reject(line, statusRaw ? `"${at(row, 'status')}" is not a bet status.` : 'no amount and no status.')
      continue
    }

    const stakeRaw = at(row, 'stake')
    const stake = parseMoney(stakeRaw)
    if (stakeRaw.trim() !== '' && (stake === null || stake < 0)) {
      reject(line, `"${stakeRaw}" is not a valid stake.`)
      continue
    }

    const oddsRaw = at(row, 'odds')
    const odds = parseOdds(oddsRaw)
    if (oddsRaw.trim() !== '' && (odds === null || odds <= 1)) {
      reject(line, `"${oddsRaw}" is not a decimal price above 1.`)
      continue
    }

    const input: BetInput = {
      date,
      // A push or void with no amount column is still a 0; a pending bet has none.
      amount: status === 'pending' ? null : status === 'push' || status === 'void' ? (amount ?? 0) : amount,
      stake,
      odds,
      ...(status !== undefined ? { status } : {}),
      sport: unguardCell(at(row, 'sport').trim()),
      book: unguardCell(at(row, 'book').trim()),
      betType: unguardCell(at(row, 'bet_type').trim()),
      note: unguardCell(at(row, 'note').trim())
    }

    // The same checks the form and the writer apply, so a contradictory row
    // ("won" with a negative amount) is reported here instead of failing later.
    try {
      normalizeInput(input)
    } catch (err) {
      reject(line, err instanceof Error ? err.message : String(err))
      continue
    }

    if (stake === null) noStake++
    out.push(input)
  }

  if (skipped > errors.length) {
    const more = skipped - errors.length
    errors.push(`…and ${more} more skipped ${more === 1 ? 'line' : 'lines'}.`)
  }
  return { rows: out, errors, skipped, noStake }
}

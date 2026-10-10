import type { Bet, BetInput, BetStatus, OddsFormat } from '../../../shared/types'
import { fromAmerican, fromFractional } from './odds'
import { isValidDate, normalizeInput, storableOdds } from './validate'

const COLUMNS = ['date', 'status', 'stake', 'odds', 'closing_odds', 'amount', 'sport', 'book', 'bet_type', 'note'] as const
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
        odds(b.closingOdds),
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
  american_odds: 'odds',
  'american odds': 'odds',
  us_odds: 'odds',
  'us odds': 'odds',
  fractional_odds: 'odds',
  'fractional odds': 'odds',
  uk_odds: 'odds',
  'uk odds': 'odds',
  closing_odds: 'closing_odds',
  'closing odds': 'closing_odds',
  closing: 'closing_odds',
  close: 'closing_odds',
  closing_price: 'closing_odds',
  'closing price': 'closing_odds',
  closing_line: 'closing_odds',
  'closing line': 'closing_odds',
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

/*
 * Odds cells. Each is read into a shape before anything is decided:
 *  - a fraction ("3/2", "10:11", "100-1");
 *  - a signed price ("+150", "-110", "-110.00", "+2,500"): American, or a
 *    decimal written with a plus and a decimal point when it can't be
 *    American ("+2.5", "+3.00");
 *  - a plain number: decimal ("1.91", "2,50", "3", "2."), except when its
 *    value is a whole number from 100 up ("150", "150.00"), which is
 *    ambiguous: +150 whose plus sign a spreadsheet dropped, or a 150.0
 *    longshot in decimal, which is how this app's own exports write one;
 *  - "1,200": a thousands separator (American +1200) or a decimal comma
 *    (1.2), ambiguous the same way.
 * The ambiguous ones are settled once per file (see oddsReading).
 */
type OddsShape =
  | { kind: 'blank' }
  | { kind: 'bad' }
  /**
   * Says its own format; `value` is null when it is no valid price.
   * `evidence` is the format it shows, counted only when the price can be
   * stored: a typo must not tip how the rest of the file reads.
   */
  | { kind: 'price'; value: number | null; evidence: 'american' | 'decimal' | null }
  | { kind: 'whole'; n: number }
  | { kind: 'grouped'; thousands: number; decimalComma: number }

const FRACTION = /^\d+(\.\d+)?\s*[/:-]\s*\d+(\.\d+)?$/

/** The unsigned part of a number as written: "1.91", "2,50", "2.", "1,234.5". NaN when it is none. */
function unsignedValue(t: string): number {
  if (/^\d+(\.\d*)?$/.test(t)) return Number(t)
  if (GROUPED.test(t)) return Number(t.replace(/,/g, ''))
  if (/^\d+,\d+$/.test(t)) return Number(t.replace(',', '.'))
  return NaN
}

/** Thousands groups: "1,200", "12,500", "1,234.5" (never "0,150", which can only be a decimal comma). */
const GROUPED = /^[1-9]\d{0,2}(,\d{3})+(\.\d*)?$/

/** A shape that says its format, with that format counted as evidence only when the price can be stored. */
const price = (value: number | null, format: 'american' | 'decimal'): OddsShape => ({
  kind: 'price',
  value,
  evidence: value !== null && storableOdds(value) ? format : null
})

function oddsShape(raw: string): OddsShape {
  // Sportsbook pages write minus as U+2212 (or an en dash); a copy keeps it.
  const s = raw.trim().replace(/[\u2212\u2013]/g, '-')
  if (s === '') return { kind: 'blank' }
  if (FRACTION.test(s)) return { kind: 'price', value: fromFractional(s), evidence: null }

  const sign = s[0] === '+' || s[0] === '-' ? s[0] : ''
  const body = sign ? s.slice(1) : s
  if (sign) {
    // With a sign there is no doubt: "+2,500" is grouped, "+2,5" a decimal comma.
    const n = unsignedValue(body)
    if (!Number.isFinite(n)) return { kind: 'bad' }
    if (n >= 100) return price(fromAmerican(sign === '-' ? -n : n), 'american')
    // No American price lies between -100 and +100, so "+2.5" or "+3.00",
    // written with a decimal point, can only be decimal. A bare "+3" or "+50"
    // looks like a mistyped American price and is reported instead.
    if (sign === '+' && /[.,]/.test(body) && n > 1) return price(n, 'decimal')
    return { kind: 'price', value: null, evidence: null }
  }

  if (/^[1-9]\d{0,2},\d{3}$/.test(body)) {
    return { kind: 'grouped', thousands: Number(body.replace(',', '')), decimalComma: Number(body.replace(',', '.')) }
  }
  const n = unsignedValue(body)
  if (!Number.isFinite(n)) return { kind: 'bad' }
  if (Number.isInteger(n) && n >= 100) return { kind: 'whole', n }
  return price(n > 1 ? n : null, 'decimal')
}

/**
 * How a file's ambiguous odds read: 'american' or 'decimal'; null when the
 * file mixes both and can't say; 'unknown' when nothing in it says either.
 */
type OddsReading = 'american' | 'decimal' | null | 'unknown'

/** The format a header names, if it names one ("American odds", "decimal_odds", "US odds"). */
function headerFormat(name: string | undefined): 'american' | 'decimal' | null {
  if (name === undefined) return null
  if (/american|^us[ _]/.test(name)) return 'american'
  if (/decimal/.test(name)) return 'decimal'
  return null
}

/** Every header this app's exports have had that carries odds. They always write decimal. */
const OWN_EXPORT_HEADERS = new Set([
  'date,status,stake,odds,amount,sport,book,bet_type,note',
  'date,status,stake,odds,closing_odds,amount,sport,book,bet_type,note'
])

/**
 * Settle the ambiguous odds of a file, once for both odds columns:
 *  - one of this app's own exports is decimal (they never write a sign, so
 *    a signed price in one means it was edited by hand: read on as below);
 *  - a header that names a format decides;
 *  - otherwise valid signed prices and no decimals mean American, valid
 *    decimals and no signed prices mean decimal, both mean the file mixes
 *    formats;
 *  - with nothing to go by, a "1,200" in the file makes it decimal (that is
 *    how the odds box reads one), so its whole numbers read the same way;
 *    a file without one is 'unknown' and follows the user's format.
 */
function oddsReading(header: readonly string[], oddsHeaders: readonly (string | undefined)[], shapes: readonly OddsShape[]): OddsReading {
  const american = shapes.some((x) => x.kind === 'price' && x.evidence === 'american')
  const decimal = shapes.some((x) => x.kind === 'price' && x.evidence === 'decimal')
  if (OWN_EXPORT_HEADERS.has(header.join(',')) && !american) return 'decimal'
  const named = oddsHeaders.map(headerFormat).find((f) => f !== null)
  if (named) return named
  if (american && decimal) return null
  if (american) return 'american'
  if (decimal) return 'decimal'
  if (shapes.some((x) => x.kind === 'grouped')) return 'decimal'
  return 'unknown'
}

type OddsCell = { ok: true; value: number | null } | { ok: false; why: string }

/**
 * One odds cell as a decimal price. Blank is no odds; anything else must be
 * a real price. A whole number from 100 up with nothing in the file to place
 * it follows the user's odds format, like the odds box; "1,200" with nothing
 * to place it is a decimal comma, also like the odds box. `what` names the
 * cell in a message: "price" or "closing price".
 */
function readOdds(raw: string, shape: OddsShape, reading: OddsReading, fallback: OddsFormat, what: string): OddsCell {
  const cell = raw.trim()
  const notAPrice: OddsCell = { ok: false, why: `"${cell}" is not a ${what} (decimal above 1, American like +150 or -110, or a fraction like 3/2).` }
  const mixed = (american: string, decimal: string): OddsCell => ({
    ok: false,
    why: `"${cell}" could be American (${american}) or decimal (${decimal}) — this file has both kinds of odds; write it with a sign, or name the format in the header ("american odds" or "decimal odds").`
  })
  switch (shape.kind) {
    case 'blank':
      return { ok: true, value: null }
    case 'bad':
      return notAPrice
    case 'price':
      return shape.value === null ? notAPrice : { ok: true, value: shape.value }
    case 'whole': {
      if (reading === null) return mixed(`+${shape.n}`, `${shape.n}.0`)
      const american = reading === 'american' || (reading === 'unknown' && fallback === 'american')
      return { ok: true, value: american ? (fromAmerican(shape.n) as number) : shape.n }
    }
    case 'grouped': {
      if (reading === null) return mixed(`+${shape.thousands}`, String(shape.decimalComma))
      const value = reading === 'american' ? fromAmerican(shape.thousands) : shape.decimalComma
      return value !== null && value > 1 ? { ok: true, value } : notAPrice
    }
  }
}

/**
 * Turn CSV text into bets ready to import.
 *
 * A header row is required so columns can be matched by name — order and extra
 * columns don't matter, and common aliases from other trackers are accepted.
 * Files from before odds and statuses existed import unchanged: the status is
 * whatever the amount implies, as it always was. Bad lines are reported rather
 * than silently dropped or half-guessed.
 *
 * Odds may be decimal, American or fractional (see oddsShape); `oddsFormat`
 * is the user's setting, used only when a file gives no other clue.
 */
export function parseBetsCsv(text: string, oddsFormat: OddsFormat = 'decimal'): ImportResult {
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

  const body = rows.slice(1)
  const oddsShapes = body.map((r) => oddsShape(at(r, 'odds')))
  const closingShapes = body.map((r) => oddsShape(at(r, 'closing_odds')))
  const reading = oddsReading(
    header,
    [index.odds, index.closing_odds].map((i) => (i === undefined ? undefined : header[i])),
    [...oddsShapes, ...closingShapes]
  )

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

    const odds = readOdds(at(row, 'odds'), oddsShapes[r - 1], reading, oddsFormat, 'price')
    if (!odds.ok) {
      reject(line, odds.why)
      continue
    }

    const closing = readOdds(at(row, 'closing_odds'), closingShapes[r - 1], reading, oddsFormat, 'closing price')
    if (!closing.ok) {
      reject(line, closing.why)
      continue
    }

    const input: BetInput = {
      date,
      // A push or void with no amount column is still a 0; a pending bet has none.
      amount: status === 'pending' ? null : status === 'push' || status === 'void' ? (amount ?? 0) : amount,
      stake,
      odds: odds.value,
      closingOdds: closing.value,
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

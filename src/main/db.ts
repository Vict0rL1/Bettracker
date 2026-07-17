import Database from 'better-sqlite3'
import type { BetEntry, EntryInput } from '../shared/types'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_AMOUNT = 100_000_000
const MAX_NOTE_LENGTH = 500

const SELECT_COLS = 'id, date, amount, note, created_at AS createdAt, updated_at AS updatedAt'

function assertValidDate(date: unknown): asserts date is string {
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    throw new Error('Date must be a YYYY-MM-DD string')
  }
  const [y, m, d] = date.split('-').map(Number)
  const parsed = new Date(y, m - 1, d)
  if (parsed.getFullYear() !== y || parsed.getMonth() !== m - 1 || parsed.getDate() !== d) {
    throw new Error(`"${date}" is not a real calendar date`)
  }
}

function normalizeInput(input: EntryInput): { date: string; amount: number; note: string } {
  assertValidDate(input.date)
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount)) {
    throw new Error('Amount must be a finite number')
  }
  if (Math.abs(input.amount) > MAX_AMOUNT) {
    throw new Error('Amount is out of range')
  }
  if (input.note != null && typeof input.note !== 'string') {
    throw new Error('Note must be a string')
  }
  return {
    date: input.date,
    amount: Math.round(input.amount * 100) / 100,
    note: (input.note ?? '').trim().slice(0, MAX_NOTE_LENGTH)
  }
}

export class BetDb {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        amount REAL NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
  }

  getAll(): BetEntry[] {
    return this.db.prepare(`SELECT ${SELECT_COLS} FROM entries ORDER BY date ASC`).all() as BetEntry[]
  }

  /** Insert the day's entry, or replace amount/note if the day is already logged. */
  upsert(input: EntryInput): BetEntry {
    const row = normalizeInput(input)
    return this.db
      .prepare(
        `INSERT INTO entries (date, amount, note) VALUES (@date, @amount, @note)
         ON CONFLICT(date) DO UPDATE SET
           amount = excluded.amount,
           note = excluded.note,
           updated_at = datetime('now')
         RETURNING ${SELECT_COLS}`
      )
      .get(row) as BetEntry
  }

  remove(date: string): boolean {
    assertValidDate(date)
    return this.db.prepare('DELETE FROM entries WHERE date = ?').run(date).changes > 0
  }

  close(): void {
    this.db.close()
  }
}

import type * as Extraction from '../../../shared/expenseExtraction'

/**
 * The part of the AI contract (src/shared/expenseExtraction.ts) the fake
 * server answers with, as the page holds it in `window.__expenseExtraction`.
 * `installFakeSupabase` is sent to the page as source text, so it can't import
 * the module itself: whoever installs it puts the module in the page first
 * (demo/start.ts imports it; the e2e harness compiles it into an init script;
 * the unit tests set it). So the fake checks a scan request exactly as the Edge
 * Function does, and the two can't drift.
 */
export type ExtractionContract = Pick<typeof Extraction, 'parseExtractRequest' | 'failBody' | 'EXTRACT_STATUS'>

export interface FakeSupabaseConfig {
  /** Where the fake server keeps its state in localStorage: 'e2e:' for the tests, 'demo:' for the demo. */
  prefix: string
  user: { id: string; email: string }
  /**
   * The demo: signing in takes any email and password and signing out signs
   * out, and while the browser is offline every request fails the way a
   * failed fetch does. Without it (the e2e harness) the session is fixed and
   * an outage is `${prefix}down`.
   */
  demo: boolean
}

/**
 * Installs `window.__supabaseMock`, which `lib/supabase.ts` uses instead of a
 * real client: a signed-in session against a small in-memory server holding
 * the bets, the settings row, the deposits and withdrawals, and the
 * expenses, cards and budgets, with the
 * PostgREST behaviour the app relies on — inserts (a duplicate id is 23505),
 * updates guarded by `updated_at <= editedAt` (the conflict rule), deletes and
 * upserts. Its state lives in localStorage so it survives reloads, like a
 * real database. With the e2e prefix:
 *  - `e2e:rows`      the bets;
 *  - `e2e:settings`  the user_settings row, if any;
 *  - `e2e:moves`     the bankroll_moves rows;
 *  - `e2e:expenses`, `e2e:expense-cards`, `e2e:expense-budgets`  the rows
 *                    of the tables of migration 008;
 *  - `e2e:migrated`  unset = the database is missing migration 004: reads
 *                    work, every add or edit (they all name closing_odds) is
 *                    refused (PGRST204), deletes go through, and the settings
 *                    table is missing (PGRST205). Setting it stands for
 *                    running the migration;
 *  - `e2e:migrated-005`  unset = the database is missing migration 005: the
 *                    bankroll_moves table is missing, so every request for
 *                    it, reads and deletes too, is refused (PGRST205);
 *  - `e2e:latency`   milliseconds before each answer, to leave a request on
 *                    the wire while the test keeps using the app;
 *  - `e2e:writes`    how many write requests have been answered, so a test
 *                    can wait for a retry to have happened;
 *  - `e2e:writes-started`  how many write requests have gone out, answered
 *                    or not, so a test can act while one is on the wire;
 *  - `e2e:down`      set: the connection is down, and every request fails
 *                    the way supabase-js reports a failed fetch;
 *  - `e2e:max-rows`  the most rows one read answers (PostgREST's max-rows),
 *                    when lower than the page asked for;
 *  - `e2e:fail`      `{ status, message, code?, times }`: the next `times`
 *                    writes are refused with that status (a 503, a 429, a
 *                    400 for good) and change nothing;
 *  - `e2e:writes-left`  that many more writes go through; after them the
 *                    connection drops for writes (an import cut halfway);
 *  - `e2e:signed-out`  the session has ended (see `__endSession`);
 *  - `e2e:fail-reads`  `{ table, status, message, times }`: the next `times`
 *                    reads of that table fail with that status (a 503);
 *  - `e2e:hold`      set: every write waits on the wire, unanswered, until
 *                    it is cleared, so a test acts while one is out for as
 *                    long as it needs, whatever the machine's speed;
 *  - `e2e:hold-reads`  a table: each read of it is answered at once, as the
 *                    database is then, but handed over only once this is
 *                    cleared, after whatever writes land meanwhile (a read
 *                    that comes back late); `e2e:reads-held` counts them,
 *                    and `e2e:reads-delivered` the ones handed over since
 *                    (each also as `…@<window>`, that window's alone: see
 *                    `__win`);
 *                    `table:list` holds only the reads of the whole list
 *                    (the app's refresh), not a lookup of some rows;
 *                    `e2e:hold-reads@<window>` holds that window's alone;
 *  - `e2e:migrated-007`  set: the database has migration 007: a deleted bet
 *                    or move leaves its last `updated_at` behind
 *                    (`e2e:tombstones`), and an insert of that id that is not
 *                    newer is let go (no row, no error), as an old insert
 *                    sent again would be;
 *  - `e2e:migrated-008`  unset = the database is missing migration 008: the
 *                    expenses, expense_cards and expense_budgets tables are
 *                    missing, so every request for them, reads and deletes
 *                    too, is refused (PGRST205), and a settings write that
 *                    names `expense_currency` is refused (PGRST204); the
 *                    settings row has that column only with it. Tombstones
 *                    of those three tables (`expenses:<id>`,
 *                    `expense-cards:<id>`, `expense-budgets:<id>`) need it;
 *  - `e2e:migrated-009`  unset = the database is missing migration 009 (an
 *                    expense paid in another currency): the expenses table
 *                    has no `original_amount`, `original_currency` or
 *                    `fx_rate`. Reads of it answer rows without those keys,
 *                    and an insert or update that names any of them is
 *                    refused (PGRST204, naming the first), whatever its
 *                    value; deletes go through. It needs 008;
 *  - `e2e:lose-answers`  that many more write answers are lost: the write
 *                    lands, and the app hears a failed fetch.
 * A row written without `updated_at` gets the time it was answered, as the
 * server's now() would. Answers carry the HTTP status PostgREST would give.
 *
 * The AI reading of receipts (`functions.invoke('extract-expenses')`), never a
 * network call: the request is checked as the Edge Function checks it
 * (`parseExtractRequest`: 400, 413 or 415 with its code), then answered with
 * two canned rows (today's coffee on the first card sent, yesterday's
 * groceries), or as these say:
 *  - `e2e:ai-rows`   JSON: an array is the rows; an object is merged into
 *                    the answer (`kind`, `currency`, `warnings`, …);
 *  - `e2e:ai-fail`   a code (not JSON): `offline`/`network` (a failed
 *                    fetch), `not_deployed` (the platform's 404), `relay`, or
 *                    any of the function's codes, with its HTTP status;
 *  - `e2e:ai-hold`   set: the answer waits until it is cleared, or until the
 *                    call is aborted (then a failed fetch, as functions-js
 *                    gives);
 *  - `e2e:ai-ignore-abort`  set: a held call keeps waiting after an abort,
 *                    then answers (a late answer the app must ignore);
 *  - `e2e:ai-calls`  calls that got past the hold (also `…@<window>`);
 *  - `e2e:ai-answered`  answers with rows;
 *  - `e2e:ai-last`   what the last call sent: the date, language, currency,
 *                    number of cards, media type, size and the first 32
 *                    base64 characters (never the image).
 * Calls honour `down`, `latency` and the session, never the write flags
 * (`fail`, `writes-left`, `lose-answers`, `hold`), and are no writes. The
 * demo's answer without flags is marked `sample: true`.
 *
 * `window.__supabaseMock.__endSession()` ends the session the way a sign-out
 * on another device does once this device's token runs out: getSession
 * answers none from then on, and the app hears SIGNED_OUT.
 *
 * The e2e harness hands this function to Playwright's `addInitScript`, which
 * sends its source text to the page: it must not use anything from outside
 * its own body. fakeSupabase.test.ts runs it from its source text alone, so
 * a reference to anything outside fails there first.
 */
export function installFakeSupabase(cfg: FakeSupabaseConfig): void {
  type Row = Record<string, unknown>
  interface Query {
    table: string
    action: 'select' | 'insert' | 'update' | 'upsert' | 'delete'
    payload: unknown
    eq: Record<string, unknown>
    lte: unknown
    lteSet: boolean
    /** `.range(from, to)`: the rows of one page, both ends included. */
    range: [number, number] | null
    /** upsert's `ignoreDuplicates`: ON CONFLICT DO NOTHING. */
    ignoreDuplicates: boolean
    /** `.in(column, values)`. */
    within: Record<string, unknown[]>
  }
  interface Answer {
    data: unknown
    error: { message: string; code: string } | null
    count?: number
    status?: number
  }
  type Listener = (event: string, session: unknown) => void

  const key = (name: string): string => cfg.prefix + name
  const read = <T>(name: string, fallback: T): T => {
    const raw = localStorage.getItem(key(name))
    return raw === null ? fallback : (JSON.parse(raw) as T)
  }
  const write = (name: string, value: unknown): void => localStorage.setItem(key(name), JSON.stringify(value))
  // This window, for the counters only it writes: two windows counting up one
  // key at once can lose a count (localStorage is not coherent across the
  // browser's processes), so each also counts under its own name.
  const win = Math.random().toString(36).slice(2, 10)
  const count = (name: string): void => {
    for (const k of [key(name), key(`${name}@${win}`)]) localStorage.setItem(k, String(Number(localStorage.getItem(k) || 0) + 1))
  }
  const flag = (name: string): boolean => localStorage.getItem(key(name)) === '1'

  const session = { access_token: cfg.prefix + 'session', user: { id: cfg.user.id, email: cfg.user.email } }
  const migrated = (): boolean => flag('migrated')
  const latency = (): number => Number(localStorage.getItem(key('latency')) || 0)
  /** A write waits while `hold` is set; a read never does. */
  const held = (q: { action: string }): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => void (q.action === 'select' || !flag('hold') ? resolve() : setTimeout(check, 20))
      check()
    })
  /** A read of the table `hold-reads` names, already answered, is handed over once that is cleared. */
  const late = (q: { action: string; table: string; eq: Record<string, unknown>; within: Record<string, unknown[]> }, out: Answer): Promise<Answer> =>
    new Promise((resolve) => {
      // `table:list`: only the reads of the whole list (no filter), not a lookup of some rows.
      const listRead = Object.keys(q.eq).length === 0 && Object.keys(q.within).length === 0
      const holding = (): boolean => {
        if (q.action !== 'select') return false
        return [localStorage.getItem(key('hold-reads')), localStorage.getItem(key(`hold-reads@${win}`))].some(
          (v) => v === q.table || (v === `${q.table}:list` && listRead)
        )
      }
      const held = holding()
      if (held) count('reads-held')
      const check = (): void => {
        if (holding()) return void setTimeout(check, 20)
        // Handed over now: a test waits for this before it looks.
        if (held) count('reads-delivered')
        resolve(out)
      }
      check()
    })
  const down = (): boolean => flag('down') || (cfg.demo && typeof navigator !== 'undefined' && navigator.onLine === false)
  const maxRows = (): number => Number(localStorage.getItem(key('max-rows')) || 0)
  const NO_COLUMN = { message: "Could not find the 'closing_odds' column of 'entries' in the schema cache", code: 'PGRST204' }
  const NO_TABLE = { message: "Could not find the table 'public.user_settings' in the schema cache", code: 'PGRST205' }
  const NO_MOVES_TABLE = { message: "Could not find the table 'public.bankroll_moves' in the schema cache", code: 'PGRST205' }
  const noTable = (t: string) => ({ message: `Could not find the table 'public.${t}' in the schema cache`, code: 'PGRST205' })
  const NO_CURRENCY_COLUMN = { message: "Could not find the 'expense_currency' column of 'user_settings' in the schema cache", code: 'PGRST204' }
  // Migration 009's columns of the expenses table.
  const ORIGINAL_COLUMNS = ['original_amount', 'original_currency', 'fx_rate']
  const noColumn = (column: string, t: string) => ({ message: `Could not find the '${column}' column of '${t}' in the schema cache`, code: 'PGRST204' })
  /** Before 009 the expenses have no such columns: rows are answered without those keys. */
  const before009 = (name: string): boolean => name === 'expenses' && !flag('migrated-009')
  const shown = (name: string, row: Row): Row => {
    if (!before009(name)) return row
    const out: Row = {}
    for (const k of Object.keys(row)) if (!ORIGINAL_COLUMNS.includes(k)) out[k] = row[k]
    return out
  }
  const stamp = (row: Row): Row => ({ created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...row })
  const duplicate = (constraint: string) => ({ message: `duplicate key value violates unique constraint "${constraint}"`, code: '23505' })
  const unmodelled = (what: string) => ({ message: `fake Supabase: ${what} is not modelled`, code: 'FAKE' })

  /** Every `.eq`/`.is` of the query holds for the row (timestamps compared as times). */
  const matches = (row: Row, q: Query): boolean =>
    Object.entries(q.eq).every(([col, want]) => {
      const have = row[col]
      if (want === null) return have === null || have === undefined
      if (col === 'updated_at' || col === 'created_at') return Date.parse(String(have)) === Date.parse(String(want))
      // PostgREST compares a number column with the text of the filter.
      return String(have) === String(want)
    }) && Object.entries(q.within).every(([col, list]) => list.map(String).includes(String(row[col])))
  const after = (a: unknown, b: unknown): boolean => Date.parse(String(a)) > Date.parse(String(b))
  /** Tombstones come with 007 for the bets and moves, and with 008 for its own tables (which use 007's triggers). */
  const stonesOn = (name: string): boolean => flag(name === 'expenses' || name === 'expense-cards' || name === 'expense-budgets' ? 'migrated-008' : 'migrated-007')
  /** Migration 007: an insert of a deleted id that is not newer than what was deleted is let go. */
  const buried = (table: string, row: Row): boolean => {
    if (!stonesOn(table)) return false
    const stones = read<Record<string, string>>('tombstones', {})
    const stone = stones[`${table}:${String(row.id)}`]
    return stone !== undefined && !after(row.updated_at ?? new Date().toISOString(), stone)
  }
  const bury = (table: string, gone: Row[]): void => {
    if (!stonesOn(table) || gone.length === 0) return
    const stones = read<Record<string, string>>('tombstones', {})
    for (const r of gone) {
      const k = `${table}:${String(r.id)}`
      if (stones[k] === undefined || after(r.updated_at, stones[k])) stones[k] = String(r.updated_at)
    }
    write('tombstones', stones)
  }

  function settings(q: Query): Answer {
    if (!migrated()) return { data: null, error: NO_TABLE }
    // The currency column is there with 008 (default 'USD'), and only then.
    const stored = read<Row | null>('settings', null)
    let row = stored
    if (row && flag('migrated-008') && !('expense_currency' in row)) row = { ...row, expense_currency: 'USD' }
    if (row && !flag('migrated-008') && 'expense_currency' in row) {
      const { expense_currency: _gone, ...rest } = row
      row = rest
    }
    if (q.action === 'select') return { data: row, error: null }
    if ((q.action === 'update' || q.action === 'insert') && !flag('migrated-008') && typeof q.payload === 'object' && q.payload !== null && 'expense_currency' in (q.payload as Row)) {
      return { data: null, error: NO_CURRENCY_COLUMN }
    }
    if (q.action === 'update') {
      if (!row || (q.lte !== undefined && String(row.updated_at) > String(q.lte))) return { data: null, error: null }
      if (!matches(row, { ...q, eq: Object.fromEntries(Object.entries(q.eq).filter(([k]) => k !== 'user_id')) })) return { data: null, error: null }
      const next = { ...row, ...(q.payload as Row) }
      write('settings', next)
      return { data: next, error: null }
    }
    if (q.action === 'insert') {
      if (row) return { data: null, error: duplicate('user_settings_pkey') }
      const next = {
        odds_format: 'american',
        unit_size: null,
        show_units: false,
        starting_bankroll: null,
        default_stake: null,
        loss_limit: null,
        ...(flag('migrated-008') ? { expense_currency: 'USD' } : {}),
        ...(q.payload as Row)
      }
      write('settings', next)
      return { data: next, error: null }
    }
    return { data: null, error: unmodelled('settings ' + q.action) }
  }

  // The bets and the deposits and withdrawals answer the same requests.
  function table(name: string, constraint: string, q: Query): Answer {
    const out = tableAnswer(name, constraint, q)
    if (!before009(name) || out.data === null || out.data === undefined) return out
    // The rows as a database without 009 holds them.
    return { ...out, data: Array.isArray(out.data) ? (out.data as Row[]).map((r) => shown(name, r)) : shown(name, out.data as Row) }
  }

  function tableAnswer(name: string, constraint: string, q: Query): Answer {
    const all = read<Row[]>(name, [])
    if (q.action === 'select') {
      if (q.eq.id !== undefined) return { data: all.find((r) => r.id === q.eq.id) ?? null, error: null }
      if (Object.keys(q.within).length > 0) return { data: all.filter((r) => matches(r, q)), error: null }
      // A lookup by other columns (a budget by its scope and target): the row, as `.maybeSingle()` asks for.
      if (Object.keys(q.eq).length > 0) return { data: all.find((r) => matches(r, q)) ?? null, error: null }
      // A list is read page by page (data/readAll.ts): one page, and the count
      // of them all. Never more rows than max-rows, whatever was asked.
      const cap = maxRows()
      const end = q.range ? q.range[1] + 1 : all.length
      const page = all.slice(q.range ? q.range[0] : 0, cap > 0 ? Math.min(end, (q.range ? q.range[0] : 0) + cap) : end)
      return { data: page, error: null, count: all.length }
    }
    if (q.action === 'delete') {
      const kept = all.filter((r) => !matches(r, q))
      write(name, kept)
      bury(name, all.filter((r) => matches(r, q)))
      return { data: null, error: null, count: all.length - kept.length }
    }
    if (name === 'rows' && !migrated()) return { data: null, error: NO_COLUMN }
    // Before 009, a write that names one of its columns is refused whatever the value (PostgREST checks the names first).
    if (before009(name) && (q.action === 'insert' || q.action === 'update') && typeof q.payload === 'object' && q.payload !== null) {
      const named = ORIGINAL_COLUMNS.find((c) => c in (q.payload as Row))
      if (named) return { data: null, error: noColumn(named, 'expenses') }
    }
    if (q.action === 'insert') {
      const payload = q.payload as Row
      if (all.some((r) => r.id === payload.id)) return { data: null, error: duplicate(constraint) }
      // A budget's other unique key (008): one per scope and target.
      if (name === 'expense-budgets' && all.some((r) => r.scope === payload.scope && r.target === payload.target)) {
        return { data: null, error: duplicate('expense_budgets_one_per_target') }
      }
      const row = stamp(payload)
      if (buried(name, row)) return { data: [], error: null }
      write(name, [...all, row])
      return { data: row, error: null }
    }
    if (q.action === 'update') {
      const i = all.findIndex((r) => r.id === q.eq.id && (q.lte === undefined || String(r.updated_at) <= String(q.lte)))
      if (i < 0) return { data: null, error: null }
      all[i] = { ...all[i], ...(q.payload as Row) }
      write(name, all)
      return { data: all[i], error: null }
    }
    if (q.action === 'upsert' && name === 'rows') {
      const payload = q.payload as Row[]
      const byId = new Map(all.map((r) => [r.id, r]))
      const written: Row[] = []
      for (const r of payload) {
        // ignoreDuplicates: a row already there stays as it is.
        if (q.ignoreDuplicates && byId.has(r.id)) continue
        const row = { ...(byId.get(r.id) ?? {}), ...stamp(r) }
        if (!byId.has(r.id) && buried(name, row)) continue
        byId.set(r.id, row)
        written.push(row)
      }
      write(name, [...byId.values()])
      // The rows written, as `.select()` asks for.
      return { data: written, error: null, count: written.length }
    }
    return { data: null, error: unmodelled(name + ' ' + q.action) }
  }

  const STATUS: Record<string, number> = { '22007': 400, '23505': 409, PGRST204: 400, PGRST205: 404, FAKE: 501 }
  function answer(q: Query): Answer {
    const out = respond(q)
    return { ...out, status: out.error ? (out.status ?? STATUS[out.error.code] ?? 400) : q.action === 'insert' ? 201 : 200 }
  }

  function respond(q: Query): Answer {
    // Postgres refuses a conflict check against something that is no time (an edit with no editedAt).
    if (q.lteSet && (typeof q.lte !== 'string' || isNaN(Date.parse(q.lte)))) {
      return { data: null, error: { message: `invalid input syntax for type timestamp with time zone: "${String(q.lte)}"`, code: '22007' } }
    }
    const lost = { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 }
    if (down()) return lost
    if (q.action === 'select') {
      const fail = read<{ table: string; status: number; message: string; times: number } | null>('fail-reads', null)
      if (fail && fail.table === q.table && fail.times > 0) {
        if (fail.times === 1) localStorage.removeItem(key('fail-reads'))
        else write('fail-reads', { ...fail, times: fail.times - 1 })
        return { data: null, error: { message: fail.message, code: '' }, status: fail.status }
      }
    }
    if (q.action !== 'select' && Number(localStorage.getItem(key('lose-answers')) || 0) > 0) {
      // The write lands; its answer never comes back.
      localStorage.setItem(key('lose-answers'), String(Number(localStorage.getItem(key('lose-answers'))) - 1))
      localStorage.setItem(key('writes'), String(Number(localStorage.getItem(key('writes')) || 0) + 1))
      route(q)
      return lost
    }
    if (q.action !== 'select') {
      const left = localStorage.getItem(key('writes-left'))
      if (left !== null) {
        if (Number(left) <= 0) return lost
        localStorage.setItem(key('writes-left'), String(Number(left) - 1))
      }
      const fail = read<{ status: number; message: string; code?: string; times: number } | null>('fail', null)
      if (fail && fail.times > 0) {
        if (fail.times === 1) localStorage.removeItem(key('fail'))
        else write('fail', { ...fail, times: fail.times - 1 })
        return { data: null, error: { message: fail.message, code: fail.code ?? '' }, status: fail.status }
      }
      localStorage.setItem(key('writes'), String(Number(localStorage.getItem(key('writes')) || 0) + 1))
    }
    return route(q)
  }

  /** The table a request is for. One the database doesn't have is refused as PostgREST does (never answered as the bets). */
  function route(q: Query): Answer {
    if (q.table === 'user_settings') return settings(q)
    if (q.table === 'bankroll_moves') return flag('migrated-005') ? table('moves', 'bankroll_moves_pkey', q) : { data: null, error: NO_MOVES_TABLE }
    if (q.table === 'entries') return table('rows', 'entries_pkey', q)
    const own: Record<string, [string, string]> = {
      expenses: ['expenses', 'expenses_pkey'],
      expense_cards: ['expense-cards', 'expense_cards_pkey'],
      expense_budgets: ['expense-budgets', 'expense_budgets_pkey']
    }
    const t = own[q.table]
    if (t) return flag('migrated-008') ? table(t[0], t[1], q) : { data: null, error: noTable(q.table) }
    return { data: null, error: noTable(q.table) }
  }

  function from(tableName: string) {
    const q: Query = { table: tableName, action: 'select', payload: null, eq: {}, lte: undefined, lteSet: false, range: null, ignoreDuplicates: false, within: {} }
    const chain = {
      select: () => chain,
      order: () => chain,
      range(fromRow: number, toRow: number) {
        q.range = [fromRow, toRow]
        return chain
      },
      single: () => chain,
      maybeSingle: () => chain,
      eq(column: string, value: unknown) {
        q.eq[column] = value
        return chain
      },
      is(column: string, value: unknown) {
        q.eq[column] = value
        return chain
      },
      in(column: string, values: unknown[]) {
        q.within[column] = values
        return chain
      },
      lte(_column: string, value: unknown) {
        q.lte = value
        q.lteSet = true
        return chain
      },
      insert(p: unknown) {
        q.action = 'insert'
        q.payload = p
        return chain
      },
      update(p: unknown) {
        q.action = 'update'
        q.payload = p
        return chain
      },
      upsert(p: unknown, opts?: { ignoreDuplicates?: boolean }) {
        q.action = 'upsert'
        q.payload = p
        q.ignoreDuplicates = opts?.ignoreDuplicates === true
        return chain
      },
      delete() {
        q.action = 'delete'
        return chain
      },
      then<A, B = never>(resolve?: (value: Answer) => A | PromiseLike<A>, reject?: (reason: unknown) => B | PromiseLike<B>): Promise<A | B> {
        if (q.action !== 'select') localStorage.setItem(key('writes-started'), String(Number(localStorage.getItem(key('writes-started')) || 0) + 1))
        return new Promise((r) => setTimeout(r, latency()))
          .then(() => held(q))
          .then(() => answer(q))
          .then((out) => late(q, out))
          .then(resolve, reject)
      }
    }
    return chain
  }

  // Signing in and out: the demo's own; the e2e session ends only when a test ends it.
  const listeners = new Set<Listener>()
  const current = (): typeof session | null => (flag('signed-out') ? null : session)
  const signIn = () => {
    // Signing in needs the server, as it does with Supabase.
    if (down()) return Promise.resolve({ data: { session: null, user: null }, error: { message: 'Failed to fetch', status: 0 } })
    localStorage.removeItem(key('signed-out'))
    for (const fn of listeners) fn('SIGNED_IN', session)
    return Promise.resolve({ data: { session, user: session.user }, error: null })
  }

  // The AI reading (see the comment at the top). Self-contained, like the rest: the contract comes from the page.
  const httpError = (status: number, body: unknown) => ({
    data: null,
    error: {
      name: 'FunctionsHttpError',
      message: 'Edge Function returned a non-2xx status code',
      context: new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    }
  })
  const fetchError = (why: unknown) => ({ data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function', context: why } })
  const isoPlus = (date: string, days: number): string => {
    const [y, m, d] = date.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
  }
  const localToday = (): string => {
    const t = new Date()
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  }
  interface InvokeOptions {
    body?: unknown
    signal?: AbortSignal
  }
  function invoke(name: string, opts?: InvokeOptions) {
    const aborted = (): boolean => opts?.signal?.aborted === true
    return new Promise<void>((r) => setTimeout(r, latency()))
      .then(
        () =>
          new Promise<void>((r) => {
            // ai-ignore-abort: keep holding (and then answer) even after the caller aborted, to prove a late answer adds nothing.
            const wait = (): void => void (flag('ai-hold') && (flag('ai-ignore-abort') || !aborted()) ? setTimeout(wait, 20) : r())
            wait()
          })
      )
      .then(() => {
        if (aborted() && !flag('ai-ignore-abort')) return fetchError(new DOMException('Aborted', 'AbortError'))
        if (down()) return fetchError(new TypeError('Failed to fetch'))
        if (!current()) return httpError(401, { ok: false, code: 'unauthorized', message: 'No session' })
        if (name !== 'extract-expenses') return httpError(404, { code: 'NOT_FOUND', message: 'Requested function was not found' })
        const contract = (window as unknown as { __expenseExtraction?: ExtractionContract }).__expenseExtraction
        if (!contract) return httpError(500, { ok: false, code: 'internal', message: 'fake Supabase: the page has no window.__expenseExtraction' })
        count('ai-calls')
        const b = (typeof opts?.body === 'object' && opts.body !== null ? opts.body : {}) as Record<string, unknown>
        const image = (typeof b.image === 'object' && b.image !== null ? b.image : {}) as Record<string, unknown>
        const data = String(image.data ?? '')
        // `head`: the first 32 base64 chars only, so a test can prove no other storage value holds the image. Never the image.
        write('ai-last', {
          today: b.today,
          lang: b.lang,
          currency: b.currency,
          cards: Array.isArray(b.cards) ? b.cards.length : 0,
          mediaType: image.mediaType,
          chars: data.length,
          head: data.slice(0, 32)
        })
        const checked = contract.parseExtractRequest(JSON.stringify(b))
        if (!checked.ok) return httpError(contract.EXTRACT_STATUS[checked.code], contract.failBody(checked.code))
        const fail = localStorage.getItem(key('ai-fail'))
        if (fail === 'offline' || fail === 'network') return fetchError(new TypeError('Failed to fetch'))
        if (fail === 'not_deployed') return httpError(404, { code: 'NOT_FOUND', message: 'Requested function was not found' })
        if (fail === 'relay') {
          return { data: null, error: { name: 'FunctionsRelayError', message: 'Relay Error invoking the Edge Function', context: new Response(null, { status: 502 }) } }
        }
        if (fail) {
          const status = (contract.EXTRACT_STATUS as Record<string, number | undefined>)[fail] ?? 500
          return httpError(status, { ok: false, code: fail, message: 'fake', ...(fail === 'rate_limited' ? { retryAfter: 2 } : {}) })
        }
        const req = checked.value
        const today = typeof req.today === 'string' ? req.today : localToday()
        const card = req.cards[0]
        const sample = [
          { date: today, amount: 4.5, merchant: 'Café Central', category: 'coffee', cardLast4: card?.last4 || null, cardHint: card?.name ?? null, note: '', pending: false, confidence: 'high' },
          { date: isoPlus(today, -1), amount: 23.18, merchant: 'Supermercado La Plaza', category: 'groceries', cardLast4: null, cardHint: null, note: '', pending: false, confidence: 'medium' }
        ]
        const custom = read<unknown>('ai-rows', null)
        const base = { ok: true, kind: 'wallet', currency: req.currency, expenses: sample as unknown[], warnings: [] as string[] }
        const answer = Array.isArray(custom)
          ? { ...base, expenses: custom }
          : custom && typeof custom === 'object'
            ? { ...base, ...(custom as Record<string, unknown>) }
            : { ...base, ...(cfg.demo ? { sample: true } : {}) }
        count('ai-answered')
        return { data: answer, error: null }
      })
  }

  ;(window as unknown as { __supabaseMock: unknown }).__supabaseMock = {
    auth: {
      getSession: () => Promise.resolve({ data: { session: current() }, error: null }),
      onAuthStateChange(fn: Listener) {
        listeners.add(fn)
        return { data: { subscription: { unsubscribe: () => listeners.delete(fn) } } }
      },
      startAutoRefresh: () => {},
      stopAutoRefresh: () => {},
      signInWithPassword: signIn,
      signUp: signIn,
      // The demo sends no email; the e2e server notes what was asked.
      resetPasswordForEmail(email: string, opts?: { redirectTo?: string }) {
        if (cfg.demo) return Promise.resolve({ data: null, error: { message: 'The demo sends no email', code: 'demo_no_email' } })
        write('recovery-email', { email, redirectTo: opts?.redirectTo ?? null })
        return Promise.resolve({ data: {}, error: null })
      },
      updateUser() {
        if (down()) return Promise.resolve({ data: { user: null }, error: { message: 'Failed to fetch', status: 0 } })
        localStorage.setItem(key('password-updated'), '1')
        return Promise.resolve({ data: { user: session.user }, error: null })
      },
      signOut() {
        if (cfg.demo) {
          localStorage.setItem(key('signed-out'), '1')
          for (const fn of listeners) fn('SIGNED_OUT', null)
        }
        return Promise.resolve({ error: null })
      }
    },
    from,
    functions: { invoke },
    /** This window's name in the per-window counters (`e2e:reads-held@<win>`). */
    __win: win,
    __endSession() {
      localStorage.setItem(key('signed-out'), '1')
      for (const fn of listeners) fn('SIGNED_OUT', null)
    },
    channel() {
      const channel = { on: () => channel, subscribe: () => channel }
      return channel
    },
    removeChannel: () => {}
  }
}

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
 * the bets, the settings row and the deposits and withdrawals, with the
 * PostgREST behaviour the app relies on — inserts (a duplicate id is 23505),
 * updates guarded by `updated_at <= editedAt` (the conflict rule), deletes and
 * upserts. Its state lives in localStorage so it survives reloads, like a
 * real database. With the e2e prefix:
 *  - `e2e:rows`      the bets;
 *  - `e2e:settings`  the user_settings row, if any;
 *  - `e2e:moves`     the bankroll_moves rows;
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
 *                    that comes back late); `e2e:reads-held` counts them.
 * A row written without `updated_at` gets the time it was answered, as the
 * server's now() would. Answers carry the HTTP status PostgREST would give.
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
  const late = (q: { action: string; table: string }, out: Answer): Promise<Answer> =>
    new Promise((resolve) => {
      const holding = (): boolean => q.action === 'select' && localStorage.getItem(key('hold-reads')) === q.table
      if (holding()) localStorage.setItem(key('reads-held'), String(Number(localStorage.getItem(key('reads-held')) || 0) + 1))
      const check = (): void => void (holding() ? setTimeout(check, 20) : resolve(out))
      check()
    })
  const down = (): boolean => flag('down') || (cfg.demo && typeof navigator !== 'undefined' && navigator.onLine === false)
  const maxRows = (): number => Number(localStorage.getItem(key('max-rows')) || 0)
  const NO_COLUMN = { message: "Could not find the 'closing_odds' column of 'entries' in the schema cache", code: 'PGRST204' }
  const NO_TABLE = { message: "Could not find the table 'public.user_settings' in the schema cache", code: 'PGRST205' }
  const NO_MOVES_TABLE = { message: "Could not find the table 'public.bankroll_moves' in the schema cache", code: 'PGRST205' }
  const stamp = (row: Row): Row => ({ created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...row })
  const duplicate = (constraint: string) => ({ message: `duplicate key value violates unique constraint "${constraint}"`, code: '23505' })
  const unmodelled = (what: string) => ({ message: `fake Supabase: ${what} is not modelled`, code: 'FAKE' })

  function settings(q: Query): Answer {
    if (!migrated()) return { data: null, error: NO_TABLE }
    const row = read<Row | null>('settings', null)
    if (q.action === 'select') return { data: row, error: null }
    if (q.action === 'update') {
      if (!row || (q.lte !== undefined && String(row.updated_at) > String(q.lte))) return { data: null, error: null }
      const next = { ...row, ...(q.payload as Row) }
      write('settings', next)
      return { data: next, error: null }
    }
    if (q.action === 'insert') {
      if (row) return { data: null, error: duplicate('user_settings_pkey') }
      const next = { odds_format: 'american', unit_size: null, show_units: false, starting_bankroll: null, default_stake: null, loss_limit: null, ...(q.payload as Row) }
      write('settings', next)
      return { data: next, error: null }
    }
    return { data: null, error: unmodelled('settings ' + q.action) }
  }

  // The bets and the deposits and withdrawals answer the same requests.
  function table(name: string, constraint: string, q: Query): Answer {
    const all = read<Row[]>(name, [])
    if (q.action === 'select') {
      if (q.eq.id !== undefined) return { data: all.find((r) => r.id === q.eq.id) ?? null, error: null }
      // A list is read page by page (data/readAll.ts): one page, and the count
      // of them all. Never more rows than max-rows, whatever was asked.
      const cap = maxRows()
      const end = q.range ? q.range[1] + 1 : all.length
      const page = all.slice(q.range ? q.range[0] : 0, cap > 0 ? Math.min(end, (q.range ? q.range[0] : 0) + cap) : end)
      return { data: page, error: null, count: all.length }
    }
    if (q.action === 'delete') {
      const kept = all.filter((r) => r.id !== q.eq.id)
      write(name, kept)
      return { data: null, error: null, count: all.length - kept.length }
    }
    if (name === 'rows' && !migrated()) return { data: null, error: NO_COLUMN }
    if (q.action === 'insert') {
      const payload = q.payload as Row
      if (all.some((r) => r.id === payload.id)) return { data: null, error: duplicate(constraint) }
      const row = stamp(payload)
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
      let written = 0
      for (const r of payload) {
        // ignoreDuplicates: a row already there stays as it is.
        if (q.ignoreDuplicates && byId.has(r.id)) continue
        byId.set(r.id, { ...(byId.get(r.id) ?? {}), ...stamp(r) })
        written++
      }
      write(name, [...byId.values()])
      return { data: null, error: null, count: written }
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
    if (q.table === 'user_settings') return settings(q)
    if (q.table === 'bankroll_moves') {
      if (!flag('migrated-005')) return { data: null, error: NO_MOVES_TABLE }
      return table('moves', 'bankroll_moves_pkey', q)
    }
    return table('rows', 'entries_pkey', q)
  }

  function from(tableName: string) {
    const q: Query = { table: tableName, action: 'select', payload: null, eq: {}, lte: undefined, lteSet: false, range: null, ignoreDuplicates: false }
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
      signOut() {
        if (cfg.demo) {
          localStorage.setItem(key('signed-out'), '1')
          for (const fn of listeners) fn('SIGNED_OUT', null)
        }
        return Promise.resolve({ error: null })
      }
    },
    from,
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

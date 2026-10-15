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
 *  - `e2e:down`      set: the connection is down, and every request fails
 *                    the way supabase-js reports a failed fetch.
 * The demo adds `demo:signed-out`. A row written without `updated_at` gets
 * the time it was answered, as the server's now() would.
 *
 * The e2e harness hands this function to Playwright's `addInitScript`, which
 * sends its source text to the page: it must not use anything from outside
 * its own body.
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
  }
  interface Answer {
    data: unknown
    error: { message: string; code: string } | null
    count?: number
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
  const down = (): boolean => flag('down') || (cfg.demo && typeof navigator !== 'undefined' && navigator.onLine === false)
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
      if (q.eq.id === undefined) return { data: all, error: null }
      return { data: all.find((r) => r.id === q.eq.id) ?? null, error: null }
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
      for (const r of payload) byId.set(r.id, { ...(byId.get(r.id) ?? {}), ...stamp(r) })
      write(name, [...byId.values()])
      return { data: null, error: null, count: payload.length }
    }
    return { data: null, error: unmodelled(name + ' ' + q.action) }
  }

  function answer(q: Query): Answer {
    // Postgres refuses a conflict check against something that is no time (an edit with no editedAt).
    if (q.lteSet && (typeof q.lte !== 'string' || isNaN(Date.parse(q.lte)))) {
      return { data: null, error: { message: `invalid input syntax for type timestamp with time zone: "${String(q.lte)}"`, code: '22007' } }
    }
    if (down()) return { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } }
    if (q.action !== 'select') localStorage.setItem(key('writes'), String(Number(localStorage.getItem(key('writes')) || 0) + 1))
    if (q.table === 'user_settings') return settings(q)
    if (q.table === 'bankroll_moves') {
      if (!flag('migrated-005')) return { data: null, error: NO_MOVES_TABLE }
      return table('moves', 'bankroll_moves_pkey', q)
    }
    return table('rows', 'entries_pkey', q)
  }

  function from(tableName: string) {
    const q: Query = { table: tableName, action: 'select', payload: null, eq: {}, lte: undefined, lteSet: false }
    const chain = {
      select: () => chain,
      order: () => chain,
      range: () => chain,
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
      upsert(p: unknown) {
        q.action = 'upsert'
        q.payload = p
        return chain
      },
      delete() {
        q.action = 'delete'
        return chain
      },
      then<A, B = never>(resolve?: (value: Answer) => A | PromiseLike<A>, reject?: (reason: unknown) => B | PromiseLike<B>): Promise<A | B> {
        return new Promise((r) => setTimeout(r, latency()))
          .then(() => answer(q))
          .then(resolve, reject)
      }
    }
    return chain
  }

  // Signing in and out: the demo's own; the e2e session never ends.
  const listeners = new Set<Listener>()
  const current = (): typeof session | null => (cfg.demo && flag('signed-out') ? null : session)
  const signIn = (): Promise<{ data: { session: typeof session; user: typeof session.user }; error: null }> => {
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
    channel() {
      const channel = { on: () => channel, subscribe: () => channel }
      return channel
    },
    removeChannel: () => {}
  }
}

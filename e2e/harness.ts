import type { Page, BrowserContext } from '@playwright/test'

/**
 * Boots the app without a backend.
 *
 * `lib/supabase.ts` returns `window.__supabaseMock` when it exists, so the mock
 * is installed before any page script runs. The user and their cached rows are
 * seeded into localStorage, which is exactly how the app opens offline for a
 * real user — so what these tests exercise is the real render/offline path.
 *
 * Seeding happens ONCE per context, guarded by a marker key. `addInitScript`
 * runs on every navigation, and seeding unconditionally would overwrite what
 * the app itself persisted, making every "survives a reload" assertion vacuous.
 */

export const USER = { id: '11111111-2222-3333-4444-555555555555', email: 'you@example.com' }

export interface SeedEntry {
  id: string
  date: string
  amount: number
  stake: number | null
  odds?: number | null
  closingOdds?: number | null
  /** Omitted on most seeds: the app derives it from the amount, as it does for pre-003 caches. */
  status?: 'pending' | 'won' | 'lost' | 'push' | 'void'
  note: string
  sport: string
  book: string
  betType: string
  createdAt: string
  updatedAt: string
}

export function entry(over: Partial<SeedEntry> & { id: string; date: string; amount: number }): SeedEntry {
  const t = `${over.date}T10:00:00.000Z`
  return {
    stake: null,
    note: '',
    sport: '',
    book: '',
    betType: '',
    createdAt: t,
    updatedAt: t,
    ...over
  }
}

/** Three bets: one legacy win without a stake, one loss, one win — enough for every stat to be non-trivial. */
export const SEED: SeedEntry[] = [
  entry({ id: 'a', date: '2026-08-01', amount: 200, note: 'legacy', sport: 'NBA', book: 'DK', betType: 'Parlay' }),
  entry({ id: 'b', date: '2026-08-02', amount: -50, stake: 50, sport: 'NBA', book: 'DK', betType: 'Spread' }),
  entry({ id: 'c', date: '2026-08-03', amount: 30, stake: 60, note: 'live', sport: 'NFL', book: 'FanDuel', betType: 'Moneyline' })
]

const MOCK = `
window.__supabaseMock = {
  auth: {
    getSession: () => Promise.resolve({ data: { session: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    startAutoRefresh: () => {}, stopAutoRefresh: () => {}, signOut: () => Promise.resolve({})
  },
  from: () => { throw new Error('e2e harness: no network') },
  channel: () => ({ on() { return this }, subscribe() { return this } }),
  removeChannel: () => {}
}
`

/**
 * A signed-in session against a small in-memory server: the bets and the
 * settings row, and the PostgREST behaviour the app relies on — inserts (a
 * duplicate id is 23505), updates guarded by `updated_at <= editedAt` (the
 * conflict rule), deletes and upserts. Its state lives in localStorage so it
 * survives reloads, like a real database:
 *  - `e2e:rows`      the bets;
 *  - `e2e:settings`  the user_settings row, if any;
 *  - `e2e:migrated`  unset = the database is missing migration 004: reads
 *                    work, every add or edit (they all name closing_odds) is
 *                    refused (PGRST204), deletes go through, and the settings
 *                    table is missing (PGRST205). Setting it stands for
 *                    running the migration;
 *  - `e2e:latency`   milliseconds before each answer, to leave a request on
 *                    the wire while the test keeps using the app;
 *  - `e2e:writes`    how many write requests have been answered, so a test
 *                    can wait for a retry to have happened;
 *  - `e2e:down`      set: the connection is down, and every request fails
 *                    the way supabase-js reports a failed fetch.
 * A row written without `updated_at` gets the time it was answered, as the
 * server's now() would.
 */
const MOCK_SERVER = `
(() => {
  const session = { access_token: 'e2e', user: ${JSON.stringify(USER)} }
  const migrated = () => localStorage.getItem('e2e:migrated') === '1'
  const latency = () => Number(localStorage.getItem('e2e:latency') || 0)
  const rows = () => JSON.parse(localStorage.getItem('e2e:rows') || '[]')
  const saveRows = (r) => localStorage.setItem('e2e:rows', JSON.stringify(r))
  const NO_COLUMN = { message: "Could not find the 'closing_odds' column of 'entries' in the schema cache", code: 'PGRST204' }
  const NO_TABLE = { message: "Could not find the table 'public.user_settings' in the schema cache", code: 'PGRST205' }
  const stamp = (row) => ({ created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...row })
  const settingsRow = () => JSON.parse(localStorage.getItem('e2e:settings') || 'null')
  const saveSettingsRow = (r) => localStorage.setItem('e2e:settings', JSON.stringify(r))
  function settings(q) {
    if (!migrated()) return { data: null, error: NO_TABLE }
    const row = settingsRow()
    if (q.action === 'select') return { data: row, error: null }
    if (q.action === 'update') {
      if (!row || (q.lte !== undefined && row.updated_at > q.lte)) return { data: null, error: null }
      const next = { ...row, ...q.payload }
      saveSettingsRow(next)
      return { data: next, error: null }
    }
    if (q.action === 'insert') {
      if (row) return { data: null, error: { message: 'duplicate key value violates unique constraint "user_settings_pkey"', code: '23505' } }
      const next = { odds_format: 'american', unit_size: null, show_units: false, starting_bankroll: null, default_stake: null, loss_limit: null, ...q.payload }
      saveSettingsRow(next)
      return { data: next, error: null }
    }
    return { data: null, error: { message: 'e2e harness: settings ' + q.action + ' is not modelled', code: 'E2E' } }
  }
  function answer(q) {
    // Postgres refuses a conflict check against something that is no time (an edit with no editedAt).
    if (q.lteSet && (typeof q.lte !== 'string' || isNaN(Date.parse(q.lte)))) {
      return { data: null, error: { message: 'invalid input syntax for type timestamp with time zone: "' + q.lte + '"', code: '22007' } }
    }
    if (localStorage.getItem('e2e:down') === '1') return { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } }
    if (q.action !== 'select') localStorage.setItem('e2e:writes', String(Number(localStorage.getItem('e2e:writes') || 0) + 1))
    if (q.table === 'user_settings') return settings(q)
    const all = rows()
    if (q.action === 'select') {
      if (q.eq.id === undefined) return { data: all, error: null }
      return { data: all.find((r) => r.id === q.eq.id) || null, error: null }
    }
    if (q.action === 'delete') {
      saveRows(all.filter((r) => r.id !== q.eq.id))
      return { data: null, error: null, count: all.length - rows().length }
    }
    if (!migrated()) return { data: null, error: NO_COLUMN }
    if (q.action === 'insert') {
      if (all.some((r) => r.id === q.payload.id)) return { data: null, error: { message: 'duplicate key value violates unique constraint "entries_pkey"', code: '23505' } }
      const row = stamp(q.payload)
      saveRows([...all, row])
      return { data: row, error: null }
    }
    if (q.action === 'update') {
      const i = all.findIndex((r) => r.id === q.eq.id && (q.lte === undefined || r.updated_at <= q.lte))
      if (i < 0) return { data: null, error: null }
      all[i] = { ...all[i], ...q.payload }
      saveRows(all)
      return { data: all[i], error: null }
    }
    if (q.action === 'upsert') {
      const byId = new Map(all.map((r) => [r.id, r]))
      for (const r of q.payload) byId.set(r.id, { ...(byId.get(r.id) || {}), ...stamp(r) })
      saveRows([...byId.values()])
      return { data: null, error: null, count: q.payload.length }
    }
    return { data: null, error: { message: 'e2e harness: ' + q.action + ' is not modelled', code: 'E2E' } }
  }
  function from(table) {
    const q = { table, action: 'select', payload: null, eq: {}, lte: undefined }
    const chain = {
      select() { return chain }, order() { return chain }, single() { return chain }, maybeSingle() { return chain },
      eq(c, v) { q.eq[c] = v; return chain },
      lte(c, v) { q.lte = v; q.lteSet = true; return chain },
      insert(p) { q.action = 'insert'; q.payload = p; return chain },
      update(p) { q.action = 'update'; q.payload = p; return chain },
      upsert(p) { q.action = 'upsert'; q.payload = p; return chain },
      delete() { q.action = 'delete'; return chain },
      then(resolve, reject) {
        return new Promise((r) => setTimeout(r, latency())).then(() => answer(q)).then(resolve, reject)
      }
    }
    return chain
  }
  window.__supabaseMock = {
    auth: {
      getSession: () => Promise.resolve({ data: { session }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      startAutoRefresh: () => {}, stopAutoRefresh: () => {}, signOut: () => Promise.resolve({})
    },
    from,
    channel: () => ({ on() { return this }, subscribe() { return this } }),
    removeChannel: () => {}
  }
})()
`

/** A seed bet as the database row it would be (snake_case; with no status the app derives it). */
const toRow = (e: SeedEntry) => ({
  id: e.id,
  user_id: USER.id,
  date: e.date,
  amount: e.amount,
  stake: e.stake,
  note: e.note,
  sport: e.sport,
  book: e.book,
  bet_type: e.betType,
  created_at: e.createdAt,
  updated_at: e.updatedAt,
  ...(e.odds !== undefined ? { odds: e.odds } : {}),
  ...(e.closingOdds !== undefined ? { closing_odds: e.closingOdds } : {}),
  // A seed with a status is a migrated row: pending has no amount.
  ...(e.status ? { status: e.status, amount: e.status === 'pending' ? null : e.amount } : {})
})

export interface BootOptions {
  entries?: SeedEntry[]
  theme?: 'dark' | 'light'
  /** Cached user settings, as the app would have stored them. */
  settings?: Record<string, unknown>
  /**
   * 'none' (default): no session, so the app runs on its device copy alone.
   * 'behind': signed in, against a database missing migration 004 (MOCK_SERVER).
   * 'live': signed in, against an up-to-date database (MOCK_SERVER).
   */
  backend?: 'none' | 'behind' | 'live'
  /** With a backend: milliseconds before each answer. */
  latencyMs?: number
  /** A queue of changes waiting to sync, as the app (or an older version of it) stored it. */
  outbox?: unknown[]
}

/** Cached settings (camelCase, as the app stores them) as the user_settings row a migrated server holds. */
const toSettingsRow = (s: Record<string, unknown>) => ({
  user_id: USER.id,
  odds_format: s.oddsFormat ?? 'american',
  unit_size: s.unitSize ?? null,
  show_units: s.showUnits ?? false,
  starting_bankroll: s.startingBankroll ?? null,
  default_stake: s.defaultStake ?? null,
  loss_limit: s.lossLimit ?? null,
  updated_at: '2026-01-01T00:00:00.000Z'
})

export async function install(context: BrowserContext, opts: BootOptions = {}): Promise<void> {
  const entries = opts.entries ?? SEED
  const backend = opts.backend ?? 'none'
  const server =
    backend === 'none'
      ? null
      : {
          rows: entries.map(toRow),
          migrated: backend === 'live',
          latencyMs: opts.latencyMs ?? 0,
          // A migrated server holds the settings the device has cached.
          settingsRow: backend === 'live' && opts.settings ? toSettingsRow(opts.settings) : null
        }
  await context.addInitScript(
    ({ mock, user, entries, server, theme, settings, outbox }) => {
      // eslint-disable-next-line no-eval
      eval(mock)
      if (localStorage.getItem('e2e:seeded')) return
      localStorage.setItem('e2e:seeded', '1')
      localStorage.setItem('bettracker:last-user', JSON.stringify(user))
      localStorage.setItem(`bettracker:cache:${user.id}`, JSON.stringify(entries))
      localStorage.setItem('bettracker:theme', theme)
      if (settings) localStorage.setItem(`bettracker:settings:${user.id}`, JSON.stringify(settings))
      if (server) {
        localStorage.setItem('e2e:rows', JSON.stringify(server.rows))
        if (server.migrated) localStorage.setItem('e2e:migrated', '1')
        localStorage.setItem('e2e:latency', String(server.latencyMs))
        if (server.settingsRow) localStorage.setItem('e2e:settings', JSON.stringify(server.settingsRow))
      }
      if (outbox) localStorage.setItem(`bettracker:outbox:${user.id}`, JSON.stringify(outbox))
    },
    {
      mock: server ? MOCK_SERVER : MOCK,
      user: USER,
      entries,
      server,
      theme: opts.theme ?? 'dark',
      settings: opts.settings ?? null,
      outbox: opts.outbox ?? null
    }
  )
}

/** Install the harness on the page's context and open the app. */
export async function boot(page: Page, opts: BootOptions = {}): Promise<void> {
  await install(page.context(), opts)
  await page.goto('/')
  await page.waitForSelector('.history-card')
}

export async function reload(page: Page): Promise<void> {
  await page.reload()
  await page.waitForSelector('.history-card')
}

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
 * A signed-in session against a database that is behind the app, missing
 * migration 004. Reads work; every write that names a column it does not have
 * is refused the way PostgREST refuses it (PGRST204), and the settings table
 * is missing (PGRST205). Setting `e2e:migrated` in localStorage stands for
 * running the migration: from then on writes go through. The rows and that
 * flag live in localStorage so they survive reloads, like a real database.
 */
const MOCK_BEHIND = `
(() => {
  const session = { access_token: 'e2e', user: ${JSON.stringify(USER)} }
  const migrated = () => localStorage.getItem('e2e:migrated') === '1'
  const rows = () => JSON.parse(localStorage.getItem('e2e:rows') || '[]')
  const saveRows = (r) => localStorage.setItem('e2e:rows', JSON.stringify(r))
  const NO_COLUMN = { message: "Could not find the 'closing_odds' column of 'entries' in the schema cache", code: 'PGRST204' }
  const NO_TABLE = { message: "Could not find the table 'public.user_settings' in the schema cache", code: 'PGRST205' }
  function answer(q) {
    if (q.table === 'user_settings') return migrated() ? { data: null, error: null } : { data: null, error: NO_TABLE }
    if (q.action === 'select') return { data: rows(), error: null }
    if (!migrated()) return { data: null, error: NO_COLUMN }
    if (q.action === 'insert') {
      const now = new Date().toISOString()
      const row = { created_at: now, updated_at: now, ...q.payload }
      saveRows([...rows(), row])
      return { data: row, error: null }
    }
    return { data: null, error: { message: 'e2e harness: ' + q.action + ' is not modelled', code: 'E2E' } }
  }
  function from(table) {
    const q = { table, action: 'select', payload: null }
    const chain = {
      select() { return chain }, order() { return chain }, eq() { return chain }, lte() { return chain },
      single() { return chain }, maybeSingle() { return chain },
      insert(p) { q.action = 'insert'; q.payload = p; return chain },
      update(p) { q.action = 'update'; q.payload = p; return chain },
      upsert(p) { q.action = 'upsert'; q.payload = p; return chain },
      delete() { q.action = 'delete'; return chain },
      then(resolve, reject) { return Promise.resolve(answer(q)).then(resolve, reject) }
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

/** A seed bet as the database row it would be (snake_case, no status: the app derives it). */
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
  updated_at: e.updatedAt
})

export interface BootOptions {
  entries?: SeedEntry[]
  theme?: 'dark' | 'light'
  /** Cached user settings, as the app would have stored them. */
  settings?: Record<string, unknown>
  /**
   * 'none' (default): no session, so the app runs on its device copy alone.
   * 'behind': signed in, against a database missing a migration (MOCK_BEHIND).
   */
  backend?: 'none' | 'behind'
}

export async function install(context: BrowserContext, opts: BootOptions = {}): Promise<void> {
  const entries = opts.entries ?? SEED
  const behind = opts.backend === 'behind'
  await context.addInitScript(
    ({ mock, user, entries, rows, theme, settings }) => {
      // eslint-disable-next-line no-eval
      eval(mock)
      if (localStorage.getItem('e2e:seeded')) return
      localStorage.setItem('e2e:seeded', '1')
      localStorage.setItem('bettracker:last-user', JSON.stringify(user))
      localStorage.setItem(`bettracker:cache:${user.id}`, JSON.stringify(entries))
      localStorage.setItem('bettracker:theme', theme)
      if (settings) localStorage.setItem(`bettracker:settings:${user.id}`, JSON.stringify(settings))
      if (rows) localStorage.setItem('e2e:rows', JSON.stringify(rows))
    },
    {
      mock: behind ? MOCK_BEHIND : MOCK,
      user: USER,
      entries,
      rows: behind ? entries.map(toRow) : null,
      theme: opts.theme ?? 'dark',
      settings: opts.settings ?? null
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

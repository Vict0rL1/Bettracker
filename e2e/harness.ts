import type { Page, BrowserContext } from '@playwright/test'
import { installFakeSupabase } from '../src/renderer/src/demo/fakeSupabase'

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

/** A deposit (+) or withdrawal (−) as the app caches it (camelCase). */
export interface SeedMove {
  id: string
  date: string
  amount: number
  note: string
  createdAt: string
  updatedAt: string
}

export function move(over: Partial<SeedMove> & { id: string; date: string; amount: number }): SeedMove {
  const t = `${over.date}T09:00:00.000Z`
  return { note: '', createdAt: t, updatedAt: t, ...over }
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
   * Deposits and withdrawals: cached on the device and, with a backend, on
   * the server. Without it the device has never loaded any (a device that
   * has just been upgraded) and the server has none.
   */
  moves?: SeedMove[]
  /**
   * 'none' (default): no session, so the app runs on its device copy alone.
   * 'behind': signed in, against a database missing migrations 004 and 005 (the fake server).
   * 'behind-005': signed in, against a database that has 004 but is missing 005.
   * 'live': signed in, against an up-to-date database (the fake server).
   */
  backend?: 'none' | 'behind' | 'behind-005' | 'live'
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

/** A seed move as the bankroll_moves row it would be (snake_case). */
const toMoveRow = (m: SeedMove) => ({
  id: m.id,
  user_id: USER.id,
  date: m.date,
  amount: m.amount,
  note: m.note,
  created_at: m.createdAt,
  updated_at: m.updatedAt
})

export async function install(context: BrowserContext, opts: BootOptions = {}): Promise<void> {
  const entries = opts.entries ?? SEED
  const backend = opts.backend ?? 'none'
  const has004 = backend === 'live' || backend === 'behind-005'
  const server =
    backend === 'none'
      ? null
      : {
          rows: entries.map(toRow),
          migrated: has004,
          migrated005: backend === 'live',
          latencyMs: opts.latencyMs ?? 0,
          // A migrated server holds the settings the device has cached.
          settingsRow: has004 && opts.settings ? toSettingsRow(opts.settings) : null,
          moveRows: (opts.moves ?? []).map(toMoveRow)
        }
  // With a backend, the same fake server `npm run demo` uses (its state under `e2e:`, see
  // demo/fakeSupabase.ts); without one, a client that is signed out and has no network.
  if (server) await context.addInitScript(installFakeSupabase, { prefix: 'e2e:', user: USER, demo: false })
  await context.addInitScript(
    ({ mock, user, entries, server, theme, settings, moves, outbox }) => {
      // eslint-disable-next-line no-eval
      if (mock) eval(mock)
      if (localStorage.getItem('e2e:seeded')) return
      localStorage.setItem('e2e:seeded', '1')
      localStorage.setItem('bettracker:last-user', JSON.stringify(user))
      localStorage.setItem(`bettracker:cache:${user.id}`, JSON.stringify(entries))
      localStorage.setItem('bettracker:theme', theme)
      if (settings) localStorage.setItem(`bettracker:settings:${user.id}`, JSON.stringify(settings))
      if (moves) localStorage.setItem(`bettracker:moves:${user.id}`, JSON.stringify(moves))
      if (server) {
        localStorage.setItem('e2e:rows', JSON.stringify(server.rows))
        localStorage.setItem('e2e:moves', JSON.stringify(server.moveRows))
        if (server.migrated) localStorage.setItem('e2e:migrated', '1')
        if (server.migrated005) localStorage.setItem('e2e:migrated-005', '1')
        localStorage.setItem('e2e:latency', String(server.latencyMs))
        if (server.settingsRow) localStorage.setItem('e2e:settings', JSON.stringify(server.settingsRow))
      }
      if (outbox) localStorage.setItem(`bettracker:outbox:${user.id}`, JSON.stringify(outbox))
      // No backend: a device whose session ran out and can't be renewed
      // offline. Supabase keeps it stored, so the app does not take it for a
      // session that ended for good (signed out on another device).
      if (!server) localStorage.setItem('bettracker-auth', JSON.stringify({ e2e: 'a session this device cannot renew offline' }))
    },
    {
      mock: server ? null : MOCK,
      user: USER,
      entries,
      server,
      theme: opts.theme ?? 'dark',
      settings: opts.settings ?? null,
      moves: opts.moves ?? null,
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

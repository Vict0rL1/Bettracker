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

export interface BootOptions {
  entries?: SeedEntry[]
  theme?: 'dark' | 'light'
  /** Cached user settings, as the app would have stored them. */
  settings?: Record<string, unknown>
}

export async function install(context: BrowserContext, opts: BootOptions = {}): Promise<void> {
  await context.addInitScript(
    ({ mock, user, entries, theme, settings }) => {
      // eslint-disable-next-line no-eval
      eval(mock)
      if (localStorage.getItem('e2e:seeded')) return
      localStorage.setItem('e2e:seeded', '1')
      localStorage.setItem('bettracker:last-user', JSON.stringify(user))
      localStorage.setItem(`bettracker:cache:${user.id}`, JSON.stringify(entries))
      localStorage.setItem('bettracker:theme', theme)
      if (settings) localStorage.setItem(`bettracker:settings:${user.id}`, JSON.stringify(settings))
    },
    { mock: MOCK, user: USER, entries: opts.entries ?? SEED, theme: opts.theme ?? 'dark', settings: opts.settings ?? null }
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

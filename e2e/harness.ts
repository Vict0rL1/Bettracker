import fs from 'node:fs'
import path from 'node:path'
import { expect, type Page, type BrowserContext } from '@playwright/test'
import { installFakeSupabase } from '../src/renderer/src/demo/fakeSupabase'
import { budgetId } from '../src/renderer/src/lib/stableId'

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

/** An expense as the app caches it (camelCase): + spent, − a refund. */
export interface SeedExpense {
  id: string
  date: string
  amount: number
  cardId: string | null
  merchant: string
  category: string
  note: string
  source: 'manual' | 'ai'
  createdAt: string
  updatedAt: string
}

export function expense(over: Partial<SeedExpense> & { id: string; date: string; amount: number }): SeedExpense {
  const t = `${over.date}T12:00:00.000Z`
  return { cardId: null, merchant: '', category: 'other', note: '', source: 'manual', createdAt: t, updatedAt: t, ...over }
}

/** A card as the app caches it. */
export interface SeedCard {
  id: string
  name: string
  last4: string
  kind: 'credit' | 'debit'
  archived: boolean
  createdAt: string
  updatedAt: string
}

export function card(over: Partial<SeedCard> & { id: string; name: string }): SeedCard {
  const t = '2026-01-01T09:00:00.000Z'
  return { last4: '', kind: 'credit', archived: false, createdAt: t, updatedAt: t, ...over }
}

/** A monthly budget as the app caches it; its id is the one the app makes for it (lib/stableId.ts). */
export interface SeedBudget {
  id: string
  scope: 'total' | 'card' | 'category'
  target: string
  monthlyLimit: number
  createdAt: string
  updatedAt: string
}

export function budget(over: Partial<SeedBudget> & Pick<SeedBudget, 'scope' | 'monthlyLimit'>): SeedBudget {
  const t = '2026-01-01T09:00:00.000Z'
  const target = over.target ?? ''
  return { id: budgetId(USER.id, over.scope, target), target, createdAt: t, updatedAt: t, ...over }
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
  functions: {
    invoke: () => Promise.resolve({ data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function', context: {} } })
  },
  channel: () => ({ on() { return this }, subscribe() { return this } }),
  removeChannel: () => {}
}
`

let contractScript: string | null = null
/**
 * src/shared/expenseExtraction.ts as a page script that sets
 * `window.__expenseExtraction`, which the fake server checks scans with (see
 * ExtractionContract in demo/fakeSupabase.ts: the fake is sent to the page as
 * source text, so it can't import the module). The module has no imports, so
 * stripping its types is all it takes; done once per worker.
 */
async function expenseContractScript(): Promise<string> {
  if (contractScript !== null) return contractScript
  const ts = await import('typescript')
  const source = fs.readFileSync(path.join(__dirname, '../src/shared/expenseExtraction.ts'), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  contractScript = `(function () {\nvar exports = {};\n${outputText}\nwindow.__expenseExtraction = exports;\n})();`
  return contractScript
}

/** A 1×1 PNG: the smallest image a scan takes. */
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/** TINY_PNG as `setInputFiles` takes it. */
export const scanFile = { name: 'receipt.png', mimeType: 'image/png', buffer: TINY_PNG }

/**
 * A 1200×1600 receipt-like PNG (a gradient and lines of text) drawn in the
 * page, as `setInputFiles` takes it: big enough that the scan's JPEG is
 * tens of kilobytes, so a test can tell the image from anything else stored.
 */
export async function bigPng(page: Page): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1200
    canvas.height = 1600
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    const paper = ctx.createLinearGradient(0, 0, 1200, 1600)
    paper.addColorStop(0, '#fbf8f1')
    paper.addColorStop(1, '#cfc8b8')
    ctx.fillStyle = paper
    ctx.fillRect(0, 0, 1200, 1600)
    ctx.fillStyle = '#1b1b1b'
    ctx.font = 'bold 64px monospace'
    ctx.fillText('SUPERMERCADO LA PLAZA', 80, 140)
    ctx.font = '40px monospace'
    for (let i = 0; i < 28; i++) ctx.fillText(`ITEM ${String(i + 1).padStart(2, '0')} ............ ${(i * 1.37 + 0.59).toFixed(2)}`, 80, 240 + i * 44)
    ctx.font = 'bold 56px monospace'
    ctx.fillText('TOTAL             23.18', 80, 1520)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  return { name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') }
}

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
   * Expenses, cards and budgets (migration 008): cached on the device and,
   * with an up-to-date backend, on the server. Undefined: the device has
   * never loaded them, except that when `moves` is given and these are not
   * they default to [] (a device that has loaded everything stays so);
   * null: no cache whatever `moves` says. The server has none unless given.
   */
  expenses?: SeedExpense[] | null
  cards?: SeedCard[] | null
  budgets?: SeedBudget[] | null
  /**
   * 'none' (default): no session, so the app runs on its device copy alone.
   * 'behind': signed in, against a database missing migrations 004 and 005 (the fake server).
   * 'behind-005': signed in, against a database that has 004 but is missing 005.
   * 'behind-008': signed in, against a database that has 004, 005 and 007 but is missing 008.
   * 'live': signed in, against an up-to-date database (the fake server).
   */
  backend?: 'none' | 'behind' | 'behind-005' | 'behind-008' | 'live'
  /** The view this device opens on (`bettracker:view`); unset is the default, the bets. */
  view?: 'bets' | 'expenses'
  /** With a backend: milliseconds before each answer. */
  latencyMs?: number
  /** A queue of changes waiting to sync, as the app (or an older version of it) stored it. */
  outbox?: unknown[]
  /** With the 'live' backend: false for a database without migration 007 (no tombstones), and so without 008. */
  migrated007?: boolean
  /**
   * With a backend: the fake AI reading (demo/fakeSupabase.ts). `rows`: its
   * answer's rows (an array) or fields (an object); `fail`: a code it fails
   * with; `hold`: answers wait until `e2e:ai-hold` is cleared; `ignoreAbort`:
   * a held call still answers after it is cancelled.
   */
  ai?: { rows?: unknown; fail?: string; hold?: boolean; ignoreAbort?: boolean }
}

/** Cached settings (camelCase, as the app stores them) as the user_settings row a migrated server holds (the currency column with 008). */
const toSettingsRow = (s: Record<string, unknown>, has008: boolean) => ({
  user_id: USER.id,
  odds_format: s.oddsFormat ?? 'american',
  unit_size: s.unitSize ?? null,
  show_units: s.showUnits ?? false,
  starting_bankroll: s.startingBankroll ?? null,
  default_stake: s.defaultStake ?? null,
  loss_limit: s.lossLimit ?? null,
  ...(has008 ? { expense_currency: s.expenseCurrency ?? 'USD' } : {}),
  updated_at: '2026-01-01T00:00:00.000Z'
})

/** A seed expense as the row PostgREST returns (snake_case; numerics as strings). */
const toExpenseRow = (e: SeedExpense) => ({
  id: e.id,
  user_id: USER.id,
  date: e.date,
  amount: e.amount.toFixed(2),
  card_id: e.cardId,
  merchant: e.merchant,
  category: e.category,
  note: e.note,
  source: e.source,
  created_at: e.createdAt,
  updated_at: e.updatedAt
})

const toCardRow = (c: SeedCard) => ({
  id: c.id,
  user_id: USER.id,
  name: c.name,
  last4: c.last4,
  kind: c.kind,
  archived: c.archived,
  created_at: c.createdAt,
  updated_at: c.updatedAt
})

const toBudgetRow = (b: SeedBudget) => ({
  id: b.id,
  user_id: USER.id,
  scope: b.scope,
  target: b.target,
  monthly_limit: b.monthlyLimit.toFixed(2),
  created_at: b.createdAt,
  updated_at: b.updatedAt
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
  const has004 = backend !== 'none' && backend !== 'behind'
  const migrated005 = backend === 'live' || backend === 'behind-008'
  const migrated007 = migrated005 && opts.migrated007 !== false
  // 008 can't run without 007 (its tables use 007's triggers).
  const migrated008 = backend === 'live' && opts.migrated007 !== false
  // A device that has loaded the moves has loaded the expenses too, unless a test says otherwise.
  const cached = <T>(v: T[] | null | undefined): T[] | null => (v === undefined ? (opts.moves !== undefined ? [] : null) : v)
  const server =
    backend === 'none'
      ? null
      : {
          rows: entries.map(toRow),
          migrated: has004,
          migrated005,
          migrated007,
          migrated008,
          latencyMs: opts.latencyMs ?? 0,
          // A migrated server holds the settings the device has cached.
          settingsRow: has004 && opts.settings ? toSettingsRow(opts.settings, migrated008) : null,
          moveRows: (opts.moves ?? []).map(toMoveRow),
          expenseRows: (opts.expenses ?? []).map(toExpenseRow),
          cardRows: (opts.cards ?? []).map(toCardRow),
          budgetRows: (opts.budgets ?? []).map(toBudgetRow),
          ai: opts.ai ?? null
        }
  // With a backend, the same fake server `npm run demo` uses (its state under `e2e:`, see
  // demo/fakeSupabase.ts); without one, a client that is signed out and has no network.
  if (server) {
    await context.addInitScript({ content: await expenseContractScript() })
    await context.addInitScript(installFakeSupabase, { prefix: 'e2e:', user: USER, demo: false })
  }
  await context.addInitScript(
    ({ mock, user, entries, server, theme, settings, moves, expenses, cards, budgets, view, outbox }) => {
      // eslint-disable-next-line no-eval
      if (mock) eval(mock)
      if (localStorage.getItem('e2e:seeded')) return
      localStorage.setItem('e2e:seeded', '1')
      localStorage.setItem('bettracker:last-user', JSON.stringify(user))
      localStorage.setItem(`bettracker:cache:${user.id}`, JSON.stringify(entries))
      localStorage.setItem('bettracker:theme', theme)
      if (settings) localStorage.setItem(`bettracker:settings:${user.id}`, JSON.stringify(settings))
      if (moves) localStorage.setItem(`bettracker:moves:${user.id}`, JSON.stringify(moves))
      if (expenses) localStorage.setItem(`bettracker:expenses:${user.id}`, JSON.stringify(expenses))
      if (cards) localStorage.setItem(`bettracker:expense-cards:${user.id}`, JSON.stringify(cards))
      if (budgets) localStorage.setItem(`bettracker:expense-budgets:${user.id}`, JSON.stringify(budgets))
      if (view) localStorage.setItem('bettracker:view', view)
      if (server) {
        localStorage.setItem('e2e:rows', JSON.stringify(server.rows))
        localStorage.setItem('e2e:moves', JSON.stringify(server.moveRows))
        localStorage.setItem('e2e:expenses', JSON.stringify(server.expenseRows))
        localStorage.setItem('e2e:expense-cards', JSON.stringify(server.cardRows))
        localStorage.setItem('e2e:expense-budgets', JSON.stringify(server.budgetRows))
        if (server.migrated) localStorage.setItem('e2e:migrated', '1')
        if (server.migrated005) localStorage.setItem('e2e:migrated-005', '1')
        if (server.migrated007) localStorage.setItem('e2e:migrated-007', '1')
        if (server.migrated008) localStorage.setItem('e2e:migrated-008', '1')
        localStorage.setItem('e2e:latency', String(server.latencyMs))
        if (server.settingsRow) localStorage.setItem('e2e:settings', JSON.stringify(server.settingsRow))
        if (server.ai) {
          if (server.ai.rows !== undefined) localStorage.setItem('e2e:ai-rows', JSON.stringify(server.ai.rows))
          if (server.ai.fail) localStorage.setItem('e2e:ai-fail', server.ai.fail)
          if (server.ai.hold) localStorage.setItem('e2e:ai-hold', '1')
          if (server.ai.ignoreAbort) localStorage.setItem('e2e:ai-ignore-abort', '1')
        }
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
      expenses: cached(opts.expenses),
      cards: cached(opts.cards),
      budgets: cached(opts.budgets),
      view: opts.view ?? null,
      outbox: opts.outbox ?? null
    }
  )
}

/**
 * Install the harness on the page's context and open the app, waiting for
 * the view it opens on (`.exp-bar` exists only in the loaded Expenses view,
 * never in its loading fallback).
 */
export async function boot(page: Page, opts: BootOptions = {}): Promise<void> {
  await install(page.context(), opts)
  await page.goto('/')
  await page.waitForSelector(opts.view === 'expenses' ? '.exp-bar' : '.history-card')
}

export async function reload(page: Page, ready = '.history-card'): Promise<void> {
  await page.reload()
  await page.waitForSelector(ready)
}

/**
 * Import a CSV the way a user does: Import & export, pick the file, read the
 * review, import. `keepDuplicates` keeps the possible duplicates the review
 * would skip.
 */
export async function importCsv(page: Page, csv: string, opts: { name?: string; keepDuplicates?: boolean } = {}): Promise<void> {
  await menu(page, '.data-btn')
  const dialog = page.locator('.data-modal')
  await page.setInputFiles('.data-csv-input', { name: opts.name ?? 'bets.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await dialog.locator('.imp-summary').waitFor()
  if (opts.keepDuplicates && (await dialog.locator('.imp-dup-all').count()) > 0) await dialog.locator('.imp-dup-all').click()
  await dialog.locator('.imp-go, .imp-again').click()
  await dialog.waitFor({ state: 'detached' })
}

/** Open the advanced analytics (strike rate, CLV, days, breakdowns), closed until asked. */
export async function openAdvanced(page: Page): Promise<void> {
  const toggle = page.locator('.advanced-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

/**
 * One of the top bar's menu items (`.data-btn`, `.pending-btn`,
 * `.settings-btn`, `.theme-btn`, `.lang-btn`, `.btn-signout`): the menu is
 * opened if it is closed, then the item clicked.
 */
export async function menu(page: Page, item: string): Promise<void> {
  const toggle = page.locator('.menu-btn')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await page.locator(`.app-menu ${item}`).click()
}

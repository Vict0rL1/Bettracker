import { expect, test, type Page } from '@playwright/test'
import { USER, boot, budget, card, expense, install } from './harness'

/**
 * The sync of the expenses, cards and budgets (migration 008) before their
 * screens exist: changes this device queued earlier (as the app stores
 * them) go to the server or wait for 008, and the backup's gate waits for
 * their lists. expenses.spec.ts tests them through the Expenses view.
 */

const CARD_ID = '6f9619ff-8b86-4011-b42d-00cf4fc964ff'
const DAY = '2026-11-17'

type RowName = 'expenses' | 'expense-cards' | 'expense-budgets'

/** Changes this device queued before the app opened: each table's outbox, as the app stores it. */
async function queued(page: Page, outboxes: Partial<Record<RowName, unknown[]>>): Promise<void> {
  await page.addInitScript(
    ({ uid, outboxes }) => {
      if (localStorage.getItem('e2e:seeded-outboxes')) return
      localStorage.setItem('e2e:seeded-outboxes', '1')
      for (const [name, ops] of Object.entries(outboxes)) localStorage.setItem(`bettracker:${name}-outbox:${uid}`, JSON.stringify(ops))
    },
    { uid: USER.id, outboxes }
  )
}

const addOp = (id: string, input: Record<string, unknown>) => ({ opId: `op-${id}`, kind: 'add', id, input, queuedAt: new Date().toISOString() })
const expenseInput = (amount: number) => ({ date: DAY, amount, cardId: null, merchant: 'Café', category: 'coffee', note: '', source: 'manual' })

/** The fake server's rows of a table (`e2e:<name>`). */
const server = (page: Page, name: RowName) => page.evaluate((n) => JSON.parse(localStorage.getItem(`e2e:${n}`) ?? 'null') as Record<string, unknown>[] | null, name)
const counter = (page: Page, name: string) => page.evaluate((n) => Number(localStorage.getItem(`e2e:${n}`) || 0), name)

test('queued expenses and cards land on an up-to-date server with what was there; the badge says Synced, nothing is said', async ({ page }) => {
  await install(page.context(), {
    backend: 'live',
    cards: [card({ id: CARD_ID, name: 'Visa', last4: '1234' })],
    expenses: [expense({ id: '10000000-0000-4000-8000-000000000001', date: DAY, amount: 3, cardId: CARD_ID })],
    budgets: [budget({ scope: 'total', monthlyLimit: 100 })]
  })
  await queued(page, {
    expenses: [addOp('20000000-0000-4000-8000-000000000001', expenseInput(4.5))],
    'expense-cards': [addOp('30000000-0000-4000-8000-000000000001', { name: 'Debit', last4: '', kind: 'debit', archived: false })]
  })
  await page.goto('/')
  await page.waitForSelector('.history-card')
  await expect.poll(async () => (await server(page, 'expenses'))?.length).toBe(2)
  await expect.poll(async () => (await server(page, 'expense-cards'))?.length).toBe(2)
  expect((await server(page, 'expense-budgets'))?.length).toBe(1)
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  await expect
    .poll(() => page.evaluate((uid) => (JSON.parse(localStorage.getItem(`bettracker:expenses:${uid}`) ?? '[]') as { amount: number }[]).map((e) => e.amount).sort(), USER.id))
    .toEqual([3, 4.5])
  // Nothing of the settings was written, and nothing was said.
  expect(await page.evaluate(() => localStorage.getItem('e2e:settings'))).toBeNull()
  await expect(page.locator('.toast')).toHaveCount(0)
})

test('before 008, queued changes wait as Update needed, said once for the three tables (not again on resume or reconnect); all goes once it runs', async ({ page }) => {
  await install(page.context(), { backend: 'behind-008', moves: [] })
  await queued(page, {
    expenses: [addOp('20000000-0000-4000-8000-000000000001', expenseInput(4.5))],
    'expense-budgets': [addOp('40000000-0000-4000-8000-000000000001', { scope: 'total', target: '', monthlyLimit: 50 })]
  })
  await page.goto('/')
  await page.waitForSelector('.history-card')
  // Both queues have been refused for the missing tables (one still sending would read Syncing).
  await expect(page.locator('.sync-badge')).toHaveText('Update needed · 2 queued')
  await expect(page.locator('.toast')).toHaveCount(1)
  // From here on, every toast that shows (or changes) is noted. A toast is
  // never removed by hand: React owns it.
  await page.evaluate(() => {
    const w = window as unknown as { __toasts: string[] }
    w.__toasts = []
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of [...Array.from(r.addedNodes), r.target]) {
          const el = n instanceof Element ? n.closest('.toast') : n.parentElement?.closest('.toast')
          if (el) w.__toasts.push(el.textContent ?? '')
        }
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  // A resume and a reconnect: each table reads (still missing) and sends its queue again (refused again).
  const writes = await counter(page, 'writes')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(() => counter(page, 'writes')).toBeGreaterThanOrEqual(writes + 2)
  await expect(page.locator('.sync-badge')).toHaveText('Update needed · 2 queued')
  // Backup and restore wait for nothing: the missing tables read as none yet.
  await page.locator('.menu-btn').click()
  await page.locator('.app-menu .data-btn').click()
  await expect(page.locator('.data-backup')).toBeEnabled()
  await expect(page.locator('.data-restore')).toBeEnabled()
  await page.keyboard.press('Escape')
  // 008 runs, and 009 after it (every expense write names 009's columns).
  await page.evaluate(() => {
    localStorage.setItem('e2e:migrated-008', '1')
    localStorage.setItem('e2e:migrated-009', '1')
  })
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  expect((await server(page, 'expenses'))?.length).toBe(1)
  expect((await server(page, 'expense-budgets'))?.length).toBe(1)
  // Nothing more was said: not on the resume, not on the reconnect, not once it went.
  expect(await page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts)).toEqual([])
})

test('a device that has never loaded the expenses can restore a backup of the bets, and waits for them to back up', async ({ page }) => {
  await boot(page, { moves: [], expenses: null, settings: {} })
  await page.locator('.menu-btn').click()
  await page.locator('.app-menu .data-btn').click()
  await expect(page.locator('.data-restore')).toBeEnabled()
  await expect(page.locator('.data-backup')).toBeDisabled()
  await expect(page.locator('.data-modal')).toContainText('once your expenses, cards and budgets have loaded')
  expect(await page.locator('.data-backup').getAttribute('aria-describedby')).toMatch(/-wait-backup$/)
  expect(await page.locator('.data-restore').getAttribute('aria-describedby')).toBeNull()
})

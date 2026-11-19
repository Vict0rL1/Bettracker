import { expect, test, type Page } from '@playwright/test'
import { budgetId } from '../src/renderer/src/lib/stableId'
import { TINY_PNG, USER, addExpense, bigPng, boot, budget, card, expense, menu, openExpenseSettings, openScan, reload, scanFile } from './harness'
import { APP_URL } from './urls'

/**
 * The Expenses view (migration 008): the Bets | Expenses tabs, the sheet
 * that adds, edits and deletes an expense, the cards, the monthly budgets,
 * the currency and the chart. expenses-sync.spec.ts covers their sync
 * without the screens. Every row a month assertion counts is dated today
 * (on the 1st, "yesterday" is last month).
 */

const pad = (n: number): string => String(n).padStart(2, '0')
const TODAY = ((d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)(new Date())

const CARD_A = '6f9619ff-8b86-4011-b42d-00cf4fc964ff'
const CARD_B = '7a1c3e55-0d2b-4f6e-9a8b-1c2d3e4f5a6b'
const cardA = card({ id: CARD_A, name: 'Visa A', last4: '1234', createdAt: '2026-01-01T09:00:00.000Z', updatedAt: '2026-01-01T09:00:00.000Z' })
const cardB = card({ id: CARD_B, name: 'Débito B', last4: '9876', kind: 'debit', createdAt: '2026-01-02T09:00:00.000Z', updatedAt: '2026-01-02T09:00:00.000Z' })

type RowName = 'expenses' | 'expense-cards' | 'expense-budgets'

/** The fake server's rows of a table (`e2e:<name>`). */
const server = (page: Page, name: RowName) => page.evaluate((n) => JSON.parse(localStorage.getItem(`e2e:${n}`) ?? '[]') as Record<string, unknown>[], name)
const counter = (page: Page, name: string) => page.evaluate((n) => Number(localStorage.getItem(`e2e:${n}`) || 0), name)

/** From the bets: the Expenses tab, then its loaded view. */
async function openExpenses(page: Page): Promise<void> {
  await page.locator('.view-tab-expenses').click()
  await page.waitForSelector('.exp-bar')
}

/** Log one expense through the sheet (the + button, on every screen size). */
async function logExpense(page: Page, o: { amount: string; category?: string; card?: string; merchant?: string; refund?: boolean }): Promise<void> {
  await addExpense(page)
  const sheet = page.locator('.expense-modal')
  await sheet.locator('.exp-amount').fill(o.amount)
  if (o.refund) await sheet.locator('.exp-kind-refund').click()
  if (o.category) await sheet.locator(`.cat-chip[data-cat="${o.category}"]`).click()
  if (o.card) await sheet.locator('.exp-paycard-seg .scope-btn', { hasText: o.card }).click()
  if (o.merchant) await sheet.locator('.exp-merchant').fill(o.merchant)
  await sheet.locator('.exp-save').click()
  await expect(sheet).toHaveCount(0)
}

test('Bets is the default and Expenses is remembered; the top bar keeps only the menu and the bar only the month; T and the + button open the sheet; the tabs take the arrows; a device without expense caches can still restore', async ({ page }) => {
  await boot(page, { moves: [], expenses: null, settings: {} })

  // The bets' restore waits only for the bets' data; the backup waits for the expenses too.
  await menu(page, '.data-btn')
  const data = page.locator('.data-modal')
  await expect(data.locator('.data-restore')).toBeEnabled()
  await expect(data.locator('.data-backup')).toBeDisabled()
  await expect(data).toContainText('The backup is available once your expenses, cards and budgets have loaded on this device too.')
  await page.keyboard.press('Escape')
  await expect(data).toHaveCount(0)

  const betsTab = page.locator('.view-tab-bets')
  const expensesTab = page.locator('.view-tab-expenses')
  await expect(betsTab).toHaveAttribute('aria-selected', 'true')
  await expect(betsTab).toHaveAttribute('aria-controls', 'view-panel-bets')
  expect(await expensesTab.getAttribute('aria-controls')).toBeNull()
  await expect(page.locator('[role="tabpanel"]')).toHaveCount(1)

  await openExpenses(page)
  await expect(expensesTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#view-panel-expenses')).toBeVisible()
  await expect(page.locator('.history-card')).toHaveCount(0)
  const bar = page.locator('.topbar-actions')
  await expect(bar.locator('button:visible')).toHaveCount(1)
  await expect(page.locator('.add-expense-btn')).toHaveCount(0)
  await expect(page.locator('.add-bet-btn')).toHaveCount(0)
  // The + button speaks for this view.
  const fab = page.locator('.fab')
  await expect(fab).toHaveAttribute('aria-label', 'Add expense')
  await expect(fab).toHaveAttribute('title', 'Add an expense (T): type it, or scan a receipt.')
  // The view's bar: the month, its currency and the arrows; no Scan receipt or Expense settings there any more.
  await expect(page.locator('.exp-bar button')).toHaveCount(2)
  await expect(page.locator('.exp-scan-open, .exp-manage-btn')).toHaveCount(0)

  // T from the page (nothing focused): the expense sheet; Escape hands focus to the + button.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('t')
  const sheet = page.locator('.expense-modal')
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('h2')).toHaveText('Add expense')
  await expect(sheet.locator('.exp-amount')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(fab).toBeFocused()
  await fab.click()
  await expect(sheet).toBeVisible()
  // Scan receipt is first in the sheet.
  await expect(sheet.locator('.exp-scan-btn')).toHaveText('Scan receipt')
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)

  // Remembered on this device.
  await reload(page, '.exp-bar')
  await expect(expensesTab).toHaveAttribute('aria-selected', 'true')
  const month = await page.locator('.exp-month-title').textContent()

  // On a tab the arrows move between tabs (and select), never the month.
  await expensesTab.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(betsTab).toHaveAttribute('aria-selected', 'true')
  await expect(betsTab).toBeFocused()
  await page.waitForSelector('.history-card')
  // Back on the bets, the first-paint stagger doesn't play again.
  expect(await page.locator('.history-card').evaluate((el) => el.getAnimations().length)).toBe(0)
  await expect(fab).toHaveAttribute('aria-label', 'Add bet')
  await page.keyboard.press('ArrowRight')
  await expect(expensesTab).toHaveAttribute('aria-selected', 'true')
  await expect(expensesTab).toBeFocused()
  await expect(page.locator('.exp-month-title')).toHaveText(month ?? '')

  // In Spanish.
  await menu(page, '.lang-btn')
  await expect(expensesTab).toHaveText('Gastos')
  await expect(betsTab).toHaveText('Apuestas')
  await expect(fab).toHaveAttribute('aria-label', 'Añadir gasto')
  // The language toggle keeps the menu open: Expense settings is in it, in Spanish.
  await expect(page.locator('.app-menu .expense-settings-btn')).toHaveText('Ajustes de gastos')
})

test('add, edit and delete offline, each with Undo; kept in the outbox and across a reload; "4,50" is 4.50', async ({ page }) => {
  await boot(page, { view: 'expenses', cards: [cardA, cardB], expenses: [], budgets: [], settings: {} })
  const rows = page.locator('.exp-row')

  // The amount reads the way it was typed, before it is saved.
  await addExpense(page)
  const sheet = page.locator('.expense-modal')
  await sheet.locator('.exp-amount').fill('4,50')
  await expect(sheet.locator('.exp-amount-reads')).toHaveText('= $4.50')
  await sheet.locator('.cat-chip[data-cat="coffee"]').click()
  await expect(sheet.locator('.cat-chip[data-cat="coffee"]')).toHaveAttribute('aria-pressed', 'true')
  await sheet.locator('.exp-paycard-seg .scope-btn', { hasText: 'Visa A' }).click()
  await sheet.locator('.exp-merchant').fill('Café Central')
  await sheet.locator('.exp-save').click()
  await expect(sheet).toHaveCount(0)
  await expect(rows).toHaveCount(1)
  await expect(rows.first().locator('.exp-amount')).toHaveText('$4.50')
  await expect(rows.first().locator('.exp-col-card')).toHaveText('Visa A')
  await expect(page.locator('.spend-total')).toHaveText('$4.50')
  await expect(page.locator('.toast')).toContainText('Expense added')

  // Undo takes it back.
  await page.locator('.toast-action').click()
  await expect(rows).toHaveCount(0)

  // Again; the sheet remembers the card and category it last used.
  await addExpense(page)
  await expect(sheet.locator('.cat-chip[data-cat="coffee"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(sheet.locator('.exp-paycard-seg .scope-btn', { hasText: 'Visa A' })).toHaveAttribute('aria-pressed', 'true')
  await sheet.locator('.exp-amount').fill('4,50')
  await sheet.locator('.exp-save').click()
  await expect(rows).toHaveCount(1)
  // Offline, it waits in this device's outbox, the amount as a number.
  const outbox = () => page.evaluate((uid) => JSON.parse(localStorage.getItem(`bettracker:expenses-outbox:${uid}`) ?? '[]') as { kind: string; input?: { amount: number } }[], USER.id)
  expect((await outbox()).filter((op) => op.kind === 'add').map((op) => op.input?.amount)).toEqual([4.5])

  // Edited to 5.25.
  await rows.first().locator('.exp-edit').click()
  await expect(sheet.locator('h2')).toHaveText('Edit expense')
  await expect(sheet.locator('.exp-amount')).toHaveValue('4.50')
  await sheet.locator('.exp-amount').fill('5.25')
  await sheet.locator('.exp-save').click()
  await expect(sheet).toHaveCount(0)
  await expect(page.locator('.toast')).toContainText('Expense updated')
  await expect(rows.first().locator('.exp-amount')).toHaveText('$5.25')

  // Deleted with two clicks, then put back.
  const del = rows.first().locator('.exp-delete')
  await del.click()
  await expect(del).toHaveText('Sure?')
  await del.click()
  await expect(rows).toHaveCount(0)
  await expect(page.locator('.toast')).toContainText('Expense deleted')
  await page.locator('.toast-action').click()
  await expect(rows).toHaveCount(1)
  await expect(rows.first().locator('.exp-amount')).toHaveText('$5.25')

  // Still only on this device: the edit folded into the queued add.
  const amounts = (await outbox()).map((op) => op.input?.amount).filter((a) => a !== undefined)
  expect(amounts).toContain(5.25)
  expect(amounts.every((a) => typeof a === 'number')).toBe(true)

  await reload(page, '.exp-bar')
  await expect(rows).toHaveCount(1)
  await expect(rows.first().locator('.exp-amount')).toHaveText('$5.25')
})

test('an add syncs and the badge says Synced; a refund lowers the month and shows green; signing out with a write in flight leaves nothing', async ({ page }) => {
  await boot(page, { backend: 'live', view: 'expenses' })

  // Nothing yet: the first-time card offers the first expense.
  await expect(page.locator('.exp-first')).toBeVisible()
  await page.locator('.exp-first-add').click()
  const sheet = page.locator('.expense-modal')
  await sheet.locator('.exp-amount').fill('12')
  await sheet.locator('.exp-save').click()
  await expect(sheet).toHaveCount(0)
  await expect.poll(async () => (await server(page, 'expenses')).length).toBe(1)
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  await expect(page.locator('.exp-first')).toHaveCount(0)

  await logExpense(page, { amount: '2', refund: true, merchant: 'Devolución' })
  await expect(page.locator('.spend-total')).toHaveText('$10.00')
  await expect(page.locator('.exp-amount.refund')).toHaveText(/-\$2\.00/)
  await expect(page.locator('.exp-amount.refund')).toHaveCSS('color', await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--green').trim()).then(hexToRgb))
  await expect.poll(async () => (await server(page, 'expenses')).length).toBe(2)

  // A write held on the wire while the user signs out.
  const started = await counter(page, 'writes-started')
  await page.evaluate(() => localStorage.setItem('e2e:hold', '1'))
  await logExpense(page, { amount: '3' })
  await expect.poll(() => counter(page, 'writes-started')).toBe(started + 1)
  await menu(page, '.btn-signout')
  await menu(page, '.btn-signout')
  await expect(page.locator('.auth-card')).toBeVisible()
  const kept = () => page.evaluate((uid) => Object.keys(localStorage).filter((k) => k.startsWith('bettracker:') && k.endsWith(uid)), USER.id)
  expect(await kept()).toEqual([])

  await page.evaluate(() => localStorage.removeItem('e2e:hold'))
  await expect.poll(async () => (await server(page, 'expenses')).length).toBe(3)
  // The drain that was out has ended (it holds this lock while it runs).
  await page.evaluate((uid) => navigator.locks.request(`bettracker:drain:expenses:${uid}`, () => undefined), USER.id)
  expect(await kept()).toEqual([])
})

/** "#4cc38a" as the rgb() getComputedStyle reports. */
function hexToRgb(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

test('cards: add, rename, archive a used card, delete an unused one; never a hard delete while the list is unknown', async ({ page, browser }) => {
  await boot(page, { backend: 'live', view: 'expenses', cards: [cardA], expenses: [expense({ id: '10000000-0000-4000-8000-000000000001', date: TODAY, amount: 7, cardId: CARD_A, merchant: 'Metro' })] })
  await expect.poll(async () => (await server(page, 'expense-cards')).length).toBe(1)

  await openExpenseSettings(page)
  const settings = page.locator('.expense-settings-modal')
  await expect(settings.locator('.paycard-name-input')).toBeFocused()
  await settings.locator('.paycard-name-input').fill('Visa')
  await settings.locator('.paycard-last4-input').fill('5555')
  await settings.locator('.paycard-add').click()
  await expect(settings.locator('.paycard-row', { hasText: 'Visa' }).filter({ hasNotText: 'Visa A' })).toHaveCount(1)
  await expect.poll(async () => (await server(page, 'expense-cards')).length).toBe(2)

  // Renamed in place.
  const visa = settings.locator('.paycard-row').filter({ hasText: '5555' })
  await visa.locator('.paycard-edit').click()
  const editing = settings.locator('.paycard-row.is-editing')
  await editing.locator('.paycard-name-input').fill('Visa Oro')
  await editing.locator('.paycard-save').click()
  await expect(settings.locator('.paycard-row', { hasText: 'Visa Oro' })).toHaveCount(1)
  await expect.poll(async () => (await server(page, 'expense-cards')).map((c) => c.name).sort()).toEqual(['Visa A', 'Visa Oro'])

  // A used card is archived: its expense keeps its name.
  const a = settings.locator(`.paycard-row[data-id="${CARD_A}"]`)
  await a.locator('.paycard-delete').click()
  await a.locator('.paycard-delete').click()
  await expect(page.locator('.toast')).toContainText('Card Visa A archived')
  await expect.poll(async () => (await server(page, 'expense-cards')).find((c) => c.id === CARD_A)?.archived).toBe(true)
  await expect(settings.locator('.paycard-archived summary')).toContainText('Archived')
  await settings.locator('.expset-done').click()
  await expect(settings).toHaveCount(0)
  await expect(page.locator('.exp-row .exp-col-card')).toHaveText('Visa A')
  await addExpense(page)
  const picker = page.locator('.expense-modal .exp-paycard-field')
  await expect(picker).toContainText('Visa Oro')
  await expect(picker).not.toContainText('Visa A')
  await page.keyboard.press('Escape')

  // An unused card is deleted for good.
  await openExpenseSettings(page)
  const oro = settings.locator('.paycard-row', { hasText: 'Visa Oro' })
  await oro.locator('.paycard-delete').click()
  await oro.locator('.paycard-delete').click()
  await expect(page.locator('.toast')).toContainText('Card Visa Oro deleted')
  await expect.poll(async () => (await server(page, 'expense-cards')).map((c) => c.name)).toEqual(['Visa A'])

  // Another device whose expense list hasn't arrived: delete only archives.
  const context = await browser.newContext({ baseURL: APP_URL, locale: 'en-US' })
  const other = await context.newPage()
  await other.addInitScript(() => localStorage.setItem('e2e:hold-reads', 'expenses'))
  await boot(other, { backend: 'live', view: 'expenses', cards: [cardB], expenses: null })
  await openExpenseSettings(other)
  const b = other.locator(`.expense-settings-modal .paycard-row[data-id="${CARD_B}"]`)
  await b.locator('.paycard-delete').click()
  await b.locator('.paycard-delete').click()
  await expect(other.locator('.toast')).toContainText('Card Débito B archived')
  await expect.poll(async () => (await server(other, 'expense-cards')).find((c) => c.id === CARD_B)?.archived).toBe(true)
  await context.close()
})

test('a card added from the sheet comes back chosen, with what was typed', async ({ page }) => {
  await boot(page, { view: 'expenses', cards: [], expenses: [], budgets: [], settings: {} })
  await addExpense(page)
  const sheet = page.locator('.expense-modal')
  await sheet.locator('.exp-amount').fill('4.50')
  await sheet.locator('.exp-merchant').fill('Kiosk')
  await sheet.locator('.exp-add-card').click()
  await expect(sheet).toHaveCount(0)

  const settings = page.locator('.expense-settings-modal')
  await expect(settings.locator('.paycard-name-input')).toBeFocused()
  await settings.locator('.paycard-name-input').fill('Visa')
  await settings.locator('.paycard-add').click()
  await expect(settings.locator('.paycard-row', { hasText: 'Visa' })).toHaveCount(1)
  await settings.locator('.expset-done').click()
  await expect(settings).toHaveCount(0)

  // Back in the sheet: the amount and merchant as typed, and the new card pressed, not "No card".
  await expect(sheet.locator('.exp-amount')).toHaveValue('4.50')
  await expect(sheet.locator('.exp-merchant')).toHaveValue('Kiosk')
  const segments = sheet.locator('.exp-paycard-seg .scope-btn')
  await expect(segments.filter({ hasText: 'Visa' })).toHaveAttribute('aria-pressed', 'true')
  await expect(segments.filter({ hasText: 'No card' })).toHaveAttribute('aria-pressed', 'false')
  await sheet.locator('.exp-save').click()
  await expect(sheet).toHaveCount(0)
  await expect(page.locator('.exp-row .exp-col-card')).toHaveText('Visa')
})

test('budgets: total, per card and per category, near and over; untouched boxes write nothing; Escape keeps what was typed', async ({ page }) => {
  await boot(page, {
    backend: 'live',
    view: 'expenses',
    cards: [cardA],
    expenses: [
      expense({ id: '10000000-0000-4000-8000-000000000001', date: TODAY, amount: 85, cardId: CARD_A, category: 'food', merchant: 'Cena' }),
      expense({ id: '10000000-0000-4000-8000-000000000002', date: TODAY, amount: 4.5, category: 'coffee', merchant: 'Café' })
    ]
  })
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  const writes = await counter(page, 'writes')

  // Opened and closed without typing: nothing written.
  await openExpenseSettings(page)
  const settings = page.locator('.expense-settings-modal')
  const box = (scope: string, target = '') => settings.locator(`.budget-input[data-scope="${scope}"][data-target="${target}"]`)
  await expect(box('total')).toBeEnabled()
  await settings.locator('.expset-done').click()
  await expect(settings).toHaveCount(0)

  // The total: 89.50 of 100 is near.
  await page.locator('.budget-edit-btn').click()
  await expect(box('total')).toBeFocused()
  await box('total').fill('100')
  await box('total').press('Enter')
  await settings.locator('.expset-done').click()
  await expect(page.locator('.budget-row.budget-total.is-near')).toBeVisible()
  await expect(page.locator('.spend-budget-card .life-value.near')).toHaveText('$10.50')
  await expect.poll(async () => (await server(page, 'expense-budgets')).length).toBe(1)
  expect(await counter(page, 'writes')).toBe(writes + 1)

  // Coffee 4, closed with Escape: 4.50 is over.
  await page.locator('.budget-edit-btn').click()
  await box('category', 'coffee').fill('4')
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(page.locator('.budget-row.budget-category.is-over')).toBeVisible()
  await expect(page.locator('.budget-row.budget-category.is-over .budget-left')).toContainText('$0.50 over')

  // Card A 500: fine.
  await page.locator('.budget-edit-btn').click()
  await box('card', CARD_A).fill('500')
  await settings.locator('.expset-done').click()
  await expect(page.locator('.budget-row.budget-card.is-ok')).toBeVisible()
  await expect.poll(async () => (await server(page, 'expense-budgets')).length).toBe(3)

  // The total set again: still one row, under its own id.
  await page.locator('.budget-edit-btn').click()
  await box('total').fill('120')
  await box('total').press('Enter')
  await settings.locator('.expset-done').click()
  await expect.poll(async () => (await server(page, 'expense-budgets')).filter((b) => b.scope === 'total').map((b) => [b.id, Number(b.monthly_limit)])).toEqual([
    [budgetId(USER.id, 'total', ''), 120]
  ])

  // Cleared: its row goes.
  await page.locator('.budget-edit-btn').click()
  await box('category', 'coffee').fill('')
  await box('category', 'coffee').press('Enter')
  await settings.locator('.expset-done').click()
  await expect.poll(async () => (await server(page, 'expense-budgets')).map((b) => b.scope).sort()).toEqual(['card', 'total'])
  await expect(page.locator('.budget-row.budget-category')).toHaveCount(0)
})

test('currency: amounts follow the new currency without conversion; a wide symbol never covers the digits', async ({ page }) => {
  await boot(page, { backend: 'live', view: 'expenses', expenses: [expense({ id: '10000000-0000-4000-8000-000000000001', date: TODAY, amount: 12.5, category: 'food' })] })
  await expect(page.locator('.spend-total')).toHaveText('$12.50')

  await openExpenseSettings(page)
  const settings = page.locator('.expense-settings-modal')
  const select = settings.locator('.currency-select')
  await expect(select).toBeEnabled()
  await select.selectOption('EUR')
  await expect(page.locator('.toast')).toContainText('Nothing was converted')
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('e2e:settings') ?? '{}') as { expense_currency?: string }).expense_currency)).toBe('EUR')
  await settings.locator('.expset-done').click()
  await expect(page.locator('.spend-total')).toHaveText('€12.50')
  await expect(page.locator('.exp-currency-code')).toContainText('EUR')
  // What is stored is the same number.
  expect((await server(page, 'expenses')).map((e) => e.amount)).toEqual(['12.50'])

  // Peruvian soles: three letters before the digits (the main currency is written with its narrow symbol, which for
  // most pesos and dollars is "$"; soles have none in en-US, so their code stands in).
  await openExpenseSettings(page)
  await select.selectOption('PEN')
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('e2e:settings') ?? '{}') as { expense_currency?: string }).expense_currency)).toBe('PEN')
  await settings.locator('.expset-done').click()
  await expect(page.locator('.spend-total')).toHaveText(/^PEN\s12\.50$/)
  await addExpense(page)
  const sheet = page.locator('.expense-modal')
  await sheet.locator('.exp-amount').fill('12500')
  await expect(sheet.locator('.amount-cur')).toHaveText('PEN')
  // The sheet's own currency box says the same, and is the main one until changed.
  await expect(sheet.locator('.exp-currency')).toHaveValue('PEN')
  const cur = await sheet.locator('.amount-cur').boundingBox()
  const input = await sheet.locator('.exp-amount').boundingBox()
  const padding = await sheet.locator('.exp-amount').evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
  if (!cur || !input) throw new Error('no boxes')
  expect(cur.x + cur.width).toBeLessThanOrEqual(input.x + padding)
})

test('the chart stacks each card’s spending, with the budget line', async ({ page }) => {
  await boot(page, {
    view: 'expenses',
    cards: [cardA, cardB],
    expenses: [
      expense({ id: '10000000-0000-4000-8000-000000000001', date: TODAY, amount: 20, cardId: CARD_A }),
      expense({ id: '10000000-0000-4000-8000-000000000002', date: TODAY, amount: 15, cardId: CARD_B }),
      expense({ id: '10000000-0000-4000-8000-000000000003', date: TODAY, amount: 5 })
    ],
    budgets: [budget({ scope: 'total', monthlyLimit: 300 })],
    settings: {}
  })
  const chart = page.locator('.spend-chart-card')
  await expect(chart.locator('.recharts-wrapper')).toBeVisible()
  await expect(chart.locator('.spend-legend li')).toHaveText(['Visa A', 'Débito B', 'No card', 'Budget'])
  await expect(chart.locator('.recharts-area')).toHaveCount(3)
  await expect(chart.locator('.spend-budget-line')).toHaveCount(1)

  await chart.locator('.spend-chart-view .scope-btn', { hasText: 'Per day' }).click()
  await expect(chart.locator('.spend-chart-view .scope-btn', { hasText: 'Per day' })).toHaveAttribute('aria-pressed', 'true')
  await expect(chart.locator('.recharts-bar-rectangle').first()).toBeVisible()
  await expect(chart.locator('.spend-budget-line')).toHaveCount(0)
  // Nothing moves at rest.
  await page.waitForFunction(() => document.getAnimations().length === 0)
})

/** A row of the fake AI reading's answer (the shape of the Edge Function's). */
const aiRow = (o: { amount: number; merchant: string; category: string; date?: string | null; cardLast4?: string | null; confidence?: string }) => ({
  date: o.date === undefined ? TODAY : o.date,
  amount: o.amount,
  merchant: o.merchant,
  category: o.category,
  cardLast4: o.cardLast4 ?? null,
  cardHint: null,
  note: '',
  pending: false,
  confidence: o.confidence ?? 'high'
})

/** Whether the focus is inside the expense sheet. */
const focusInSheet = (page: Page) => page.evaluate(() => Boolean(document.activeElement?.closest('.expense-modal')))

test('AI scan: matches the card by its last 4, unticks a duplicate, adds the rest, Undo removes them; no image kept; the focus stays in the dialog', async ({ page }) => {
  await boot(page, {
    backend: 'live',
    view: 'expenses',
    cards: [cardA],
    expenses: [expense({ id: '10000000-0000-4000-8000-000000000001', date: TODAY, amount: 23.18, cardId: CARD_A, category: 'groceries', merchant: 'Supermercado La Plaza' })],
    ai: {
      rows: [
        aiRow({ amount: 4.5, merchant: 'Café Central', category: 'coffee', cardLast4: '1234' }),
        aiRow({ amount: 23.18, merchant: 'SUPERMERCADO LA PLAZA #123', category: 'groceries', cardLast4: '1234' }),
        aiRow({ amount: -12, merchant: 'Tienda', category: 'shopping' })
      ]
    }
  })
  await expect(page.locator('.sync-badge')).toHaveText('Synced')

  await openScan(page)
  await page.setInputFiles('.exp-scan-input', await bigPng(page))
  const rows = page.locator('.exp-review-row')
  await expect(rows).toHaveCount(3)
  expect(await focusInSheet(page)).toBe(true)
  await page.keyboard.press('Tab')
  expect(await focusInSheet(page)).toBe(true)

  // The coffee: its card found by the last 4 digits.
  await expect(rows.nth(0).locator('.exp-review-meta')).toContainText('Visa A')
  await expect(rows.nth(0).locator('.exp-review-cardhow')).toHaveText('Matched by its last 4 digits')
  await expect(rows.nth(0).locator('.exp-review-include')).toBeChecked()
  // The groceries: already saved, so unticked, next to what it matches.
  await expect(rows.nth(1)).toHaveClass(/is-dup/)
  await expect(rows.nth(1).locator('.exp-review-include')).not.toBeChecked()
  await expect(rows.nth(1).locator('.exp-review-match')).toContainText('Supermercado La Plaza')
  // The refund: green.
  const refund = rows.nth(2).locator('.exp-review-amount-text')
  await expect(refund).toHaveClass(/refund/)
  await expect(refund).toHaveCSS('color', await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--green').trim()).then(hexToRgb))

  await expect(page.locator('.exp-review-add')).toHaveText('Add 2 expenses')
  await page.locator('.exp-review-add').click()
  await expect(page.locator('.expense-modal')).toHaveCount(0)
  await expect(page.locator('.toast')).toContainText('2 expenses added')
  await expect.poll(async () => (await server(page, 'expenses')).length).toBe(3)
  const added = (await server(page, 'expenses')).filter((e) => e.source === 'ai')
  expect(added.map((e) => [Number(e.amount), e.card_id]).sort()).toEqual([
    [-12, null],
    [4.5, CARD_A]
  ])
  await page.locator('.toast-action').click()
  await expect.poll(async () => (await server(page, 'expenses')).length).toBe(1)
  await expect(page.locator('.exp-row')).toHaveCount(1)

  // What was sent: a JPEG of the image, and nothing of it is kept anywhere but the fake's own record.
  const last = await page.evaluate(() => JSON.parse(localStorage.getItem('e2e:ai-last') ?? '{}') as { mediaType: string; chars: number; head: string })
  expect(last.mediaType).toBe('image/jpeg')
  expect(last.chars).toBeGreaterThan(10_000)
  expect(last.chars).toBeLessThanOrEqual(1_500_000)
  expect(last.head).toHaveLength(32)
  const holding = await page.evaluate(
    (head) =>
      [
        ...Object.keys(localStorage)
          .filter((k) => k !== 'e2e:ai-last' && (localStorage.getItem(k) ?? '').includes(head))
          .map((k) => `local:${k}`),
        ...Object.keys(sessionStorage)
          .filter((k) => (sessionStorage.getItem(k) ?? '').includes(head))
          .map((k) => `session:${k}`)
      ],
    last.head
  )
  expect(holding).toEqual([])
  expect(await counter(page, 'ai-calls')).toBe(1)
})

test('AI failures say why, and typing the expense still works', async ({ page }) => {
  await boot(page, { backend: 'live', view: 'expenses', ai: { fail: 'not_deployed' } })
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  const error = page.locator('.exp-scan-error')
  const retry = page.locator('.exp-scan-retry')

  await openScan(page)
  await page.setInputFiles('.exp-scan-input', scanFile)
  await expect(error).toContainText('isn’t set up')
  await expect(retry).toBeFocused()

  await page.evaluate(() => localStorage.setItem('e2e:ai-fail', 'limit_reached'))
  await retry.click()
  await expect(error).toContainText('spend limit')
  await page.evaluate(() => localStorage.setItem('e2e:ai-fail', 'refused'))
  await retry.click()
  await expect(error).toContainText('declined')
  expect(await counter(page, 'ai-calls')).toBe(3)

  // Typed instead.
  await page.locator('.exp-scan-manual').click()
  const sheet = page.locator('.expense-modal')
  await expect(sheet.locator('.exp-amount')).toBeVisible()

  // The connection drops: no reading can start, and the sheet says why.
  await page.evaluate(() => {
    localStorage.setItem('e2e:down', '1')
    window.dispatchEvent(new Event('offline'))
  })
  await expect(sheet.locator('.exp-scan-btn')).toBeDisabled()
  await expect(sheet.locator('.exp-scan-off')).toHaveText('AI reading needs a connection. You can still type the expense.')
  await sheet.locator('.exp-amount').fill('6')
  await sheet.locator('.exp-save').click()
  await expect(sheet).toHaveCount(0)
  await expect(page.locator('.exp-row')).toHaveCount(1)
  await expect(page.locator('.exp-row .exp-amount')).toHaveText('$6.00')
  expect(await counter(page, 'ai-calls')).toBe(3)
})

test('cancelling while reading adds nothing, even when the answer comes later', async ({ page }) => {
  await boot(page, { backend: 'live', view: 'expenses', ai: { hold: true, ignoreAbort: true } })
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  await openScan(page)
  await page.setInputFiles('.exp-scan-input', scanFile)
  await expect(page.locator('.exp-reading')).toBeVisible()
  await expect(page.locator('.exp-scan-cancel')).toBeFocused()
  await page.locator('.exp-scan-cancel').click()
  await expect(page.locator('.exp-drop')).toBeVisible()

  // The answer the cancelled call still gets.
  await page.evaluate(() => localStorage.removeItem('e2e:ai-hold'))
  await expect.poll(() => counter(page, 'ai-answered')).toBe(1)
  await expect(page.locator('.exp-review-row')).toHaveCount(0)
  await expect(page.locator('.exp-drop')).toBeVisible()
  expect(await server(page, 'expenses')).toEqual([])
  await page.keyboard.press('Escape')
  await expect(page.locator('.expense-modal')).toHaveCount(0)
  await expect(page.locator('.exp-row')).toHaveCount(0)
})

test('text pasted into a box is typing, even with a picture of the copied cells; an image pasted anywhere else is read', async ({ page }) => {
  await boot(page, { backend: 'live', view: 'expenses', cards: [cardA], ai: { hold: true } })
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  await addExpense(page)
  const sheet = page.locator('.expense-modal')
  await expect(sheet.locator('.exp-amount')).toBeFocused()

  /** A paste on `selector`, as Excel or Word copy cells: text and a PNG of them (or the PNG alone); true when the sheet took it. */
  const paste = (selector: string, text: string | null): Promise<boolean> =>
    page.evaluate(
      ({ selector, text, png }) => {
        const data = new DataTransfer()
        if (text !== null) data.setData('text/plain', text)
        data.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], 'cells.png', { type: 'image/png' }))
        const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
        const target = document.querySelector(selector)
        if (!target) throw new Error(`nothing matches ${selector}`)
        target.dispatchEvent(event)
        return event.defaultPrevented
      },
      { selector, text, png: TINY_PNG.toString('base64') }
    )

  // Into Amount, Merchant or Note: the text is the paste; no reading starts.
  for (const box of ['.exp-amount', '.exp-merchant', '.exp-note']) expect(await paste(`.expense-modal ${box}`, '4.50'), box).toBe(false)
  await expect(sheet.locator('.exp-amount')).toBeVisible()
  await expect(page.locator('.exp-reading')).toHaveCount(0)

  // Elsewhere in the sheet (a category chip), the image is a receipt.
  expect(await paste('.expense-modal .cat-chip[data-cat="coffee"]', '4.50')).toBe(true)
  await expect(page.locator('.exp-reading')).toBeVisible()
  await page.locator('.exp-scan-cancel').click()
  await page.locator('.exp-scan-back').click()
  await expect(sheet.locator('.exp-amount')).toBeVisible()

  // An image with no text, even into a box, is read too.
  expect(await paste('.expense-modal .exp-amount', null)).toBe(true)
  await expect(page.locator('.exp-reading')).toBeVisible()
  await page.locator('.exp-scan-cancel').click()
  expect(await counter(page, 'ai-calls')).toBe(0)
})

test('before 008: only proof counts; expenses wait as Update needed, budgets and the currency are off, and all goes once it runs', async ({ page }) => {
  // No connection at first: nothing is known of 008 yet.
  await page.addInitScript(() => localStorage.setItem('e2e:down', '1'))
  await boot(page, { backend: 'behind-008', view: 'expenses', moves: [] })
  await openExpenseSettings(page)
  const settings = page.locator('.expense-settings-modal')
  await expect(settings.locator('.expset-connect')).toHaveText('Connect once on this device to set budgets and the currency.')
  await expect(settings.locator('.currency-select')).toBeDisabled()
  await expect(settings.locator('.budget-input').first()).toBeDisabled()
  await expect(page.locator('.exp-migration')).toHaveCount(0)
  await settings.locator('.expset-done').click()
  await expect(settings).toHaveCount(0)

  // Back online: the reads find the tables missing, which the view says (no toast for a read).
  await page.evaluate(() => {
    localStorage.removeItem('e2e:down')
    window.dispatchEvent(new Event('online'))
  })
  await expect(page.locator('.exp-migration')).toBeVisible()
  await expect(page.locator('.toast')).toHaveCount(0)

  // An expense waits on this device, said once.
  await logExpense(page, { amount: '4.50', category: 'coffee' })
  await expect(page.locator('.sync-badge')).toHaveText('Update needed · 1 queued')
  await expect(page.locator('.exp-row')).toHaveCount(1)
  // Said once, for the three tables (expenses-sync.spec.ts: not again on a resume or a reconnect).
  await expect(page.locator('.toast')).toContainText('Your database is behind the app')
  await expect(page.locator('.toast')).toHaveCount(1)
  await openExpenseSettings(page)
  await expect(settings.locator('.expset-needs008')).toBeVisible()
  await expect(settings.locator('.currency-select')).toBeDisabled()
  await expect(settings.locator('.budget-input').first()).toBeDisabled()
  await settings.locator('.expset-done').click()

  // 008 runs, and 009 after it (every expense write names 009's columns: expenses-fx.spec.ts covers the database in between).
  await page.evaluate(() => {
    localStorage.setItem('e2e:migrated-008', '1')
    localStorage.setItem('e2e:migrated-009', '1')
    window.dispatchEvent(new Event('online'))
  })
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  await expect.poll(async () => (await server(page, 'expenses')).length).toBe(1)
  await expect(page.locator('.exp-migration')).toHaveCount(0)
  await openExpenseSettings(page)
  await expect(settings.locator('.currency-select')).toBeEnabled()
  await expect(settings.locator('.budget-input').first()).toBeEnabled()
  await expect(settings.locator('.expset-needs008')).toHaveCount(0)
  await expect(settings.locator('.expset-connect')).toHaveCount(0)
})

test('on a 320px phone the review fits, in Spanish and in English', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.addInitScript(() => {
    if (!localStorage.getItem('bettracker:lang')) localStorage.setItem('bettracker:lang', 'es')
  })
  await boot(page, {
    backend: 'live',
    view: 'expenses',
    cards: [cardA],
    expenses: [],
    ai: {
      rows: [
        aiRow({ amount: 4.5, merchant: 'Café Central', category: 'coffee', cardLast4: '1234' }),
        aiRow({ amount: 1234.56, merchant: 'Supermercado Internacional de Productos Frescos La Esperanza', category: 'groceries' }),
        aiRow({ amount: 18, merchant: 'Farmacia', category: 'health', date: null })
      ]
    }
  })
  await expect(page.locator('.sync-badge')).toHaveText(/Sincronizado|Synced/)

  for (const lang of ['es', 'en'] as const) {
    await openScan(page)
    await page.setInputFiles('.exp-scan-input', scanFile)
    const rows = page.locator('.exp-review-row')
    await expect(rows).toHaveCount(3)
    for (const box of await rows.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect))) {
      expect(box.x, `${lang}: a row starts on the screen`).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width, `${lang}: a row ends on the screen`).toBeLessThanOrEqual(320)
    }
    const modal = page.locator('.expense-modal')
    expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth), `${lang}: nothing sideways in the dialog`).toBe(true)
    // The row with no date is open, its date and amount side by side.
    const guessed = rows.nth(2)
    await expect(guessed).toHaveClass(/is-open/)
    // Both boxes from one frame: the review can show while the phone sheet still rises (sheet-in moves it up to 24px).
    const [date, amount] = await guessed.evaluate((row) =>
      ['.exp-review-field-date', '.exp-review-field-amount'].map((selector) => {
        const field = row.querySelector(selector)
        if (!field) throw new Error(`no ${selector}`)
        return field.getBoundingClientRect().toJSON() as DOMRect
      })
    )
    expect(Math.abs(date.y - amount.y), `${lang}: on one line`).toBeLessThan(2)
    expect(date.x + date.width, `${lang}: date before amount`).toBeLessThanOrEqual(amount.x)
    expect(amount.x + amount.width, `${lang}: amount on the screen`).toBeLessThanOrEqual(320)

    // Discard it (two presses), then the other language.
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(modal).toHaveCount(0)
    if (lang === 'es') {
      await menu(page, '.lang-btn')
      await page.keyboard.press('Escape')
      await expect(page.locator('.app-menu')).toHaveCount(0)
      await expect(page.locator('.view-tab-expenses')).toHaveText('Expenses')
    }
  }
})

// ---- the polish of November 2026: category glyphs, the month against the one before, a merchant's last category and card ----

/** A date of the month `back` months before this one, on that day number. */
const monthDay = (back: number, day: number): string => ((d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(day)}`)(new Date(new Date().getFullYear(), new Date().getMonth() - back, 1))

test('each category has its glyph wherever it is named, for the eye only: the names and what a screen reader hears stay as they were', async ({ page }) => {
  await boot(page, {
    backend: 'live',
    view: 'expenses',
    cards: [cardA],
    expenses: [
      expense({ id: '10000000-0000-4000-8000-000000000001', date: TODAY, amount: 4.5, cardId: CARD_A, category: 'coffee', merchant: 'Café Central' }),
      expense({ id: '10000000-0000-4000-8000-000000000002', date: TODAY, amount: 60, category: 'groceries', merchant: 'Metro' }),
      // A category a newer app wrote: filed, and drawn, as "Other".
      expense({ id: '10000000-0000-4000-8000-000000000003', date: TODAY, amount: 9, category: 'pets', merchant: 'Vet' })
    ],
    budgets: [budget({ scope: 'total', monthlyLimit: 500 }), budget({ scope: 'card', target: CARD_A, monthlyLimit: 300 }), budget({ scope: 'category', target: 'coffee', monthlyLimit: 40 })],
    ai: { rows: [{ date: TODAY, amount: 23.18, merchant: 'IGA', category: 'groceries', cardLast4: null, cardHint: null, note: '', pending: false, confidence: 'high' }] }
  })
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  const glyph = (cat: string): string => `svg.cat-icon[data-cat-icon="${cat}"]`

  // The list: one glyph in each row's category cell, the cell's text unchanged.
  const row = (merchant: string) => page.locator('.exp-row', { hasText: merchant })
  await expect(row('Café Central').locator('.exp-cat')).toHaveText('Coffee')
  await expect(row('Café Central').locator(`.exp-cat ${glyph('coffee')}`)).toHaveCount(1)
  await expect(row('Metro').locator(`.exp-cat ${glyph('groceries')}`)).toHaveCount(1)
  await expect(row('Vet').locator('.exp-cat')).toHaveText('Other')
  await expect(row('Vet').locator(`.exp-cat ${glyph('other')}`)).toHaveCount(1)

  // Where the money went, and the budgets: a category's row has its glyph; the month's and a card's have none.
  await expect(page.locator(`.spend-cat-row[data-cat="groceries"] ${glyph('groceries')}`)).toHaveCount(1)
  await expect(page.locator('.spend-cat-row[data-cat="groceries"] .spend-cat-name')).toHaveText('Groceries')
  await expect(page.locator(`.budget-row.budget-category ${glyph('coffee')}`)).toHaveCount(1)
  await expect(page.locator('.budget-row.budget-total .cat-icon, .budget-row.budget-card .cat-icon')).toHaveCount(0)

  // Every glyph is decoration: hidden from screen readers, never focusable, and in a neutral ink (colour is for money).
  const all = page.locator('svg.cat-icon')
  expect(await all.count()).toBeGreaterThan(6)
  expect(await all.evaluateAll((els) => els.every((el) => el.getAttribute('aria-hidden') === 'true' && el.getAttribute('focusable') === 'false'))).toBe(true)
  const inks = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    const probe = document.createElement('span')
    document.body.append(probe)
    const rgb = (token: string): string => {
      probe.style.color = style.getPropertyValue(token).trim()
      return getComputedStyle(probe).color
    }
    const out = ['--text', '--text-2', '--text-3'].map(rgb)
    probe.remove()
    return out
  })
  for (const color of await all.evaluateAll((els) => els.map((el) => getComputedStyle(el).color))) expect(inks).toContain(color)

  // The sheet: the eleven categories, each chip with its own glyph and still named by its word alone.
  await addExpense(page)
  const sheet = page.locator('.expense-modal')
  const chips = sheet.locator('.cat-chip')
  await expect(chips).toHaveCount(11)
  expect(await chips.evaluateAll((els) => els.every((el) => el.querySelector('svg.cat-icon')?.getAttribute('data-cat-icon') === el.getAttribute('data-cat')))).toBe(true)
  await expect(sheet.getByRole('button', { name: 'Coffee', exact: true })).toHaveAttribute('data-cat', 'coffee')
  await expect(sheet.getByRole('button', { name: 'Food & restaurants', exact: true })).toHaveAttribute('data-cat', 'food')

  // The review of a scan: the glyph before the row's category.
  await sheet.locator('.exp-scan-btn').click()
  await page.setInputFiles('.exp-scan-input', scanFile)
  const read = page.locator('.exp-review-row')
  await expect(read).toHaveCount(1)
  await expect(read.locator(`.exp-review-meta ${glyph('groceries')}`)).toHaveCount(1)
  await expect(read.locator('.exp-review-meta')).toHaveText(/Groceries/)
  await read.locator('.exp-review-include').uncheck()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)

  // The budgets' boxes: the category ones, not the month's nor a card's.
  await page.locator('.budget-edit-btn').click()
  const settings = page.locator('.expense-settings-modal')
  await expect(settings.locator('.budget-box-category')).toHaveCount(11)
  await expect(settings.locator('.budget-box-category svg.cat-icon')).toHaveCount(11)
  await expect(settings.locator('.budget-box-total svg.cat-icon, .budget-box-card svg.cat-icon')).toHaveCount(0)
  // The box is still named by the category alone.
  await expect(settings.getByLabel('Coffee', { exact: true })).toHaveValue('40')
  await settings.locator('.expset-done').click()
  await expect(settings).toHaveCount(0)

  // On a phone the glyph leads each card of the list.
  await page.setViewportSize({ width: 390, height: 844 })
  const item = page.locator('.exp-item', { hasText: 'Café Central' })
  await expect(item.locator(`.exp-item-open > ${glyph('coffee')}`)).toHaveCount(1)
  const [icon, merchant] = [await item.locator('svg.cat-icon').boundingBox(), await item.locator('.exp-item-merchant').boundingBox()]
  if (!icon || !merchant) throw new Error('no boxes')
  expect(icon.x + icon.width).toBeLessThanOrEqual(merchant.x)
  await expect(item.locator('.exp-item-open')).toHaveAccessibleName(/^Edit expense: Café Central, /)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('under Spent, the month against the one before it: day for day, in words and a neutral arrow; gone when there is nothing to compare with', async ({ page }) => {
  // The 1st of each month is never after today's day number, so both are always inside what is compared.
  await boot(page, {
    backend: 'live',
    view: 'expenses',
    cards: [cardA],
    expenses: [
      expense({ id: '10000000-0000-4000-8000-000000000001', date: monthDay(0, 1), amount: 62, cardId: CARD_A, category: 'groceries', merchant: 'Metro' }),
      expense({ id: '10000000-0000-4000-8000-000000000002', date: monthDay(0, 1), amount: 50, category: 'food', merchant: 'Cena' }),
      expense({ id: '10000000-0000-4000-8000-000000000003', date: monthDay(1, 1), amount: 100, cardId: CARD_A, category: 'groceries', merchant: 'Metro' })
    ],
    budgets: []
  })
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  const vs = page.locator('.spend-total-card .spend-vs')
  await expect(vs).toHaveText('12% more than at this point last month')
  await expect(vs).toHaveAttribute('data-direction', 'more')
  await expect(vs.locator('svg[aria-hidden="true"]')).toHaveCount(1)
  // What it is compared with, to the cent, for whoever hovers.
  expect(await vs.getAttribute('title')).toMatch(/^Through .+: \$100\.00$/)
  // Spending more is not a loss: the line is in the ink of the count above it, never red or green.
  await expect(vs).toHaveCSS('color', await page.locator('.spend-total-card .stat-sub').first().evaluate((el) => getComputedStyle(el).color))
  // Nothing about it moves once the figures have settled in.
  await page.waitForFunction(() => document.getAnimations().length === 0)

  // Less, once a refund this month brings it under: the arrow turns, the words say so.
  await logExpense(page, { amount: '30', refund: true, merchant: 'Devolución' })
  await expect(vs).toHaveText('18% less than at this point last month')
  await expect(vs).toHaveAttribute('data-direction', 'less')

  // In Spanish.
  await menu(page, '.lang-btn')
  await expect(vs).toHaveText('18% menos que el mes pasado a estas alturas')
  await page.keyboard.press('Escape')
  await menu(page, '.lang-btn')
  await page.keyboard.press('Escape')
  await expect(vs).toHaveText('18% less than at this point last month')

  // Last month, whole, has no month before it with expenses: nothing is said.
  await page.locator('.exp-month-nav .nav-btn').first().click()
  await expect(page.locator('.spend-total')).toHaveText('$100.00')
  await expect(page.locator('.spend-vs')).toHaveCount(0)
  // Next month has not started: nothing either.
  await page.locator('.exp-today').click()
  await page.locator('.exp-month-nav .nav-btn').nth(1).click()
  await expect(page.locator('.spend-total')).toHaveText('$0.00')
  await expect(page.locator('.spend-vs')).toHaveCount(0)
})

test('a merchant typed before brings its last category and card, until the user chooses them; an expense being edited keeps its own', async ({ page }) => {
  await boot(page, {
    backend: 'live',
    view: 'expenses',
    cards: [cardA, cardB],
    expenses: [
      expense({ id: '10000000-0000-4000-8000-000000000001', date: TODAY, amount: 5.4, cardId: CARD_B, category: 'coffee', merchant: 'Starbucks' }),
      expense({ id: '10000000-0000-4000-8000-000000000002', date: monthDay(1, 1), amount: 7, cardId: CARD_A, category: 'food', merchant: 'Starbucks' }),
      expense({ id: '10000000-0000-4000-8000-000000000003', date: TODAY, amount: 22, cardId: null, category: 'transport', merchant: 'Uber' })
    ],
    budgets: []
  })
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  await addExpense(page)
  const sheet = page.locator('.expense-modal')
  const chip = (cat: string) => sheet.locator(`.cat-chip[data-cat="${cat}"]`)
  const cardBtn = (name: string) => sheet.locator('.exp-paycard-seg .scope-btn', { hasText: name })
  const merchant = sheet.locator('.exp-merchant')
  const brought = sheet.locator('.exp-merchant-last')

  // The sheet opens on its defaults, and suggests the merchants typed before, the latest first, each once.
  await expect(chip('other')).toHaveAttribute('aria-pressed', 'true')
  await expect(cardBtn('No card')).toHaveAttribute('aria-pressed', 'true')
  expect(await sheet.locator('datalist option').evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value).sort())).toEqual(['Starbucks', 'Uber'])
  await expect(brought).toBeHidden()

  // The whole name, whatever its case: the category and card of its latest expense, and a line that says so.
  await sheet.locator('.exp-amount').fill('6.10')
  await merchant.fill('Starb')
  await expect(chip('other')).toHaveAttribute('aria-pressed', 'true')
  await merchant.fill('starbucks')
  await expect(chip('coffee')).toHaveAttribute('aria-pressed', 'true')
  await expect(cardBtn('Débito B')).toHaveAttribute('aria-pressed', 'true')
  await expect(brought).toHaveText('As last time: Coffee · Débito B')
  expect(await merchant.getAttribute('aria-describedby')).toBe(await brought.getAttribute('id'))

  // Typed on past it: back to what the sheet opened with, and nothing is claimed.
  await merchant.fill('Starbucks Reserve')
  await expect(chip('other')).toHaveAttribute('aria-pressed', 'true')
  await expect(cardBtn('No card')).toHaveAttribute('aria-pressed', 'true')
  await expect(brought).toBeHidden()

  // "No card" is brought like a card.
  await merchant.fill('Uber')
  await expect(chip('transport')).toHaveAttribute('aria-pressed', 'true')
  await expect(cardBtn('No card')).toHaveAttribute('aria-pressed', 'true')
  await expect(brought).toHaveText('As last time: Transport · No card')

  // A category the user chose stays theirs; the card still follows.
  await chip('entertainment').click()
  await expect(brought).toHaveText('As last time: No card')
  await merchant.fill('Starbucks')
  await expect(chip('entertainment')).toHaveAttribute('aria-pressed', 'true')
  await expect(cardBtn('Débito B')).toHaveAttribute('aria-pressed', 'true')
  await expect(brought).toHaveText('As last time: Débito B')
  // …and once the card is chosen too, the merchant changes nothing more.
  await cardBtn('Visa A').click()
  await expect(brought).toBeHidden()
  await merchant.fill('Uber')
  await expect(chip('entertainment')).toHaveAttribute('aria-pressed', 'true')
  await expect(cardBtn('Visa A')).toHaveAttribute('aria-pressed', 'true')
  await sheet.locator('.exp-save').click()
  await expect(sheet).toHaveCount(0)
  await expect.poll(async () => (await server(page, 'expenses')).find((r) => r.amount === 6.1)).toMatchObject({ merchant: 'Uber', category: 'entertainment', card_id: CARD_A })

  // What is saved is what the merchant brought when nothing was chosen.
  await addExpense(page)
  await sheet.locator('.exp-amount').fill('4.75')
  await merchant.fill('Starbucks')
  await expect(brought).toHaveText('As last time: Coffee · Débito B')
  await sheet.locator('.exp-save').click()
  await expect(sheet).toHaveCount(0)
  await expect.poll(async () => (await server(page, 'expenses')).find((r) => r.amount === 4.75)).toMatchObject({ merchant: 'Starbucks', category: 'coffee', card_id: CARD_B })

  // Editing: the expense's own category and card are never changed by retyping its merchant.
  await page.locator('.exp-row', { hasText: '$22.00' }).locator('.exp-edit').click()
  await expect(sheet.locator('h2')).toHaveText('Edit expense')
  await merchant.fill('Starbucks')
  await expect(chip('transport')).toHaveAttribute('aria-pressed', 'true')
  await expect(cardBtn('No card')).toHaveAttribute('aria-pressed', 'true')
  await expect(brought).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
})

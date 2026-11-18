import { expect, test, type Page } from '@playwright/test'
import { budgetId } from '../src/renderer/src/lib/stableId'
import { USER, boot, budget, card, expense, menu, reload } from './harness'
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

/** Add one expense through the sheet (the + button on a phone, Add expense on a computer). */
async function addExpense(page: Page, o: { amount: string; category?: string; card?: string; merchant?: string; refund?: boolean }): Promise<void> {
  const fab = page.locator('.fab')
  if (await fab.isVisible()) await fab.click()
  else await page.locator('.add-expense-btn').click()
  const sheet = page.locator('.expense-modal')
  await sheet.locator('.exp-amount').fill(o.amount)
  if (o.refund) await sheet.locator('.exp-kind-refund').click()
  if (o.category) await sheet.locator(`.cat-chip[data-cat="${o.category}"]`).click()
  if (o.card) await sheet.locator('.exp-paycard-seg .scope-btn', { hasText: o.card }).click()
  if (o.merchant) await sheet.locator('.exp-merchant').fill(o.merchant)
  await sheet.locator('.exp-save').click()
  await expect(sheet).toHaveCount(0)
}

test('Bets is the default and Expenses is remembered; the top bar keeps two buttons; T and Add expense open the sheet; the tabs take the arrows; a device without expense caches can still restore', async ({ page }) => {
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
  await expect(bar.locator('button:visible')).toHaveCount(2)
  await expect(bar.locator('.add-expense-btn')).toHaveText('Add expense')
  await expect(page.locator('.add-bet-btn')).toHaveCount(0)

  // T from the page (nothing focused): the expense sheet; Escape hands focus to Add expense.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('t')
  const sheet = page.locator('.expense-modal')
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('h2')).toHaveText('Add expense')
  await expect(sheet.locator('.exp-amount')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(page.locator('.add-expense-btn')).toBeFocused()
  await page.locator('.add-expense-btn').click()
  await expect(sheet).toBeVisible()
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
  await expect(page.locator('.topbar-actions .add-bet-btn')).toHaveText('Add bet')
  await page.keyboard.press('ArrowRight')
  await expect(expensesTab).toHaveAttribute('aria-selected', 'true')
  await expect(expensesTab).toBeFocused()
  await expect(page.locator('.exp-month-title')).toHaveText(month ?? '')

  // In Spanish.
  await menu(page, '.lang-btn')
  await expect(expensesTab).toHaveText('Gastos')
  await expect(betsTab).toHaveText('Apuestas')
  await expect(page.locator('.add-expense-btn')).toHaveText('Añadir gasto')
})

test('add, edit and delete offline, each with Undo; kept in the outbox and across a reload; "4,50" is 4.50', async ({ page }) => {
  await boot(page, { view: 'expenses', cards: [cardA, cardB], expenses: [], budgets: [], settings: {} })
  const rows = page.locator('.exp-row')

  // The amount reads the way it was typed, before it is saved.
  await page.locator('.add-expense-btn').click()
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
  await page.locator('.add-expense-btn').click()
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

  await addExpense(page, { amount: '2', refund: true, merchant: 'Devolución' })
  await expect(page.locator('.spend-total')).toHaveText('$10.00')
  await expect(page.locator('.exp-amount.refund')).toHaveText(/-\$2\.00/)
  await expect(page.locator('.exp-amount.refund')).toHaveCSS('color', await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--green').trim()).then(hexToRgb))
  await expect.poll(async () => (await server(page, 'expenses')).length).toBe(2)

  // A write held on the wire while the user signs out.
  const started = await counter(page, 'writes-started')
  await page.evaluate(() => localStorage.setItem('e2e:hold', '1'))
  await addExpense(page, { amount: '3' })
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

  await page.locator('.exp-manage-btn').click()
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
  await page.locator('.add-expense-btn').click()
  const picker = page.locator('.expense-modal .exp-paycard-field')
  await expect(picker).toContainText('Visa Oro')
  await expect(picker).not.toContainText('Visa A')
  await page.keyboard.press('Escape')

  // An unused card is deleted for good.
  await page.locator('.exp-manage-btn').click()
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
  await other.locator('.exp-manage-btn').click()
  const b = other.locator(`.expense-settings-modal .paycard-row[data-id="${CARD_B}"]`)
  await b.locator('.paycard-delete').click()
  await b.locator('.paycard-delete').click()
  await expect(other.locator('.toast')).toContainText('Card Débito B archived')
  await expect.poll(async () => (await server(other, 'expense-cards')).find((c) => c.id === CARD_B)?.archived).toBe(true)
  await context.close()
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
  await page.locator('.exp-manage-btn').click()
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

  await page.locator('.exp-manage-btn').click()
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

  // Colombian pesos: three letters before the digits.
  await page.locator('.exp-manage-btn').click()
  await select.selectOption('COP')
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('e2e:settings') ?? '{}') as { expense_currency?: string }).expense_currency)).toBe('COP')
  await settings.locator('.expset-done').click()
  await page.locator('.add-expense-btn').click()
  const sheet = page.locator('.expense-modal')
  await sheet.locator('.exp-amount').fill('12500')
  await expect(sheet.locator('.amount-cur')).toHaveText('COP')
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

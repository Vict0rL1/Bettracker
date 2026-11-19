import { expect, test, type Page } from '@playwright/test'
import { boot, budget, card, expense, menu } from './harness'

/**
 * The month's summary strip, the budgets panel and the categories after the
 * 2.0 polish: the daily average says how it is made and where the month is
 * heading (the projection lives in that line alone); nothing reads as a zero
 * before the expenses have loaded; "+n more" lists every card; a month with
 * no budgets takes one line and "Set one"; on a phone Budget left and Daily
 * average share a row.
 */

const pad = (n: number): string => String(n).padStart(2, '0')
const now = new Date()
const dateOf = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const TODAY = dateOf(now)
/** Today's day number and the month's days: the average divides by the first, the projection multiplies by the second. */
const DAY = now.getDate()
const DAYS = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
/** Last month's last day. */
const LAST = new Date(now.getFullYear(), now.getMonth(), 0)
const money = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const days = (n: number): string => `${n} ${n === 1 ? 'day' : 'days'}`
const dias = (n: number): string => `${n} ${n === 1 ? 'día' : 'días'}`

const id = (n: number): string => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const CARD_A = '6f9619ff-8b86-4011-b42d-00cf4fc964ff'
const CARD_B = '7a1c3e55-0d2b-4f6e-9a8b-1c2d3e4f5a6b'
const cardA = card({ id: CARD_A, name: 'Visa A', last4: '1234', createdAt: '2026-01-01T09:00:00.000Z', updatedAt: '2026-01-01T09:00:00.000Z' })
const cardB = card({ id: CARD_B, name: 'Débito B', last4: '9876', kind: 'debit', createdAt: '2026-01-02T09:00:00.000Z', updatedAt: '2026-01-02T09:00:00.000Z' })

const OFFLINE_LINE = 'Your expenses load once this device is online.'

const pace = (page: Page) => page.locator('.spend-pace-card')

test('the daily average says the days it is over and where the month is heading; an expense dated ahead is in the total and the projection, never the average; a past month says its days and projects nothing', async ({ page }) => {
  // DAY × $10 today: the average is $10.00 to the cent. $100 on the month's last day (when that is still to come) is
  // in the total and the projection as it stands, not in the average. Last month: 2 × its days on its 1st.
  const ahead = DAY < DAYS ? 100 : 0
  const rows = [
    expense({ id: id(1), date: TODAY, amount: DAY * 10, cardId: CARD_A, category: 'groceries', merchant: 'Metro' }),
    expense({ id: id(3), date: dateOf(new Date(LAST.getFullYear(), LAST.getMonth(), 1)), amount: LAST.getDate() * 2, category: 'food', merchant: 'Cena' })
  ]
  if (ahead) rows.push(expense({ id: id(2), date: dateOf(new Date(now.getFullYear(), now.getMonth(), DAYS)), amount: ahead, category: 'home', merchant: 'Rent' }))
  await boot(page, { view: 'expenses', cards: [cardA], expenses: rows, budgets: [], settings: {} })

  await expect(page.locator('.spend-total')).toHaveText(money(DAY * 10 + ahead))
  await expect(pace(page).locator('.spend-pace')).toHaveText('$10.00')
  const sub = pace(page).locator('.spend-pace-sub')
  await expect(sub.locator('> span')).toHaveText([days(DAY), `on pace for ${money(10 * DAYS + ahead)}`])
  // What the average is of, for whoever hovers: the net through today.
  await expect(sub).toHaveAttribute('title', `Through ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}: ${money(DAY * 10)}`)
  // The projection is in this line only: the figures above say what was actually spent.
  await expect(page.locator('.spend-total-card')).not.toContainText('on pace')

  // In Spanish.
  await menu(page, '.lang-btn')
  await expect(sub.locator('> span')).toHaveText([dias(DAY), `a este ritmo, ${money(10 * DAYS + ahead)}`])
  await expect(pace(page).locator('.stat-label')).toHaveText('Media diaria')
  await page.keyboard.press('Escape')
  await menu(page, '.lang-btn')
  await page.keyboard.press('Escape')

  // Last month, whole: the average over all its days, and nothing projected.
  await page.locator('.exp-month-nav .nav-btn').first().click()
  await expect(page.locator('.spend-total')).toHaveText(money(LAST.getDate() * 2))
  await expect(pace(page).locator('.spend-pace')).toHaveText('$2.00')
  await expect(sub).toHaveText(`Over ${days(LAST.getDate())}`)
  await expect(sub).toHaveAttribute('title', `In ${LAST.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}: ${money(LAST.getDate() * 2)}`)
  await expect(sub).not.toContainText('on pace')

  // Next month has not started: nothing to average.
  await page.locator('.exp-today').click()
  await page.locator('.exp-month-nav .nav-btn').nth(1).click()
  await expect(pace(page).locator('.spend-pace')).toHaveText('—')
  await expect(sub).toHaveText('This month hasn’t started')
  expect(await sub.getAttribute('title')).toBeNull()
  // An empty month that isn't the first run: the categories and the budgets are one quiet line each, not a well; the
  // chart keeps its empty state (it holds the row's height).
  await expect(page.locator('.spend-cats-empty')).toHaveText('Nothing to break down yet.')
  expect((await page.locator('.spend-cats-empty').boundingBox())?.height).toBeLessThan(40)
  await expect(page.locator('.budgets-card.is-compact .budget-empty')).toHaveText('No budget set')
  expect((await page.locator('.budget-empty').boundingBox())?.height).toBeLessThan(40)
  expect((await page.locator('.spend-chart-card .chart-empty').boundingBox())?.height).toBeGreaterThanOrEqual(200)
})

test('before the expenses have loaded nothing reads as a zero: dashes and the reason, offline and while loading', async ({ page }) => {
  // Offline, on a device that never loaded its expenses.
  await boot(page, { view: 'expenses', expenses: null })
  const strip = page.locator('.spend-strip')
  await expect(page.locator('.spend-total')).toHaveText('—')
  await expect(page.locator('.spend-budget-card .life-value')).toHaveText('—')
  await expect(pace(page).locator('.spend-pace')).toHaveText('—')
  await expect(strip).not.toContainText('$')
  // The reason once in the strip (under the total), in the chart's well and in the list; a dash everywhere else.
  await expect(page.locator('.spend-total-card .stat-sub')).toHaveText(OFFLINE_LINE)
  await expect(strip.getByText(OFFLINE_LINE)).toHaveCount(1)
  await expect(page.locator('.spend-budget-card .stat-sub')).toHaveCount(0)
  await expect(page.locator('.spend-cards-card .stat-sub')).toHaveText('—')
  await expect(pace(page).locator('.stat-sub')).toHaveCount(0)
  await expect(page.locator('.spend-chart-card .chart-empty')).toHaveText(OFFLINE_LINE)
  await expect(page.locator('.spend-chart-card .recharts-wrapper')).toHaveCount(0)
  await expect(page.locator('.budgets-card.is-compact .budget-empty')).toHaveText('—')
  await expect(page.locator('.spend-cats-card .spend-cats-empty')).toHaveText('—')
  await expect(page.locator('.expense-list-card .exp-empty')).toHaveText(OFFLINE_LINE)
  await expect(page.locator('.expenses-view').getByText(OFFLINE_LINE)).toHaveCount(3)
  await expect(page.locator('.expenses-view')).not.toContainText('0.00')
})

test('while the first load is on its way the strip says so, with no figure; loaded, the account turns out empty and the first steps take over', async ({ page }) => {
  await boot(page, { backend: 'live', view: 'expenses', expenses: null, latencyMs: 1500 })
  await expect(page.locator('.spend-total')).toHaveText('—')
  await expect(page.locator('.spend-budget-card .life-value')).toHaveText('—')
  await expect(pace(page).locator('.spend-pace')).toHaveText('—')
  await expect(page.locator('.spend-total-card .stat-sub')).toHaveText('Loading your expenses…')
  await expect(page.locator('.spend-chart-card .chart-empty')).toHaveText('Loading your expenses…')
  await expect(page.locator('.budgets-card.is-compact .budget-empty')).toHaveText('—')
  await expect(page.locator('.spend-cats-card .spend-cats-empty')).toHaveText('—')
  await expect(page.locator('.expenses-view')).not.toContainText('$')
  // Loaded: nothing at all on the account, so the first-run card, never a strip of zeros.
  await expect(page.locator('.exp-first')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.spend-strip')).toHaveCount(0)
})

test('"+n more" under By card is a button: it lists every card, largest first', async ({ page }) => {
  const five = Array.from({ length: 5 }, (_, i) => card({ id: `4000000${i + 1}-0000-4000-8000-00000000000${i + 1}`, name: `Card ${i + 1}`, createdAt: `2026-01-0${i + 1}T09:00:00.000Z`, updatedAt: `2026-01-0${i + 1}T09:00:00.000Z` }))
  // Card 1 spent the most, Card 5 the least; the fourth and fifth are behind the button.
  const rows = five.map((c, i) => expense({ id: id(i + 1), date: TODAY, amount: 50 - i * 10, cardId: c.id, category: 'shopping', merchant: `Shop ${i + 1}` }))
  await boot(page, { view: 'expenses', cards: five, expenses: rows, budgets: [], settings: {} })
  const names = page.locator('.spend-card-item .spend-card-name')
  await expect(names).toHaveText(['Card 1', 'Card 2', 'Card 3'])
  const more = page.locator('.spend-card-more')
  await expect(more).toHaveText('+2 more')
  await expect(more).toHaveRole('button')
  await more.click()
  await expect(names).toHaveText(['Card 1', 'Card 2', 'Card 3', 'Card 4', 'Card 5'])
  await expect(page.locator('.spend-card-item .spend-card-amount')).toHaveText(['$50.00', '$40.00', '$30.00', '$20.00', '$10.00'])
  await expect(more).toHaveCount(0)
  // The lines still show their card's expenses.
  await page.locator('.spend-card-item', { hasText: 'Card 5' }).locator('.drill').click()
  await expect(page.locator('.exp-active-chip .exp-active-name')).toHaveText(['Card 5'])
})

test('on a 390px phone "+n more" is a finger tall, in Spanish too', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('bettracker:lang', 'es'))
  const four = Array.from({ length: 4 }, (_, i) => card({ id: `4000000${i + 1}-0000-4000-8000-00000000000${i + 1}`, name: `Tarjeta ${i + 1}`, createdAt: `2026-01-0${i + 1}T09:00:00.000Z`, updatedAt: `2026-01-0${i + 1}T09:00:00.000Z` }))
  const rows = four.map((c, i) => expense({ id: id(i + 1), date: TODAY, amount: 40 - i * 10, cardId: c.id, category: 'shopping', merchant: `Tienda ${i + 1}` }))
  await boot(page, { view: 'expenses', cards: four, expenses: rows, budgets: [], settings: {} })
  const more = page.locator('.spend-card-more')
  await expect(more).toHaveText('+1 más')
  expect((await more.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await more.click()
  await expect(page.locator('.spend-card-item .spend-card-name')).toHaveText(['Tarjeta 1', 'Tarjeta 2', 'Tarjeta 3', 'Tarjeta 4'])
})

test('with no budgets the panel is one line and "Set one", which opens the budgets; with one, each budget reads name, then spent of limit · left, with its bar', async ({ page }) => {
  await boot(page, {
    backend: 'live',
    view: 'expenses',
    cards: [cardA],
    expenses: [expense({ id: id(1), date: TODAY, amount: 85, cardId: CARD_A, category: 'food', merchant: 'Cena' }), expense({ id: id(2), date: TODAY, amount: 4.5, category: 'coffee', merchant: 'Café' })],
    budgets: []
  })
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  const panel = page.locator('.budgets-card')
  await expect(panel).toHaveClass(/is-compact/)
  await expect(panel.locator('.budget-empty')).toHaveText('No budget set')
  const set = panel.locator('.budget-edit-btn')
  await expect(set).toHaveText('Set one')
  // As tall as its line, not as the chart beside it.
  const [panelBox, chartBox] = await Promise.all([panel.boundingBox(), page.locator('.spend-chart-card').boundingBox()])
  if (!panelBox || !chartBox) throw new Error('no boxes')
  expect(panelBox.height).toBeLessThan(120)
  expect(panelBox.height).toBeLessThan(chartBox.height / 2)
  // The tile says the same.
  await expect(page.locator('.spend-budget-card .life-value')).toHaveText('—')
  await expect(page.locator('.spend-budget-card .stat-sub')).toHaveText('Set a monthly budget')

  // In Spanish.
  await menu(page, '.lang-btn')
  await expect(panel.locator('.budget-empty')).toHaveText('Sin presupuesto')
  await expect(set).toHaveText('Ponerlo')
  await page.keyboard.press('Escape')
  await menu(page, '.lang-btn')
  await page.keyboard.press('Escape')

  // Set one: Expense settings opens at the budgets, the total's box ready to type.
  await set.click()
  const settings = page.locator('.expense-settings-modal')
  const total = settings.locator('.budget-input[data-scope="total"][data-target=""]')
  await expect(total).toBeFocused()
  await total.fill('100')
  await total.press('Enter')
  await settings.locator('.expset-done').click()
  await expect(settings).toHaveCount(0)

  // 89.50 of 100: two lines (the name, then the figures) and the bar; near the limit, said in words too.
  await expect(panel).not.toHaveClass(/is-compact/)
  await expect(set).toHaveText('Edit budgets')
  const row = panel.locator('.budget-row.budget-total')
  await expect(row).toHaveClass(/is-near/)
  await expect(row.locator('.budget-name')).toHaveText('Monthly total')
  await expect(row.locator('.budget-figures > span')).toHaveText(['$89.50 of $100.00', '$10.50 left · near the limit'])
  await expect(row.locator('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '90')
  const [nameBox, figuresBox, barBox] = await Promise.all([row.locator('.budget-name').boundingBox(), row.locator('.budget-figures').boundingBox(), row.locator('.bd-bar').boundingBox()])
  if (!nameBox || !figuresBox || !barBox) throw new Error('no boxes')
  expect(figuresBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 1)
  expect(barBox.y).toBeGreaterThanOrEqual(figuresBox.y + figuresBox.height - 1)
  // The bar's amber and the words agree with the tile.
  await expect(page.locator('.spend-budget-card .life-value.near')).toHaveText('$10.50')

  // Over: red, and "over" in the figures line.
  await set.click()
  await total.fill('80')
  await total.press('Enter')
  await settings.locator('.expset-done').click()
  await expect(row).toHaveClass(/is-over/)
  await expect(row.locator('.budget-figures > span')).toHaveText(['$89.50 of $80.00', '$9.50 over · over budget'])
  // The words take the red the bar has; the name stays in ink.
  await expect(row.locator('.budget-left')).toHaveCSS('color', await row.locator('.bd-fill').evaluate((el) => getComputedStyle(el).backgroundColor))
  await expect(row.locator('.budget-name')).toHaveCSS('color', await panel.locator('h2').evaluate((el) => getComputedStyle(el).color))
})

for (const width of [390, 320]) {
  test(`at ${width}px the strip is two columns: the total across, Budget left and Daily average side by side, By card across; nothing sideways, every figure on its line`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await boot(page, {
      view: 'expenses',
      cards: [cardA, cardB],
      expenses: [
        expense({ id: id(1), date: TODAY, amount: 12345.67, cardId: CARD_A, category: 'travel', merchant: 'Flights' }),
        expense({ id: id(2), date: TODAY, amount: 200, cardId: CARD_B, category: 'food', merchant: 'Cena' })
      ],
      budgets: [budget({ scope: 'total', monthlyLimit: 20000 })],
      settings: {}
    })
    await expect(page.locator('.spend-total')).toHaveText('$12,545.67')
    await expect(page.locator('.spend-budget-card .life-value')).toHaveText('$7,454.33')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    expect(await page.locator('.expenses-view').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)

    const box = async (sel: string) => {
      const b = await page.locator(sel).boundingBox()
      if (!b) throw new Error(`no box for ${sel}`)
      return b
    }
    const [strip, total, budgetTile, cards, paceTile] = await Promise.all([box('.spend-strip'), box('.spend-total-card'), box('.spend-budget-card'), box('.spend-cards-card'), box('.spend-pace-card')])
    for (const tile of ['.spend-total-card', '.spend-budget-card', '.spend-cards-card', '.spend-pace-card']) await expect(page.locator(tile)).toBeVisible()
    // Full width: the total and By card. Halves, on one row: Budget left and Daily average.
    expect(Math.abs(total.width - strip.width)).toBeLessThanOrEqual(2)
    expect(Math.abs(cards.width - strip.width)).toBeLessThanOrEqual(2)
    expect(Math.abs(budgetTile.y - paceTile.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(budgetTile.width - strip.width / 2)).toBeLessThanOrEqual(2)
    expect(Math.abs(paceTile.width - strip.width / 2)).toBeLessThanOrEqual(2)
    expect(paceTile.x).toBeGreaterThanOrEqual(budgetTile.x + budgetTile.width - 1)
    // Under the two, By card; above them, the total.
    expect(budgetTile.y).toBeGreaterThanOrEqual(total.y + total.height - 1)
    expect(cards.y).toBeGreaterThanOrEqual(budgetTile.y + budgetTile.height - 1)
    // Every figure fits its tile on one line.
    for (const value of await page.locator('.spend-strip .life-value').all()) {
      expect(await value.evaluate((el) => el.scrollWidth <= el.clientWidth && el.getClientRects().length === 1)).toBe(true)
    }
    // Nothing moves at rest.
    await page.waitForFunction(() => document.getAnimations().length === 0)
  })
}

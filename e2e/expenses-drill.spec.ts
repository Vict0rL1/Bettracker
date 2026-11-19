import { expect, test, type Locator, type Page } from '@playwright/test'
import { boot, budget, card, expense } from './harness'

/**
 * The Expenses view's lines that name a card or a category (By card, the
 * budgets, By category): tapped, each shows its expenses: the list is
 * narrowed to exactly that card or that category for the month (the search
 * and the other kind of filter cleared), comes to the top of the window and
 * takes the focus, and says so in a quiet line with Show all. And the chart:
 * no tooltip and no cursor for a day still to come.
 */

const pad = (n: number): string => String(n).padStart(2, '0')
const TODAY = ((d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)(new Date())

const CARD_A = '6f9619ff-8b86-4011-b42d-00cf4fc964ff'
const CARD_B = '7a1c3e55-0d2b-4f6e-9a8b-1c2d3e4f5a6b'
const cardA = card({ id: CARD_A, name: 'Visa A', last4: '1234', createdAt: '2026-01-01T09:00:00.000Z', updatedAt: '2026-01-01T09:00:00.000Z' })
const cardB = card({ id: CARD_B, name: 'Débito B', last4: '9876', kind: 'debit', createdAt: '2026-01-02T09:00:00.000Z', updatedAt: '2026-01-02T09:00:00.000Z' })
const id = (n: number): string => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** Every row dated today (on the 1st, "yesterday" is last month). Visa A: 3 rows, $21.25 net; groceries: 2 rows, $19.75. */
const EXPENSES = [
  expense({ id: id(1), date: TODAY, amount: 20, cardId: CARD_A, category: 'coffee', merchant: 'Café Central' }),
  expense({ id: id(2), date: TODAY, amount: 15.5, cardId: CARD_B, category: 'groceries', merchant: 'Metro' }),
  expense({ id: id(3), date: TODAY, amount: 4.25, cardId: CARD_A, category: 'groceries', merchant: 'IGA' }),
  expense({ id: id(4), date: TODAY, amount: 9, category: 'transport', merchant: 'Uber' }),
  expense({ id: id(5), date: TODAY, amount: -3, cardId: CARD_A, category: 'coffee', merchant: 'Café refund' })
]
const BUDGETS = [budget({ scope: 'total', monthlyLimit: 500 }), budget({ scope: 'card', target: CARD_A, monthlyLimit: 300 }), budget({ scope: 'category', target: 'groceries', monthlyLimit: 100 })]

async function open(page: Page): Promise<void> {
  // What the view asks of the scroll, to check its options (smooth, or at once with reduced motion).
  await page.addInitScript(() => {
    const calls: unknown[] = []
    ;(window as unknown as { __scrolls: unknown[] }).__scrolls = calls
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
      if (this.classList.contains('expense-list-card')) calls.push(arg)
      return original.call(this, arg)
    }
  })
  await boot(page, { view: 'expenses', cards: [cardA, cardB], expenses: EXPENSES, budgets: BUDGETS, settings: {} })
}

const list = (page: Page): Locator => page.locator('.expense-list-card')
const merchants = (page: Page) => list(page).locator('.exp-row .exp-merchant-text')

/**
 * The scroll comes to rest with the list card's top 12px under the window's top (nothing fixed covers it), or, when
 * the page is too short for that, with the page at its end and the card below that line.
 */
async function expectListAtTop(page: Page): Promise<void> {
  let lastY = NaN
  await expect
    .poll(
      async () => {
        const s = await page.evaluate(() => {
          const top = (document.querySelector('.expense-list-card') as HTMLElement).getBoundingClientRect().top
          const atEnd = Math.abs(window.scrollY - (document.documentElement.scrollHeight - window.innerHeight)) <= 1
          return { y: Math.round(window.scrollY), top, atEnd }
        })
        const there = Math.abs(s.top - 12) <= 1 || (s.atEnd && s.top > 12)
        const still = s.y === lastY
        lastY = s.y
        return there && still
      },
      { intervals: [120], timeout: 5000 }
    )
    .toBe(true)
}

/** The list shows exactly these merchants, the boxes and the chip agree, and the line sums them up. */
async function expectShowing(page: Page, o: { merchants: string[]; card: string; category: string; chips: string[]; sum: [string, string] | null }): Promise<void> {
  await expect(merchants(page)).toHaveText(o.merchants)
  await expect(page.locator('.exp-filter-card')).toHaveValue(o.card)
  await expect(page.locator('.exp-filter-cat')).toHaveValue(o.category)
  await expect(page.locator('.exp-search')).toHaveValue('')
  await expect(page.locator('.exp-active-chip .exp-active-name')).toHaveText(o.chips)
  if (o.sum === null) await expect(page.locator('.exp-active')).toHaveCount(0)
  else await expect(page.locator('.exp-active-sum > span')).toHaveText(o.sum)
}

const ALL = ['Café refund', 'Uber', 'IGA', 'Metro', 'Café Central']

test('a card in By card, a card’s budget, a category and a category’s budget each show just their expenses; the chip and the boxes agree; Show all and the chip’s × undo it', async ({ page }) => {
  await open(page)
  await expect(merchants(page)).toHaveText(ALL)
  await expect(page.locator('.exp-active')).toHaveCount(0)

  // Each line is a button named for what it shows; its figures stay plain text beside it.
  await expect(page.getByRole('button', { name: 'Show Visa A’s expenses' })).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Show Débito B’s expenses' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Show the expenses with no card' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Show the expenses in Groceries' })).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Monthly total: show all the expenses' })).toHaveCount(1)
  await expect(page.locator('.budget-row.budget-card [role="progressbar"]')).toHaveCount(1)

  // Whatever the list showed before (a search, another category), By card's Visa A shows Visa A's, and only them.
  await page.locator('.exp-search').fill('metro')
  await page.locator('.exp-filter-cat').selectOption('groceries')
  await expect(merchants(page)).toHaveText(['Metro'])
  await page.locator('.spend-card-item', { hasText: 'Visa A' }).locator('.drill').click()
  await expectShowing(page, { merchants: ['Café refund', 'IGA', 'Café Central'], card: CARD_A, category: 'all', chips: ['Visa A'], sum: ['3 expenses', '$21.25'] })
  await expect(page.locator('.exp-list-title')).toBeFocused()
  await expect(page.locator('.exp-list-title')).toHaveText(/^Expenses .+, filtered by Visa A: 3 expenses, \$21\.25$/)
  await expectListAtTop(page)
  // The line the list shows reads as current, in By card and in the budgets; nothing else does.
  await expect(page.locator('.drill[aria-current="true"]')).toHaveCount(2)
  await expect(page.locator('.spend-card-item', { hasText: 'Visa A' }).locator('.drill')).toHaveAttribute('aria-current', 'true')
  await expect(page.locator('.budget-row.budget-card .drill')).toHaveAttribute('aria-current', 'true')

  // Show all: everything again, the focus kept on the list.
  await page.locator('.exp-show-all').click()
  await expectShowing(page, { merchants: ALL, card: 'all', category: 'all', chips: [], sum: null })
  await expect(page.locator('.exp-list-title')).toBeFocused()
  await expect(page.locator('.exp-list-title')).toHaveText(/^Expenses [^,]+$/)
  await expect(page.locator('.drill[aria-current="true"]')).toHaveCount(0)

  // A category's line.
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.locator('.exp-filter-card').selectOption(CARD_B)
  await page.locator('.spend-cat-row[data-cat="groceries"] .drill').click()
  await expectShowing(page, { merchants: ['IGA', 'Metro'], card: 'all', category: 'groceries', chips: ['Groceries'], sum: ['2 expenses', '$19.75'] })
  await expectListAtTop(page)
  await expect(page.locator('.spend-cat-row[data-cat="groceries"] .drill')).toHaveAttribute('aria-current', 'true')
  await expect(page.locator('.budget-row.budget-category .drill')).toHaveAttribute('aria-current', 'true')

  // A card's budget line: the category goes, the card comes.
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.locator('.budget-row.budget-card .drill').click()
  await expectShowing(page, { merchants: ['Café refund', 'IGA', 'Café Central'], card: CARD_A, category: 'all', chips: ['Visa A'], sum: ['3 expenses', '$21.25'] })
  await expect(page.locator('.exp-list-title')).toBeFocused()

  // A category's budget line, after a search and a second box: the same, just groceries.
  await page.locator('.exp-filter-cat').selectOption('coffee')
  await page.locator('.exp-search').fill('caf')
  await expect(merchants(page)).toHaveText(['Café refund', 'Café Central'])
  await page.locator('.budget-row.budget-category .drill').click()
  await expectShowing(page, { merchants: ['IGA', 'Metro'], card: 'all', category: 'groceries', chips: ['Groceries'], sum: ['2 expenses', '$19.75'] })

  // "No card" in By card.
  await page.locator('.spend-card-item', { hasText: 'No card' }).locator('.drill').click()
  await expectShowing(page, { merchants: ['Uber'], card: 'none', category: 'all', chips: ['No card'], sum: ['1 expense', '$9.00'] })

  // The monthly total shows the whole month.
  await page.locator('.budget-row.budget-total .drill').click()
  await expectShowing(page, { merchants: ALL, card: 'all', category: 'all', chips: [], sum: null })
  await expect(page.locator('.exp-list-title')).toBeFocused()

  // Two chips from the boxes: the card's × takes the card off and leaves the focus on Show all; the last × on the heading.
  await page.locator('.exp-filter-card').selectOption(CARD_A)
  await page.locator('.exp-filter-cat').selectOption('coffee')
  await expect(page.locator('.exp-active-chip .exp-active-name')).toHaveText(['Visa A', 'Coffee'])
  await expect(page.locator('.exp-active-sum > span')).toHaveText(['2 expenses', '$17.00'])
  await expect(page.locator('.exp-active-card')).toHaveAccessibleName('Remove the filter: Visa A')
  await page.locator('.exp-active-card').click()
  await expectShowing(page, { merchants: ['Café refund', 'Café Central'], card: 'all', category: 'coffee', chips: ['Coffee'], sum: ['2 expenses', '$17.00'] })
  await expect(page.locator('.exp-show-all')).toBeFocused()
  await page.locator('.exp-active-cat').click()
  await expectShowing(page, { merchants: ALL, card: 'all', category: 'all', chips: [], sum: null })
  await expect(page.locator('.exp-list-title')).toBeFocused()

  // A filter with nothing in it says so, and keeps its chip and Show all; no count of nothing.
  await page.locator('.exp-filter-card').selectOption(CARD_B)
  await page.locator('.exp-filter-cat').selectOption('transport')
  await expect(list(page).locator('.exp-empty')).toHaveText('No expenses match.')
  await expect(page.locator('.exp-active-sum')).toHaveCount(0)
  await expect(page.locator('.exp-show-all')).toBeVisible()

  // Smooth, to the card's top; and nothing animates once it is there.
  const scrolls = await page.evaluate(() => (window as unknown as { __scrolls: unknown[] }).__scrolls)
  expect(scrolls.length).toBe(6)
  for (const s of scrolls) expect(s).toEqual({ behavior: 'smooth', block: 'start' })
  expect(await list(page).evaluate((el) => getComputedStyle(el).scrollMarginTop)).toBe('12px')
  await page.waitForFunction(() => document.getAnimations().length === 0)
})

test('the keyboard: Enter and Space on a line show its expenses and land on the list; with reduced motion it comes at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await open(page)

  await page.locator('.spend-card-item', { hasText: 'Débito B' }).locator('.drill').focus()
  await page.keyboard.press('Enter')
  await expectShowing(page, { merchants: ['Metro'], card: CARD_B, category: 'all', chips: ['Débito B'], sum: ['1 expense', '$15.50'] })
  await expect(page.locator('.exp-list-title')).toBeFocused()
  // Keyboard focus shows: a ring on the heading it landed on.
  expect(await page.locator('.exp-list-title').evaluate((el) => el.matches(':focus-visible'))).toBe(true)
  await expectListAtTop(page)

  await page.locator('.spend-cat-row[data-cat="transport"] .drill').focus()
  expect(await page.locator('.spend-cat-row[data-cat="transport"] .drill').evaluate((el) => getComputedStyle(el, '::after').outlineStyle)).toBe('solid')
  await page.keyboard.press(' ')
  await expectShowing(page, { merchants: ['Uber'], card: 'all', category: 'transport', chips: ['Transport'], sum: ['1 expense', '$9.00'] })
  await expect(page.locator('.exp-list-title')).toBeFocused()

  // From the heading, Tab goes on through the list: Export, the search, the boxes, the chip, Show all.
  await page.keyboard.press('Tab')
  await expect(page.locator('.exp-export-btn')).toBeFocused()
  for (const next of ['.exp-search', '.exp-filter-card', '.exp-filter-cat', '.exp-active-cat', '.exp-show-all']) {
    await page.keyboard.press('Tab')
    await expect(page.locator(next)).toBeFocused()
  }
  await page.keyboard.press('Enter')
  await expectShowing(page, { merchants: ALL, card: 'all', category: 'all', chips: [], sum: null })

  const scrolls = await page.evaluate(() => (window as unknown as { __scrolls: unknown[] }).__scrolls)
  expect(scrolls).toEqual([
    { behavior: 'auto', block: 'start' },
    { behavior: 'auto', block: 'start' }
  ])
})

test('in Spanish, and on a 390px phone: each card’s line a finger tall, the chips a finger to the touch, nothing sideways', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bettracker:lang', 'es'))
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)

  await expect(page.getByRole('button', { name: 'Ver los gastos de Visa A' })).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Ver los gastos sin tarjeta' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Ver los gastos de Supermercado' })).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Total del mes: ver todos los gastos' })).toHaveCount(1)
  for (const box of await page.locator('.spend-card-item').all()) expect((await box.boundingBox())?.height).toBeGreaterThanOrEqual(44)

  // A tap anywhere on the line counts, on its amount too (the button's ::after covers the line).
  const amount = await page.locator('.spend-card-item', { hasText: 'Visa A' }).locator('.spend-card-amount').boundingBox()
  if (!amount) throw new Error('no amount')
  await page.mouse.click(amount.x + amount.width / 2, amount.y + amount.height / 2)
  await expect(page.locator('.exp-item .exp-item-merchant')).toHaveText(['Café refund', 'IGA', 'Café Central'])
  await expect(page.locator('.exp-active-chip')).toHaveAccessibleName('Quitar el filtro: Visa A')
  await expect(page.locator('.exp-active-sum > span')).toHaveText(['3 gastos', '$21.25'])
  await expect(page.locator('.exp-show-all')).toHaveText('Ver todo')
  await expect(page.locator('.exp-list-title')).toHaveText(/, filtrados por Visa A: 3 gastos, \$21\.25$/)
  await expectListAtTop(page)

  // 44px to the touch: 22px above and below the chip's and Show all's middles still hit them.
  for (const sel of ['.exp-active-chip', '.exp-show-all']) {
    const box = await page.locator(sel).boundingBox()
    if (!box) throw new Error(`no ${sel}`)
    for (const dy of [-21, 21]) {
      const hit = await page.evaluate(({ x, y, s }) => Boolean(document.elementFromPoint(x, y)?.closest(s)), { x: box.x + box.width / 2, y: box.y + box.height / 2 + dy, s: sel })
      expect(hit, `${sel} at ${dy}`).toBe(true)
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  await page.locator('.exp-show-all').click()
  await expect(page.locator('.exp-item')).toHaveCount(5)
})

test.describe('the chart', () => {
  // Today is the 17th of a 30-day month: the 18th to the 30th are still to come.
  const DAY = (d: number): string => `2026-11-${pad(d)}`
  const CHART_EXPENSES = [
    expense({ id: id(11), date: DAY(3), amount: 40, cardId: CARD_A, category: 'groceries' }),
    expense({ id: id(12), date: DAY(10), amount: 25, cardId: CARD_B, category: 'food' }),
    expense({ id: id(13), date: DAY(17), amount: 12, cardId: CARD_A, category: 'coffee' }),
    // Logged ahead: its day has something to say in the per-day view.
    expense({ id: id(14), date: DAY(27), amount: 30, cardId: CARD_B, category: 'subscriptions' })
  ]

  async function openChart(page: Page): Promise<{ at: (day: number, daily: boolean) => { x: number; y: number } }> {
    await page.clock.setFixedTime(new Date(2026, 10, 17, 12, 0, 0))
    await boot(page, { view: 'expenses', cards: [cardA, cardB], expenses: CHART_EXPENSES, budgets: [budget({ scope: 'total', monthlyLimit: 500 })], settings: {} })
    const grid = page.locator('.spend-chart-card .recharts-cartesian-grid')
    await grid.scrollIntoViewIfNeeded()
    const box = await grid.boundingBox()
    if (!box) throw new Error('no plot')
    // The x axis: days 0.5–30.5 per day (each day's bar centred on its slot), 1–30 for the running total.
    return { at: (day, daily) => ({ x: box.x + (daily ? (day - 0.5) / 30 : (day - 1) / 29) * box.width, y: box.y + box.height * 0.6 }) }
  }

  const tip = (page: Page) => page.locator('.spend-chart-card .spend-tip')
  const cursor = (page: Page) => page.locator('.spend-chart-card .recharts-tooltip-cursor')

  test('a day still to come has no tooltip and no cursor, in both views; a past day (even one with nothing spent) has both, and the cursor is quiet', async ({ page }) => {
    const { at } = await openChart(page)
    const chart = page.locator('.spend-chart-card')

    for (const daily of [false, true]) {
      if (daily) await chart.locator('.spend-chart-view .scope-btn', { hasText: 'Per day' }).click()
      const hover = async (day: number) => {
        const p = at(day, daily)
        await page.mouse.move(p.x, p.y)
      }
      await hover(10)
      await expect(tip(page)).toBeVisible()
      await expect(tip(page).locator('.tip-sub')).toHaveText('Nov 10')
      await expect(cursor(page)).toHaveCount(1)
      // Per day, a faint band over the day; running total, a hairline. Never Recharts' default #ccc line.
      expect(await cursor(page).evaluate((el) => el.tagName)).toBe(daily ? 'rect' : 'line')
      expect(await cursor(page).evaluate((el) => [el.getAttribute('stroke'), el.getAttribute('fill')])).toEqual(daily ? [null, 'var(--tint-2)'] : ['var(--grid-strong)', null])

      // A past day with nothing on it still says $0.00 per day (and the running total so far).
      await hover(12)
      await expect(tip(page).locator('.tip-value')).toHaveText(daily ? 'Total $0.00' : 'Total $65.00')

      // Today has its tooltip; tomorrow, and the end of the month, have nothing.
      await hover(17)
      await expect(tip(page).locator('.tip-sub')).toHaveText('Nov 17')
      for (const day of [18, 24, 30]) {
        await hover(day)
        await expect(tip(page), `day ${day}, ${daily ? 'per day' : 'running total'}`).toHaveCount(0)
        await expect(cursor(page)).toHaveCount(0)
      }

      // An expense logged ahead: its day speaks per day, never in the running total (the month hasn't got there).
      await hover(27)
      if (daily) {
        await expect(tip(page).locator('.tip-value')).toHaveText('Total $30.00')
        await expect(cursor(page)).toHaveCount(1)
      } else {
        await expect(tip(page)).toHaveCount(0)
        await expect(cursor(page)).toHaveCount(0)
      }
    }
    await page.mouse.move(0, 0)

    // The keyboard still gets the app's ring on the drawing (Recharts' arrow keys move along the days).
    await chart.locator('.spend-chart-view .scope-btn', { hasText: 'Per day' }).focus()
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => [document.activeElement?.getAttribute('class'), getComputedStyle(document.activeElement as Element).outlineStyle])).toEqual(['recharts-surface', 'solid'])
  })

  test.describe('on a touch screen', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

    test('a tap on a day still to come shows nothing; a tap on a past day shows its tooltip; no ring is left round what was tapped', async ({ page }) => {
      const { at } = await openChart(page)
      await page.locator('.spend-chart-card .spend-chart-view .scope-btn', { hasText: 'Per day' }).click()
      const tap = async (day: number) => {
        const p = at(day, true)
        await page.touchscreen.tap(p.x, p.y)
      }
      // A tap focuses one of Recharts' layers (a <g tabindex="-1">) or its surface: never with the browser's ring round it.
      const ring = () => page.evaluate(() => (document.activeElement?.closest('.spend-chart-card') ? getComputedStyle(document.activeElement).outlineStyle : 'none'))
      await tap(3)
      await expect(tip(page).locator('.tip-sub')).toHaveText('Nov 3')
      await expect(cursor(page)).toHaveCount(1)
      expect(await ring()).toBe('none')
      await tap(24)
      await expect(tip(page)).toHaveCount(0)
      await expect(cursor(page)).toHaveCount(0)
      expect(await ring()).toBe('none')
    })
  })
})

import { expect, test, type Page } from '@playwright/test'
import { boot, card, entry, expense, menu, SEED } from './harness'

const pad = (n: number): string => String(n).padStart(2, '0')
const daysAgo = (n: number): string => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// What made a phone's page too wide: days with only open bets (the calendar
// wrote "ABIERTO" in each), four-digit amounts, long notes and tags.
const BUSY = [
  ...SEED,
  ...[1, 2, 3, 4].map((n) => entry({ id: `p${n}`, date: daysAgo(n), amount: 0, status: 'pending', stake: 25, odds: 2.5, sport: 'Fútbol', book: 'DraftKings', betType: 'Player prop' })),
  entry({ id: 'big', date: daysAgo(6), amount: -1000, stake: 1000, odds: 1.9, note: 'Parlay de tres patas con prórroga incluida, revisar el cierre', sport: 'NBA', book: 'Caesars' }),
  entry({ id: 'win', date: daysAgo(7), amount: 1234.5, stake: 500, odds: 3.47, sport: 'NFL', book: 'FanDuel' })
]
const SETTINGS = { startingBankroll: 1000, unitSize: 25, oddsFormat: 'american', lossLimit: 150 }

// Expenses: three cards with long names (the sheet's segmented picker, at its
// widest), a few expenses today and in the last September past (the longest
// month name in both languages), a refund among them.
const CARDS = [
  card({ id: '6f9619ff-8b86-4011-b42d-00cf4fc964ff', name: 'Tarjeta de crédito Banco del Pacífico', last4: '1234' }),
  card({ id: '7a1c3e55-0d2b-4f6e-9a8b-1c2d3e4f5a6b', name: 'Débito cuenta nómina Banco Pichincha', last4: '9876', kind: 'debit' }),
  card({ id: '8b2d4f66-1e3c-4a7f-8b9c-2d3e4f5a6b7c', name: 'Mastercard Black Viajes y Millas', last4: '5555' })
]
const SEPTEMBER = ((d: Date) => `${d.getMonth() + 1 > 9 ? d.getFullYear() : d.getFullYear() - 1}-09-15`)(new Date())
const EXPENSES = [
  expense({ id: '10000000-0000-4000-8000-000000000001', date: daysAgo(0), amount: 4.5, cardId: CARDS[0].id, category: 'coffee', merchant: 'Café Central' }),
  expense({ id: '10000000-0000-4000-8000-000000000002', date: daysAgo(0), amount: 1234.56, cardId: CARDS[1].id, category: 'groceries', merchant: 'Supermercado Internacional de Productos Frescos' }),
  expense({ id: '10000000-0000-4000-8000-000000000003', date: daysAgo(0), amount: -12, category: 'shopping', merchant: 'Devolución' }),
  expense({ id: '10000000-0000-4000-8000-000000000004', date: SEPTEMBER, amount: 89.9, cardId: CARDS[2].id, category: 'entertainment', merchant: 'Teatro Nacional Sucre, dos entradas', note: 'Con la familia' }),
  expense({ id: '10000000-0000-4000-8000-000000000005', date: SEPTEMBER, amount: 32.4, category: 'transport', merchant: 'Taxi aeropuerto' })
]

/** On a phone the history is a list of cards: open the first, then edit its bet. */
async function editFirstCard(page: Page): Promise<void> {
  const card = page.locator('.hcard').first()
  await card.locator('.hcard-toggle').click()
  await card.locator('.hcard-edit').click()
}

/** The page is as wide as the screen: nothing pushes it sideways. */
const overflow = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)

async function open(page: Page, lang: 'en' | 'es'): Promise<void> {
  await page.addInitScript((l) => localStorage.setItem('bettracker:lang', l), lang)
  await boot(page, { entries: BUSY, settings: SETTINGS, moves: [], cards: CARDS, expenses: EXPENSES, budgets: [] })
}

/** A dialog fits the phone: nothing pushes the page or the dialog sideways, and it is inside the screen. */
async function fits(page: Page, modal: string, width: number): Promise<void> {
  expect(await overflow(page), modal).toBeLessThanOrEqual(0)
  const box = await page.locator(modal).boundingBox()
  expect(box && box.x >= 0 && box.x + box.width <= width, `${modal} inside the screen`).toBe(true)
}

for (const width of [320, 390]) {
  for (const lang of ['es', 'en'] as const) {
    test(`at ${width}px in ${lang}, the dashboard and every dialog fit the phone`, async ({ page }) => {
      await page.setViewportSize({ width, height: 740 })
      await open(page, lang)
      expect(await overflow(page), 'dashboard').toBeLessThanOrEqual(0)

      const dialogs: [string, () => Promise<unknown>][] = [
        ['.quick-modal', () => page.click('.fab')],
        ['.settings-modal', () => menu(page, '.settings-btn')],
        ['.bank-modal', () => page.click('.bankroll-card')],
        ['.pending-modal', () => menu(page, '.pending-btn')],
        ['.day-modal', () => editFirstCard(page)]
      ]
      for (const [modal, show] of dialogs) {
        await show()
        await expect(page.locator(modal)).toBeVisible()
        await fits(page, modal, width)
        await page.keyboard.press('Escape')
        await expect(page.locator(modal)).toHaveCount(0)
      }

      // The Expenses view, on a past month with the longest name (the Today chip shows too).
      await page.locator('.view-tab-expenses').click()
      await page.waitForSelector('.expense-list-card')
      const title = page.locator('.exp-month-title')
      for (let i = 0; i < 12; i++) {
        await page.locator('.exp-month-nav .nav-btn').first().click()
        if (/septiembre|september/i.test((await title.textContent()) ?? '')) break
      }
      await expect(title).toHaveText(/septiembre|september/i)
      await expect(page.locator('.exp-today')).toBeVisible()
      await expect(page.locator('.expense-list-card')).toContainText('Teatro Nacional Sucre')
      expect(await overflow(page), 'expenses view').toBeLessThanOrEqual(0)

      const expenseDialogs: [string, () => Promise<unknown>][] = [
        ['.expense-modal', () => page.click('.fab')],
        ['.expense-settings-modal', () => page.click('.exp-manage-btn')]
      ]
      for (const [modal, show] of expenseDialogs) {
        await show()
        await expect(page.locator(modal)).toBeVisible()
        await fits(page, modal, width)
        expect(await page.locator(modal).evaluate((el) => el.scrollWidth <= el.clientWidth), `${modal}: nothing sideways inside`).toBe(true)
        await page.keyboard.press('Escape')
        await expect(page.locator(modal)).toHaveCount(0)
      }
    })
  }
}

test('signed out, the sign-in card fits a 320px phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto('/')
  await expect(page.locator('.auth-card')).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  const box = await page.locator('.auth-card').boundingBox()
  expect(box && box.x + box.width <= 320).toBe(true)
})

test('on a phone, no field is under 16px, so iOS does not zoom in on it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page, 'es')
  const small = (): Promise<string[]> =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('input, select, textarea'))
        .filter((el) => !(el instanceof HTMLInputElement && ['checkbox', 'radio', 'file', 'hidden'].includes(el.type)) && el.getBoundingClientRect().width > 0)
        .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
        .map((el) => el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? el.className)
    )
  expect(await small(), 'dashboard').toEqual([])
  await page.click('.fab')
  expect(await small(), 'quick add').toEqual([])
  await page.keyboard.press('Escape')
  await editFirstCard(page)
  expect(await small(), 'day').toEqual([])
  await page.keyboard.press('Escape')

  // The Expenses view, its sheet and its settings.
  await page.locator('.view-tab-expenses').click()
  await page.waitForSelector('.expense-list-card')
  expect(await small(), 'expenses').toEqual([])
  await page.click('.fab')
  await expect(page.locator('.expense-modal .exp-amount')).toBeVisible()
  expect(await small(), 'expense sheet').toEqual([])
  await page.keyboard.press('Escape')
  await page.click('.exp-manage-btn')
  const settings = page.locator('.expense-settings-modal')
  for (const box of ['.paycard-name-input', '.paycard-last4-input', '.budget-input', '.currency-select']) await expect(settings.locator(box).first()).toBeVisible()
  expect(await small(), 'expense settings').toEqual([])
})

test('at the bottom of the page, the + button leaves the history pager free to tap', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const many = Array.from({ length: 40 }, (_, i) => entry({ id: `m${i}`, date: daysAgo(i + 1), amount: i % 2 ? 10 : -10, stake: 10 }))
  await boot(page, { entries: many })
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const next = page.locator('.pager .nav-btn').last()
  const box = await next.boundingBox()
  if (!box) throw new Error('no pager')
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.pager .nav-btn, .fab')?.className ?? null, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
  expect(hit).toContain('nav-btn')
})

test('odds boxes ask for a keyboard that can type them: minus and slash for American and fractional, the pad for decimal', async ({ page }) => {
  await boot(page, { settings: { oddsFormat: 'american' } })
  await page.click('.add-bet-btn')
  await expect(page.locator('.quick-modal .quick-row input[type=text]')).toHaveAttribute('inputmode', 'text')
  await page.keyboard.press('Escape')
  await page.locator('.history-card tbody tr').first().locator('.td-actions .btn-icon').first().click()
  await expect(page.locator('.day-modal .odds-input').first()).toHaveAttribute('inputmode', 'text')
  await expect(page.locator('.day-modal .closing-input')).toHaveAttribute('inputmode', 'text')
})

test('with decimal odds the odds boxes get the number pad', async ({ page }) => {
  await boot(page, { settings: { oddsFormat: 'decimal' } })
  await page.click('.add-bet-btn')
  await expect(page.locator('.quick-modal .quick-row input[type=text]')).toHaveAttribute('inputmode', 'decimal')
})

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 664 } })

  test('the day dialog opens at its top, without focusing the stake (no keyboard, no jump)', async ({ page }) => {
    await boot(page, { entries: BUSY })
    const card = page.locator('.hcard').first()
    await card.locator('.hcard-toggle').click()
    await card.locator('.hcard-day').click()
    const modal = page.locator('.day-modal')
    await expect(modal).toBeVisible()
    expect(await modal.evaluate((m) => m.scrollTop)).toBe(0)
    expect(await page.evaluate(() => document.activeElement?.classList.contains('day-modal'))).toBe(true)
  })

  test('editing one bet opens its form in view, still without the keyboard', async ({ page }) => {
    await boot(page, { entries: BUSY })
    await editFirstCard(page)
    const form = page.locator('.day-modal .bet-form')
    await expect(form).toHaveClass(/is-editing/)
    await expect(form).toBeInViewport()
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT')
  })
})

test('on a computer the day dialog still opens ready to type the stake', async ({ page }) => {
  await boot(page)
  await page.locator('.history-card tbody tr').first().locator('.td-actions .btn-icon').first().click()
  await expect(page.locator('.day-modal .amount-wrap input').first()).toBeFocused()
})

test.describe('the history on a phone', () => {
  for (const width of [320, 390]) {
    test(`at ${width}px: compact cards, with everything one tap away and nothing sideways`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await boot(page, { entries: BUSY, settings: SETTINGS, moves: [] })
      await expect(page.locator('.history-card table')).toHaveCount(0)
      const card = page.locator('.hcard', { hasText: 'Parlay de tres patas' })
      // Date, result, amount, stake and a short description, closed.
      await expect(card.locator('.hcard-date')).toBeVisible()
      await expect(card.locator('.pill')).toHaveText('LOST')
      await expect(card.locator('.hcard-amt')).toHaveText('-$1,000.00')
      await expect(card.locator('.hcard-stake')).toHaveText('$1,000 staked')
      await expect(card.locator('.hcard-desc')).toContainText('Parlay de tres patas')
      expect(await overflow(page)).toBeLessThanOrEqual(0)

      // Open: odds, closing odds, tags, the whole note, and the actions.
      const toggle = card.locator('.hcard-toggle')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      const details = card.locator('.hcard-details')
      await expect(details).toContainText('-111')
      await expect(details).toContainText('NBA')
      await expect(details).toContainText('Caesars')
      await expect(details.locator('.hcard-note')).toHaveText('Parlay de tres patas con prórroga incluida, revisar el cierre')
      expect(await overflow(page)).toBeLessThanOrEqual(0)

      // A pending bet settles from its card.
      const open = page.locator('.hcard.is-pending').first()
      await open.locator('.settle-btn.loss').click()
      await expect(page.locator('.toast')).toContainText('Settled')

      // Bulk: select on the cards, the bar says how many.
      await page.locator('.hcard .hcard-sel').nth(0).check()
      await page.locator('.hcard .hcard-sel').nth(1).check()
      await expect(page.locator('.bulk-count')).toHaveText('2 selected')
      await expect(page.locator('.bulk-delete')).toHaveText('Delete 2')
      expect(await overflow(page)).toBeLessThanOrEqual(0)

      // Delete from the card asks first.
      await card.locator('.hcard-delete').click()
      await expect(card.locator('.hcard-delete')).toContainText('Sure?')
      await card.locator('.hcard-delete').click()
      await expect(page.locator('.hcard', { hasText: 'Parlay de tres patas' })).toHaveCount(0)
    })
  }

  test('a card opens and closes from the keyboard', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await boot(page, { entries: BUSY, settings: SETTINGS, moves: [] })
    const toggle = page.locator('.hcard-toggle').first()
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Tab')
    // On to the card's own buttons (settle, then edit, day, delete), not elsewhere.
    expect(await page.evaluate(() => document.activeElement?.closest('.hcard') === document.querySelector('.hcard'))).toBe(true)
    await toggle.focus()
    await page.keyboard.press('Space')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })
})

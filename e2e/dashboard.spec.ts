import { expect, test } from '@playwright/test'
import { boot, entry, menu, openAdvanced, reload, SEED } from './harness'

test.describe('the dashboard', () => {
  test('a new account gets three first steps, each done in place, and the guide goes once they are', async ({ page }) => {
    await boot(page, { entries: [], settings: {}, moves: [] })
    const guide = page.locator('.first-run')
    await expect(guide).toContainText('Getting started')
    await expect(guide.locator('.hint').first()).toHaveText('0 of 3 done')

    await guide.locator('.guide-odds .seg-btn', { hasText: 'Decimal' }).click()
    await expect(guide.locator('.hint').first()).toHaveText('1 of 3 done')

    await guide.locator('.guide-bankroll').click()
    const bank = page.locator('.bank-modal')
    await bank.locator('.bank-start input').fill('500')
    await page.keyboard.press('Escape')
    await expect(guide.locator('.hint').first()).toHaveText('2 of 3 done')

    await guide.locator('.guide-bet').click()
    const sheet = page.locator('.quick-modal')
    // Decimal now: the odds box says so.
    await expect(sheet.locator('.quick-row input[type=text]')).toHaveAttribute('placeholder', '1.91')
    await sheet.locator('.quick-row').first().locator('input').first().fill('10')
    await sheet.locator('.seg-btn.pending').click()
    await expect(guide).toHaveCount(0)
    await reload(page)
    await expect(page.locator('.first-run')).toHaveCount(0)
  })

  test('the guide can be hidden for good', async ({ page }) => {
    await boot(page, { entries: [], settings: {}, moves: [] })
    await page.locator('.first-run .btn-icon').click()
    await expect(page.locator('.first-run')).toHaveCount(0)
    await reload(page)
    await expect(page.locator('.first-run')).toHaveCount(0)
  })

  test('an account that already has bets never gets the guide', async ({ page }) => {
    await boot(page, { entries: SEED, settings: {}, moves: [] })
    await expect(page.locator('.key-stats')).toBeVisible()
    await expect(page.locator('.first-run')).toHaveCount(0)
  })

  test('P/L, bankroll and pending bets come first, each saying what dates it covers', async ({ page }) => {
    const open = entry({ id: 'p', date: '2026-08-04', amount: 0, status: 'pending', stake: 40 })
    await boot(page, { entries: [...SEED, open], settings: { startingBankroll: 1000 }, moves: [] })
    const key = page.locator('.key-stats')
    await expect(key.locator('.pl-card .stat-label')).toHaveText('Lifetime P/L')
    await expect(key.locator('.bankroll-card .scope-tag')).toHaveText('All dates')
    await expect(key.locator('.pending-card .key-value')).toHaveText('1')
    await expect(key.locator('.pending-card .key-sub')).toContainText('$40.00 at risk')

    await page.locator('.range-bar .scope-btn', { hasText: 'This year' }).click()
    await expect(page.locator('.range-bar .scope-note')).toContainText('Bankroll, pending bets, the calendar, the month card and the history cover all dates.')
    await expect(page.locator('.roi-card .scope-tag')).toHaveText('This year')
    // The bankroll and pending bets do not follow the range.
    await expect(key.locator('.bankroll-card .scope-tag')).toHaveText('All dates')
    await expect(key.locator('.pending-card .key-value')).toHaveText('1')

    await key.locator('.pending-card').click()
    await expect(page.locator('.pending-modal')).toBeVisible()
  })

  test('advanced analytics are one click away, remembered, and tell days from bets with their own counts', async ({ page }) => {
    const withOdds = [
      entry({ id: 'a', date: '2026-08-01', amount: 150, stake: 100, odds: 2.5 }),
      entry({ id: 'b', date: '2026-08-01', amount: -100, stake: 100 }),
      entry({ id: 'c', date: '2026-08-02', amount: -50, stake: 50, odds: 1.5 })
    ]
    await boot(page, { entries: withOdds })
    const toggle = page.locator('.advanced-toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.breakdown-card')).toBeHidden()
    await openAdvanced(page)
    await expect(page.locator('.breakdown-card')).toBeVisible()

    // Bets: 1 won, 2 lost, of 3 settled; the break-even rate covers only the 2 with odds.
    await expect(page.locator('.mini-strike .mini-sub')).toHaveText('1W–2L of 3 settled bets · small sample')
    await expect(page.locator('.mini-implied .mini-sub')).toHaveText('implied by the odds of 2 settled bets')
    // Days: Aug 1 is a winning day although it holds a lost bet.
    await expect(page.locator('.mini-days .stat-label')).toHaveText('Winning days')
    await expect(page.locator('.mini-days .mini-sub')).toHaveText('1 winning, 1 losing days')

    await reload(page)
    await expect(page.locator('.advanced-toggle')).toHaveAttribute('aria-expanded', 'true')
  })

  test('the calendar legend speaks of days', async ({ page }) => {
    await boot(page)
    await expect(page.locator('.cal-legend')).toContainText('Winning day')
    await expect(page.locator('.cal-legend')).toContainText('Losing day')
  })

  test('one way to add a bet: the + button, on a computer as on a phone, opens the quick add', async ({ page }) => {
    await boot(page)
    // No Add bet in the header any more: the + at the bottom right is the one add button.
    await expect(page.locator('.add-bet-btn')).toHaveCount(0)
    const fab = page.locator('.fab')
    await expect(fab).toBeVisible()
    await expect(fab).toHaveAttribute('aria-label', 'Add bet')
    await fab.click()
    await expect(page.locator('.quick-modal')).toBeVisible()
    // Out of the way while the sheet is open.
    await expect(fab).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 390, height: 800 })
    await expect(fab).toBeVisible()
    await expect(fab).toHaveAttribute('aria-label', 'Add bet')
    await fab.click()
    await expect(page.locator('.quick-modal')).toBeVisible()
  })
})

test.describe('settings and bankroll say why a value was not taken', () => {
  test('a refused setting is named under its box, which goes back to the saved value', async ({ page }) => {
    await boot(page, { settings: { unitSize: 25 } })
    await menu(page, '.settings-btn')
    const modal = page.locator('.settings-modal')
    const unit = modal.locator('.settings-unit input')
    await unit.fill('-5')
    await unit.press('Enter')
    await expect(unit).toHaveValue('25')
    await expect(unit).toHaveAttribute('aria-invalid', 'true')
    await expect(modal.locator('.field-error')).toHaveText('“-5” isn’t an amount this box takes, so the saved value was kept.')
    await unit.fill('30')
    await expect(modal.locator('.field-error')).toHaveCount(0)
  })

  test('a deposit with no amount or a future date says so instead of a dead button', async ({ page }) => {
    await boot(page, { settings: { startingBankroll: 1000 }, moves: [] })
    await page.locator('.bankroll-card').click()
    const bank = page.locator('.bank-modal')
    const save = bank.locator('.move-save')
    await expect(save).toBeEnabled()
    await save.click()
    await expect(bank.locator('.move-amount')).toBeFocused()
    await expect(bank.locator('.field-error')).toHaveText('Enter the amount, more than 0.')
    await bank.locator('.move-amount').fill('50')
    await bank.locator('.move-date').fill('2099-01-01')
    await expect(bank.locator('.field-error')).toHaveText('A deposit or withdrawal can’t be dated in the future.')
  })
})

test.describe('the top bar', () => {
  test('holds only the menu button; the rest is in the menu, which the keyboard works', async ({ page }) => {
    await boot(page, { theme: 'dark' })
    const bar = page.locator('.topbar-actions')
    await expect(bar.locator('button:visible')).toHaveCount(1)
    await expect(bar.locator('.menu-btn')).toBeVisible()
    const toggle = page.locator('.menu-btn')
    // The + button comes right after it for the keyboard, where the header's Add bet was.
    await toggle.focus()
    await page.keyboard.press('Tab')
    await expect(page.locator('.fab')).toBeFocused()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.app-menu')).toHaveCount(0)

    // Opened from the keyboard: focus on the first item, arrows move, Escape closes back to the button.
    await toggle.focus()
    await page.keyboard.press('Enter')
    const items = page.locator('.app-menu [role="menuitem"]')
    await expect(items).toHaveText(['Import & export', 'Pending bets', 'Settings', 'Expense settings', 'Switch to light theme', 'Español', 'Sign out'])
    await expect(items.first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(items.nth(1)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect(items.last()).toBeFocused()
    // Expense settings is one of the items the arrows, Home and End walk.
    await page.keyboard.press('Home')
    await expect(items.first()).toBeFocused()
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
    await expect(items.nth(3)).toBeFocused()
    await expect(items.nth(3)).toHaveClass(/expense-settings-btn/)
    await page.keyboard.press('ArrowDown')
    await expect(items.nth(4)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(items.nth(3)).toBeFocused()
    await page.keyboard.press('End')
    await expect(items.last()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.locator('.app-menu')).toHaveCount(0)
    await expect(toggle).toBeFocused()

    // An item that opens a dialog closes the menu; closing the dialog lands back on the menu button.
    await page.keyboard.press('Enter')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.locator('.settings-modal')).toBeVisible()
    await expect(page.locator('.app-menu')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(toggle).toBeFocused()

    // Expense settings opens from here on the Bets view too (the same sheet as in the Expenses view), and closing it
    // lands back on the menu button.
    await page.keyboard.press('Enter')
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    const expenseSettings = page.locator('.expense-settings-modal')
    await expect(expenseSettings).toBeVisible()
    await expect(expenseSettings.locator('h2').first()).toHaveText('Expense settings')
    await expect(page.locator('.app-menu')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(expenseSettings).toHaveCount(0)
    await expect(toggle).toBeFocused()

    // A click outside closes it; the theme toggle keeps it open.
    await toggle.click()
    await page.locator('.app-menu .theme-btn').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(page.locator('.app-menu')).toBeVisible()
    await page.locator('.history-card h2').click()
    await expect(page.locator('.app-menu')).toHaveCount(0)
  })
})

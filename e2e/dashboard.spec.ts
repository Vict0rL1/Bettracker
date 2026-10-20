import { expect, test } from '@playwright/test'
import { boot, entry, openAdvanced, reload, SEED } from './harness'

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

  test('one way to add a bet: the header button and the phone’s + open the same quick add', async ({ page }) => {
    await boot(page)
    await expect(page.locator('.add-bet-btn')).toHaveText('Add bet')
    await expect(page.locator('.fab')).toBeHidden()
    await page.locator('.add-bet-btn').click()
    await expect(page.locator('.quick-modal')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 390, height: 800 })
    await expect(page.locator('.fab')).toBeVisible()
    await expect(page.locator('.fab')).toHaveAttribute('aria-label', 'Add bet')
    await page.locator('.fab').click()
    await expect(page.locator('.quick-modal')).toBeVisible()
  })
})

test.describe('settings and bankroll say why a value was not taken', () => {
  test('a refused setting is named under its box, which goes back to the saved value', async ({ page }) => {
    await boot(page, { settings: { unitSize: 25 } })
    await page.click('.settings-btn')
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

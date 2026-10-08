import { expect, test } from '@playwright/test'
import { boot, entry, reload, USER } from './harness'

/** Two bets with the two prices everyone recognises: +150 (2.50, 3/2) and −110 (1.91, 10/11). */
const WITH_ODDS = [
  entry({ id: 'a', date: '2026-08-01', amount: 150, stake: 100, odds: 2.5, sport: 'NBA', book: 'DK', betType: 'Spread' }),
  entry({ id: 'b', date: '2026-08-02', amount: -110, stake: 110, odds: 1.9091, sport: 'NBA', book: 'DK', betType: 'Spread' })
]

test.describe('settings', () => {
  test('the odds format changes how every odds is shown, applies offline and survives a reload', async ({ page }) => {
    await boot(page, { entries: WITH_ODDS })
    // Newest first, so the first row is the −110 bet.
    const odds = page.locator('.history-card tbody tr').first().locator('.td-odds')
    await expect(odds).toHaveText('-110')

    await page.click('.settings-btn')
    const dialog = page.locator('.settings-modal')
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await dialog.locator('.settings-seg .seg-btn', { hasText: 'Decimal' }).click()
    await expect(odds).toHaveText('1.91')
    await dialog.locator('.settings-seg .seg-btn', { hasText: 'Fractional' }).click()
    await expect(odds).toHaveText('10/11')
    // Offline: the change is queued for the server, not lost.
    await expect(dialog.locator('.settings-sync')).toContainText('Saved on this device')
    const queued = await page.evaluate((uid) => localStorage.getItem(`bettracker:settings-outbox:${uid}`), USER.id)
    expect(queued).toContain('"oddsFormat":"fractional"')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    await reload(page)
    await expect(odds).toHaveText('10/11')

    // The day modal reads and writes the same format.
    await page.locator('.history-card tbody tr').first().locator('.td-actions .btn-icon').first().click()
    const modal = page.locator('.day-modal')
    await expect(modal.locator('.bet-stake')).toContainText('@ 10/11')
    await expect(modal.locator('.odds-input')).toHaveAttribute('placeholder', '3/2')
    await modal.locator('.bet-item .btn-icon').first().click()
    await expect(modal.locator('.odds-input')).toHaveValue('10/11')
  })

  test('a default stake set here is what quick add opens with', async ({ page }) => {
    await boot(page)
    await page.click('.settings-btn')
    const stake = page.locator('.settings-modal .settings-stake input')
    await stake.fill('30')
    await stake.press('Enter')
    await page.locator('.settings-modal .modal-actions .btn-ghost').click()
    await page.click('.fab')
    await expect(page.locator('.quick-modal .field input').first()).toHaveValue('30')
  })
})

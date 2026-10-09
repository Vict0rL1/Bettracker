import { expect, test } from '@playwright/test'
import { boot, entry } from './harness'

// 2.50 taken against a 2.20 close beats it by 13.6%; the −110 bet matched its
// close; the NFL bet has no closing price yet.
const WITH_CLOSE = [
  entry({ id: 'a', date: '2026-08-01', amount: 150, stake: 100, odds: 2.5, closingOdds: 2.2, sport: 'NBA' }),
  entry({ id: 'b', date: '2026-08-02', amount: -100, stake: 100, odds: 1.9091, closingOdds: 1.9091, sport: 'NBA' }),
  entry({ id: 'c', date: '2026-08-03', amount: -50, stake: 50, odds: 2, sport: 'NFL' })
]

test.describe('closing line value', () => {
  test('is shown per bet and averaged in the stats and the breakdown', async ({ page }) => {
    await boot(page, { entries: WITH_CLOSE })
    const mini = page.locator('.mini', { hasText: 'CLV' })
    await expect(mini.locator('.mini-value')).toHaveText('+6.8%')
    await expect(mini.locator('.mini-sub')).toHaveText('beat the close 1 of 2')
    // Newest first: the NFL bet has no close, the +150 bet is the last row.
    const rows = page.locator('.history-card tbody tr')
    await expect(rows.nth(0).locator('.td-clv')).toHaveText('—')
    await expect(rows.nth(2).locator('.td-clv')).toHaveText('+13.6%')
    await expect(page.locator('.bd-row', { hasText: 'NBA' })).toContainText('CLV +6.8%')
    await expect(page.locator('.bd-row', { hasText: 'NFL' })).not.toContainText('CLV')
  })

  test('closing odds are typed in the chosen format from the day modal and apply offline', async ({ page }) => {
    await boot(page, { entries: WITH_CLOSE })
    // Open the NFL day (Aug 3, the newest) and edit its one bet.
    await page.locator('.history-card tbody tr').first().locator('.td-actions .btn-icon').first().click()
    const modal = page.locator('.day-modal')
    await modal.locator('.bet-item .btn-icon').first().click()
    await expect(modal.locator('.odds-input').first()).toHaveValue('+100')
    // +120 is 2.20: a 2.00 price against it is 9.1% worse than the close.
    await modal.locator('.closing-input').fill('+120')
    await modal.locator('button[type=submit]').click()
    await expect(modal.locator('.bet-item .bet-stake')).toContainText('CLV -9.1%')
    await expect(page.locator('.sync-badge')).toHaveText('Offline · 1 queued')
    await page.keyboard.press('Escape')
    await expect(page.locator('.history-card tbody tr').first().locator('.td-clv')).toHaveText('-9.1%')
    await expect(page.locator('.mini', { hasText: 'CLV' }).locator('.mini-sub')).toHaveText('beat the close 1 of 3')
  })
})

import { expect, test } from '@playwright/test'
import { boot, entry, SEED } from './harness'

const rows = (page: import('@playwright/test').Page) => page.locator('.history-card tbody tr')

test.describe('bulk editing and undo', () => {
  test('retag the selected rows, then undo it, all offline', async ({ page }) => {
    await boot(page)
    // Select the two NBA bets (rows 2 and 3, newest first).
    await rows(page).nth(1).locator('.td-sel input').check()
    await rows(page).nth(2).locator('.td-sel input').check()
    const bar = page.locator('.bulk-bar')
    await expect(bar.locator('.bulk-count')).toHaveText('2 selected')
    await bar.locator('input[aria-label="Sport"]').fill('Tennis')
    await bar.locator('.bulk-apply').click()
    await expect(page.locator('.toast')).toContainText('Retagged 2 bets')
    await expect(rows(page).nth(1).locator('.tag').first()).toHaveText('Tennis')
    await expect(rows(page).nth(2).locator('.tag').first()).toHaveText('Tennis')
    // The book stayed as it was.
    await expect(rows(page).nth(1).locator('.tag').nth(1)).toHaveText('DK')
    await expect(page.locator('.sync-badge')).toHaveText('Offline · 2 queued')

    await page.locator('.toast-action').click()
    await expect(page.locator('.toast')).toContainText('Undone')
    await expect(rows(page).nth(1).locator('.tag').first()).toHaveText('NBA')
    await expect(rows(page).nth(2).locator('.tag').first()).toHaveText('NBA')
  })

  test('delete the selected rows and bring them back with Undo; a single delete has Undo too', async ({ page }) => {
    await boot(page)
    await page.locator('.history-card thead .td-sel input').check()
    await expect(page.locator('.bulk-bar .bulk-count')).toHaveText('3 selected')
    const del = page.locator('.bulk-delete')
    await del.click()
    await expect(del).toHaveText('Click again to confirm')
    await del.click()
    await expect(rows(page)).toHaveCount(0)
    await expect(page.locator('.toast')).toContainText('Deleted 3 bets')
    await page.locator('.toast-action').click()
    await expect(rows(page)).toHaveCount(3)
    await expect(page.locator('.stat-card').nth(1).locator('.life-value')).toHaveText('+$180.00')
    // Three deletes, then three re-adds, all waiting for the connection.
    await expect(page.locator('.sync-badge')).toHaveText('Offline · 6 queued')

    await rows(page).first().locator('.td-actions .btn-icon.danger').click()
    await rows(page).first().locator('.td-actions .btn-icon.danger').click()
    await expect(rows(page)).toHaveCount(2)
    await expect(page.locator('.toast')).toContainText('Deleted a bet')
    await page.locator('.toast-action').click()
    await expect(rows(page)).toHaveCount(3)
  })

  test('settle the selected pending bets in bulk, skipping a win that has no odds', async ({ page }) => {
    const WITH_PENDING = [
      ...SEED,
      entry({ id: 'p1', date: '2026-08-04', amount: 0, status: 'pending', stake: 50, odds: 2, sport: 'NBA' }),
      entry({ id: 'p2', date: '2026-08-05', amount: 0, status: 'pending', stake: 20, sport: 'NFL' })
    ]
    await boot(page, { entries: WITH_PENDING })
    await page.locator('.history-card thead .td-sel input').check()
    await page.locator('.bulk-bar .settle-btn.win').click()
    await expect(page.locator('.toast')).toContainText('Settled 1 bet as won · 1 skipped')
    await expect(rows(page).locator('.pill', { hasText: 'PENDING' })).toHaveCount(1)
    await expect(page.locator('.history-card tbody tr', { hasText: 'Aug 4, 2026' }).locator('.td-amt')).toHaveText('+$50.00')
    await page.locator('.toast-action').click()
    await expect(rows(page).locator('.pill', { hasText: 'PENDING' })).toHaveCount(2)
  })
})

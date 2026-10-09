import { expect, test } from '@playwright/test'
import { boot, reload } from './harness'

test.describe('a database behind the app', () => {
  test('keeps changes queued until the migration runs, then syncs them', async ({ page }) => {
    await boot(page, { backend: 'behind' })
    const rows = page.locator('.history-card tbody tr')
    const badge = page.locator('.sync-badge')
    await expect(rows).toHaveCount(3)
    await expect(badge).toHaveText('Synced')

    // The database refuses the write: the bet stays on the device, queued.
    await page.keyboard.press('t')
    const sheet = page.locator('.quick-modal')
    await sheet.locator('.field input').first().fill('20')
    await sheet.locator('.seg-btn.loss').click()
    await expect(badge).toHaveClass(/behind/)
    await expect(badge).toHaveText('Update needed · 1 queued')
    await expect(page.locator('.toast')).toContainText('Your database is behind the app')
    await expect(rows).toHaveCount(4)

    // Nothing was dropped: it is still there, still queued, after a reload.
    await reload(page)
    await expect(rows).toHaveCount(4)
    await expect(badge).toHaveText('Update needed · 1 queued')

    // The owner runs the migration; the next sync sends the bet.
    await page.evaluate(() => {
      localStorage.setItem('e2e:migrated', '1')
      window.dispatchEvent(new Event('online'))
    })
    await expect(badge).toHaveText('Synced')
    await expect(rows).toHaveCount(4)
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('e2e:rows') ?? '[]') as { amount: number; stake: number }[])
    expect(stored).toHaveLength(4)
    expect(stored[3]).toMatchObject({ amount: -20, stake: 20, status: 'lost' })
  })
})

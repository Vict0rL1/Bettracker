import { expect, test } from '@playwright/test'
import { boot, reload } from './harness'

test.describe('changes made while a request is out', () => {
  test('settling a bet while its insert is still on the wire reaches the server', async ({ page }) => {
    // Every answer takes a second and a half, so the settle below is made
    // while the insert is still out.
    await boot(page, { backend: 'live', latencyMs: 1500, settings: { defaultStake: 20 } })
    const badge = page.locator('.sync-badge')
    await expect(badge).toHaveText('Synced')

    await page.keyboard.press('t')
    await page.locator('.quick-modal .seg-btn.pending').click()
    await expect(badge).toHaveText('Syncing 1…')

    await page.locator('.pending-btn').click()
    const panel = page.locator('.pending-modal')
    await panel.locator('.pend-item').first().locator('.settle-btn.loss').click()
    await expect(page.locator('.toast')).toContainText('Settled as lost')

    // The insert lands, then the settle goes out behind it.
    await expect(badge).toHaveText('Synced', { timeout: 15_000 })
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('e2e:rows') ?? '[]') as { status: string; amount: number | null }[])
    expect(stored).toHaveLength(4)
    expect(stored[3]).toMatchObject({ status: 'lost', amount: -20 })

    // What the server holds is what the app shows after a fresh load.
    await reload(page)
    await expect(page.locator('.pending-btn .pending-badge')).toHaveCount(0)
    await expect(page.locator('.history-card tbody tr').first().locator('.pill')).toHaveText('LOST')
  })
})

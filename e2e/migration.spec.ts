import { expect, test } from '@playwright/test'
import { boot, reload } from './harness'

const HINT = 'Your database is behind the app'

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
    await expect(page.locator('.toast')).toContainText(HINT)
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

  test('says so once, not on every retry or resume', async ({ page }) => {
    await boot(page, { backend: 'behind' })
    await page.keyboard.press('t')
    const sheet = page.locator('.quick-modal')
    await sheet.locator('.field input').first().fill('20')
    await sheet.locator('.seg-btn.loss').click()
    const badge = page.locator('.sync-badge')
    await expect(badge).toHaveText('Update needed · 1 queued')
    await expect(page.locator('.toast')).toContainText(HINT)

    // Let the hint go away; from here on, any toast on screen would be a repeat.
    const toast = page.locator('.toast')
    await expect(toast).toHaveCount(0, { timeout: 10_000 })
    const writes = () => page.evaluate(() => Number(localStorage.getItem('e2e:writes') ?? 0))
    const before = await writes()
    // Two reconnects and a resume: each retries the queued bet, and each finds the database still behind.
    for (const event of ['online', 'online', 'visibilitychange']) {
      const n = await writes()
      await page.evaluate((e) => (e === 'online' ? window : document).dispatchEvent(new Event(e)), event)
      await expect.poll(writes).toBeGreaterThan(n)
    }
    expect(await writes()).toBeGreaterThanOrEqual(before + 3)
    await expect(badge).toHaveText('Update needed · 1 queued')
    // Checked once, not waited for: a repeated hint would still be showing.
    expect(await toast.count()).toBe(0)
  })

  test('reads as behind, not offline, once the connection is back and the database answers', async ({ page }) => {
    await boot(page, { backend: 'behind' })
    const badge = page.locator('.sync-badge')
    const logLoss = async () => {
      await page.keyboard.press('t')
      const sheet = page.locator('.quick-modal')
      await sheet.locator('.field input').first().fill('20')
      await sheet.locator('.seg-btn.loss').click()
      await expect(sheet).toHaveCount(0)
    }
    await page.evaluate(() => localStorage.setItem('e2e:down', '1'))
    await logLoss()
    await expect(badge).toHaveText('Offline · 1 queued')
    // The connection comes back with no 'online' event (a dropped request, not a lost network);
    // the next attempt reaches the database, which is behind.
    await page.evaluate(() => localStorage.removeItem('e2e:down'))
    await logLoss()
    await expect(badge).toHaveText('Update needed · 2 queued')
  })

  test('a setting changed meanwhile waits for the migration too, and says so', async ({ page }) => {
    await boot(page, { backend: 'behind' })
    const badge = page.locator('.sync-badge')
    await page.click('.settings-btn')
    const dialog = page.locator('.settings-modal')
    await dialog.locator('.settings-seg .seg-btn', { hasText: 'Decimal' }).click()
    await expect(dialog.locator('.settings-sync')).toHaveText('Saved on this device — syncs once your database is updated.')
    await page.keyboard.press('Escape')
    // No bet is queued, but a change is: the badge does not claim everything is saved.
    await expect(badge).toHaveText('Update needed')

    await page.evaluate(() => {
      localStorage.setItem('e2e:migrated', '1')
      window.dispatchEvent(new Event('online'))
    })
    await expect(badge).toHaveText('Synced')
    const row = await page.evaluate(() => JSON.parse(localStorage.getItem('e2e:settings') ?? 'null') as { odds_format: string } | null)
    expect(row?.odds_format).toBe('decimal')
  })
})

test('an edit queued by the version deployed before this one still reaches the server after the upgrade', async ({ page }) => {
  // That version stored edits with no edit time (it had no conflict rule).
  const legacy = [{ opId: 'legacy-1', kind: 'update', id: 'c', input: { date: '2026-08-03', amount: -60, note: 'edited offline' } }]
  await boot(page, { backend: 'live', outbox: legacy })
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('e2e:rows') ?? '[]') as { id: string; amount: number; note: string }[])
  expect(stored.find((r) => r.id === 'c')).toMatchObject({ amount: -60, note: 'edited offline' })
  await expect(page.locator('.history-card tbody')).toContainText('edited offline')
})

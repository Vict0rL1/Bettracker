import { expect, test } from '@playwright/test'
import { boot, entry, reload, SEED } from './harness'

const pad = (n: number): string => String(n).padStart(2, '0')
const now = new Date()
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

// The usual August seed plus one bet today, so a recent range has something in it.
const WITH_TODAY = [...SEED, entry({ id: 't', date: today, amount: 10, stake: 10, sport: 'MLB' })]

test.describe('date range', () => {
  test('scopes the stats, the chart and the breakdown, and is remembered across reloads', async ({ page }) => {
    await boot(page, { entries: WITH_TODAY })
    const card = page.locator('.stat-card').nth(1)
    await expect(card.locator('.life-value')).toHaveText('+$190.00')
    await expect(page.locator('.bd-row')).toHaveCount(3)

    await page.locator('.range-bar .scope-btn', { hasText: 'Last 30 days' }).click()
    await expect(card.locator('.stat-label')).toHaveText('Last 30 days P/L')
    await expect(card.locator('.life-value')).toHaveText('+$10.00')
    await expect(page.locator('.bd-row')).toHaveCount(1)
    await expect(page.locator('.chart-card .scope-btn').first()).toHaveText('Last 30 days')
    // The history and the pending count are not a view of the range.
    await expect(page.locator('.history-card tbody tr')).toHaveCount(4)

    await reload(page)
    await expect(page.locator('.range-bar .scope-btn', { hasText: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true')
    await expect(card.locator('.life-value')).toHaveText('+$10.00')
  })

  test('custom dates are inclusive at both ends', async ({ page }) => {
    await boot(page, { entries: WITH_TODAY })
    await page.locator('.range-bar .scope-btn', { hasText: 'Custom' }).click()
    const boxes = page.locator('.range-custom input')
    await boxes.nth(0).fill('2026-08-02')
    await boxes.nth(1).fill('2026-08-03')
    // −50 on Aug 2 and +30 on Aug 3; the +200 on Aug 1 is out.
    await expect(page.locator('.stat-card').nth(1).locator('.life-value')).toHaveText('-$20.00')
    await expect(page.locator('.stat-card').nth(1).locator('.stat-label')).toHaveText('Custom P/L')
  })
})

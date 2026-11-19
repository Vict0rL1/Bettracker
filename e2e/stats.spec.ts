import { expect, test } from '@playwright/test'
import { boot, entry, openAdvanced, SEED } from './harness'

const pad = (n: number): string => String(n).padStart(2, '0')
const now = new Date()
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

test.describe('stats', () => {
  test('ROI covers only the bets with a stake, and says so, with the average stake in the same line', async ({ page }) => {
    await boot(page)
    await openAdvanced(page)
    // Staked: -50 on 50, +30 on 60  =>  -20 / 110 = -18.2%; the average of those two stakes is 55.
    await expect(page.locator('.roi-card .life-value')).toHaveText('-18.2%')
    await expect(page.locator('.roi-card .stat-sub')).toHaveText(
      '-$20.00 on $110.00 staked · avg $55.00 · 2 of 3 bets with a stake'
    )
  })

  test('lifetime P/L still counts every bet', async ({ page }) => {
    await boot(page)
    await openAdvanced(page)
    await expect(page.locator('.pl-card').locator('.life-value')).toHaveText('+$180.00')
  })

  test('breakdown profit is all-in while ROI flags its subset', async ({ page }) => {
    await boot(page)
    await openAdvanced(page)
    const nba = page.locator('.bd-row', { hasText: 'NBA' })
    await expect(nba.locator('.bd-profit')).toHaveText('+$150.00')
    await expect(nba.locator('.bd-meta')).toContainText('(1/2)')
  })

  test('balance chart switches to the month scope and back, and one settled day in the month already draws', async ({ page }) => {
    // The August seed plus one bet today: the month has a single settled day, which draws from its opening point at 0.
    await boot(page, { entries: [...SEED, entry({ id: 't', date: today, amount: 10, stake: 10 })] })
    await openAdvanced(page)
    await page.locator('.chart-card .scope-btn', { hasText: 'This month' }).click()
    await expect(page.locator('.chart-card .scope-btn', { hasText: 'This month' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.chart-card .recharts-surface')).toHaveCount(1)
    await expect(page.locator('.chart-card .chart-empty')).toHaveCount(0)
    await page.locator('.chart-card .scope-btn', { hasText: 'All time' }).click()
    await expect(page.locator('.chart-card .scope-btn', { hasText: 'All time' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.chart-card .recharts-surface')).toHaveCount(1)
  })
})

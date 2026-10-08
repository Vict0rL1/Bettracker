import { expect, test } from '@playwright/test'
import { boot } from './harness'

test.describe('stats', () => {
  test('ROI covers only the bets with a stake, and says so', async ({ page }) => {
    await boot(page)
    // Staked: -50 on 50, +30 on 60  =>  -20 / 110 = -18.2%
    await expect(page.locator('.roi-card .life-value')).toHaveText('-18.2%')
    await expect(page.locator('.roi-card .stat-sub')).toHaveText(
      '-$20.00 on $110.00 staked · 2 of 3 bets with a stake'
    )
  })

  test('lifetime P/L still counts every bet', async ({ page }) => {
    await boot(page)
    await expect(page.locator('.stat-card').nth(1).locator('.life-value')).toHaveText('+$180.00')
  })

  test('breakdown profit is all-in while ROI flags its subset', async ({ page }) => {
    await boot(page)
    const nba = page.locator('.bd-row', { hasText: 'NBA' })
    await expect(nba.locator('.bd-profit')).toHaveText('+$150.00')
    await expect(nba.locator('.bd-meta')).toContainText('(1/2)')
  })

  test('balance chart switches to the month scope and back', async ({ page }) => {
    await boot(page)
    await page.locator('.chart-card .scope-btn', { hasText: 'This month' }).click()
    await expect(page.locator('.chart-card .scope-btn', { hasText: 'This month' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.chart-card .recharts-surface, .chart-card .chart-empty')).toHaveCount(1)
    await page.locator('.chart-card .scope-btn', { hasText: 'All time' }).click()
    await expect(page.locator('.chart-card .scope-btn', { hasText: 'All time' })).toHaveAttribute('aria-pressed', 'true')
  })
})

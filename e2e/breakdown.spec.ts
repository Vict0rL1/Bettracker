import { expect, test } from '@playwright/test'
import { boot, entry } from './harness'

// Saturday underdog, Sunday even, Monday heavy favorite, and a Saturday in
// September with no odds recorded.
const WITH_ODDS = [
  entry({ id: 'a', date: '2026-08-01', amount: 150, stake: 100, odds: 2.5, sport: 'NBA' }),
  entry({ id: 'b', date: '2026-08-02', amount: -100, stake: 100, odds: 1.9091, sport: 'NBA' }),
  entry({ id: 'c', date: '2026-08-03', amount: -50, stake: 50, odds: 1.4, sport: 'NFL' }),
  entry({ id: 'd', date: '2026-09-05', amount: 20, stake: 20, sport: 'NFL' })
]

const tab = (page: import('@playwright/test').Page, name: string) => page.locator('.breakdown-card .scope-btn', { hasText: name })

test.describe('deeper breakdowns', () => {
  test('by odds band, in band order, leaving bets without odds out', async ({ page }) => {
    await boot(page, { entries: WITH_ODDS })
    await tab(page, 'Odds').click()
    const labels = page.locator('.breakdown-card .bd-label')
    await expect(labels).toHaveText(['Heavy favorite · ≤ -200', 'Even · -111 – +110', 'Underdog · +110 – +250'])
    await expect(page.locator('.breakdown-card .bd-profit')).toHaveText(['-$50.00', '-$100.00', '+$150.00'])
    await expect(page.locator('.breakdown-card .bd-meta').last()).toContainText('+150.0% on $100.00')
  })

  test('by weekday and by month, in calendar order', async ({ page }) => {
    await boot(page, { entries: WITH_ODDS })
    await tab(page, 'Weekday').click()
    await expect(page.locator('.breakdown-card .bd-label')).toHaveText(['Sunday', 'Monday', 'Saturday'])
    await expect(page.locator('.breakdown-card .bd-row', { hasText: 'Saturday' }).locator('.bd-profit')).toHaveText('+$170.00')
    await tab(page, 'Month').click()
    await expect(page.locator('.breakdown-card .bd-label')).toHaveText(['Aug 2026', 'Sep 2026'])
    await expect(page.locator('.breakdown-card .bd-profit')).toHaveText(['$0.00', '+$20.00'])
  })
})

import { expect, test } from '@playwright/test'
import { boot } from './harness'

const rows = (page: import('@playwright/test').Page) => page.locator('.history-card tbody tr')

test.describe('history filters', () => {
  test('search narrows the table and reports the subset', async ({ page }) => {
    await boot(page)
    await expect(rows(page)).toHaveCount(3)
    await page.fill('.filter-search', 'live')
    await expect(rows(page)).toHaveCount(1)
    await expect(page.locator('.history-card .card-note')).toHaveText('1 of 3 bets')
    await page.locator('.history-card .chip', { hasText: 'Clear' }).click()
    await expect(rows(page)).toHaveCount(3)
  })

  test('result filter', async ({ page }) => {
    await boot(page)
    await page.selectOption('select[aria-label="Filter by result"]', 'loss')
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first().locator('.pill')).toHaveText('LOSS')
  })

  test('sport filter', async ({ page }) => {
    await boot(page)
    await page.selectOption('select[aria-label="Filter by sport"]', 'NBA')
    await expect(rows(page)).toHaveCount(2)
  })
})

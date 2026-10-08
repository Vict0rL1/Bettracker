import { expect, test } from '@playwright/test'
import { boot, reload } from './harness'

test('the interface follows the toggle into Spanish and remembers it', async ({ page }) => {
  await boot(page)
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.locator('.history-card h2')).toHaveText('History')
  await page.click('.lang-btn')
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
  await expect(page.locator('.history-card h2')).toHaveText('Historial')
  await expect(page.locator('.history-card tbody tr').first().locator('.pill')).toHaveText('GANADA')
  // Dates follow the language too.
  await expect(page.locator('.history-card tbody tr').first().locator('.td-date')).toContainText('ago')
  await reload(page)
  await expect(page.locator('.history-card h2')).toHaveText('Historial')
  await page.click('.lang-btn')
  await expect(page.locator('.history-card h2')).toHaveText('History')
})

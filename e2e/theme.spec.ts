import { expect, test } from '@playwright/test'
import { boot, reload } from './harness'

test('theme toggle flips the document and the choice persists', async ({ page }) => {
  await boot(page, { theme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.click('.theme-btn')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await reload(page)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})

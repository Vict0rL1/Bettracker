import { expect, test } from '@playwright/test'
import { boot, entry, reload, SEED } from './harness'

const pad = (n: number): string => String(n).padStart(2, '0')
const now = new Date()
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

// A loss of $85 this month, against a $100 limit: 85%, inside the warning band.
const DOWN_85 = [...SEED, entry({ id: 'm', date: today, amount: -85, stake: 85, sport: 'MLB' })]

test.describe('monthly loss limit', () => {
  test('warns at 80%, warns harder past the limit, never blocks logging, and a dismissal sticks', async ({ page }) => {
    await boot(page, { entries: DOWN_85, settings: { lossLimit: 100 } })
    const banner = page.locator('.loss-banner')
    await expect(banner).toHaveClass(/near/)
    await expect(banner).toContainText('this month’s losses are $85.00, 85% of your $100.00 limit')

    // Logging is not blocked: a quick-add loss of $20 takes the month to $105 lost.
    await page.click('.fab')
    await page.locator('.quick-modal .field input').first().fill('20')
    await page.locator('.quick-modal .seg-btn.loss').click()
    await expect(page.locator('.toast')).toContainText('Added a bet')
    await expect(banner).toHaveClass(/over/)
    await expect(banner).toContainText('Over your monthly loss limit: $105.00 lost this month against a $100.00 limit')

    await page.locator('.loss-dismiss').click()
    await expect(banner).toHaveCount(0)
    await reload(page)
    await expect(banner).toHaveCount(0)
  })

  test('the limit is set in settings and the banner follows it at once', async ({ page }) => {
    await boot(page, { entries: DOWN_85 })
    await expect(page.locator('.loss-banner')).toHaveCount(0)
    await page.click('.settings-btn')
    const box = page.locator('.settings-modal .settings-loss input')
    await box.fill('100')
    await box.press('Enter')
    await page.keyboard.press('Escape')
    await expect(page.locator('.loss-banner')).toHaveClass(/near/)
    // Raising the limit clears it; the change is queued for the server like any setting.
    await page.click('.settings-btn')
    await box.fill('1000')
    await box.press('Enter')
    await expect(page.locator('.loss-banner')).toHaveCount(0)
    await expect(page.locator('.settings-modal .settings-sync')).toContainText('Saved on this device')
  })
})

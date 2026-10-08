import { expect, test } from '@playwright/test'
import { boot } from './harness'

test.describe('quick add', () => {
  test('a pending bet is two taps when a default stake is set', async ({ page }) => {
    await boot(page, { settings: { defaultStake: 25, oddsFormat: 'american' } })
    await page.click('.fab')
    const sheet = page.locator('.quick-modal')
    await expect(sheet.locator('.field input').first()).toHaveValue('25')
    // Tags come from the last bet logged (the NFL one in the seed).
    await expect(sheet.locator('.quick-tags input').first()).toHaveValue('NFL')
    await sheet.locator('.seg-btn.pending').click()
    await expect(page.locator('.toast')).toContainText('Logged a pending bet')
    await expect(sheet).toHaveCount(0)
    const row = page.locator('.history-card tbody tr.is-pending')
    await expect(row).toHaveCount(1)
    await expect(row.locator('.td-stake').first()).toHaveText('$25.00')
  })

  test('odds are read in the chosen format and a win is worked out from them', async ({ page }) => {
    await boot(page, { settings: { defaultStake: 100, oddsFormat: 'american' } })
    await page.keyboard.press('t')
    const sheet = page.locator('.quick-modal')
    await sheet.locator('.quick-row input[type=text]').fill('+150')
    await sheet.locator('.seg-btn.win').click()
    await expect(page.locator('.toast')).toContainText('Added a bet')
    const row = page.locator('.history-card tbody tr').first()
    await expect(row.locator('.pill')).toHaveText('WON')
    await expect(row.locator('.td-amt')).toHaveText('+$150.00')
  })

  test('a win without odds asks for the profit instead of guessing', async ({ page }) => {
    await boot(page, { settings: { defaultStake: 50 } })
    await page.click('.fab')
    const sheet = page.locator('.quick-modal')
    await sheet.locator('.seg-btn.win').click()
    await expect(sheet.locator('.quick-profit')).toBeVisible()
    await sheet.locator('.quick-profit input').fill('42')
    await sheet.locator('.quick-save').click()
    await expect(page.locator('.history-card tbody tr').first().locator('.td-amt')).toHaveText('+$42.00')
  })
})

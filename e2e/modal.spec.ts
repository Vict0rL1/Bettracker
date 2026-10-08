import { expect, test } from '@playwright/test'
import { boot } from './harness'

test.describe('day modal', () => {
  test('is a real dialog: role, aria-modal, labelled, focus trapped, Escape closes', async ({ page }) => {
    await boot(page)
    await page.locator('.history-card tbody tr').first().locator('button[aria-label^="Edit"]').click()
    const dialog = page.locator('.day-modal')
    await expect(dialog).toHaveAttribute('role', 'dialog')
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await expect(dialog).toHaveAttribute('aria-labelledby', /.+/)

    // Tabbing off the last control wraps to the first instead of leaving the dialog.
    await page.locator('.day-modal button, .day-modal input').last().focus()
    await page.keyboard.press('Tab')
    const inside = await page.evaluate(() => document.querySelector('.day-modal')?.contains(document.activeElement))
    expect(inside).toBe(true)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('LOSS mirrors the stake into the amount until the user types their own', async ({ page }) => {
    await boot(page)
    await page.locator('.history-card tbody tr').first().locator('button[aria-label^="Edit"]').click()
    await page.click('.day-modal .seg-btn.loss')
    // Fields, in order: stake, odds, amount.
    const stake = page.locator('.day-modal .field').nth(0).locator('input')
    const amount = page.locator('.day-modal .field').nth(2).locator('input')
    await stake.fill('80')
    await expect(amount).toHaveValue('80')
    await amount.fill('55')
    await stake.fill('90')
    await expect(amount).toHaveValue('55')
  })
})

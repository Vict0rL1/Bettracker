import { expect, test } from '@playwright/test'
import { boot, reload, USER } from './harness'

// The usual seed: +200 (no stake), −50 on 50, +30 on 60. At $20 a unit:
// lifetime +$180 is +9.00u, and ROI is −$20 on $110 staked: −1.00u on 5.5u.
const UNITS = { unitSize: 20, showUnits: true }

test.describe('units', () => {
  test('every amount shows in units, while the boxes still take dollars', async ({ page }) => {
    await boot(page, { settings: UNITS })
    const lifetime = page.locator('.stat-card').nth(1)
    await expect(lifetime.locator('.life-value')).toHaveText('+9.00u')
    // Hovering the figure gives the exact dollars.
    await expect(lifetime.locator('.life-value')).toHaveAttribute('title', '+$180.00')
    await expect(page.locator('.roi-card .stat-sub')).toContainText('-1.00u on 5.5u staked · 2 of 3 bets with a stake')
    // Newest first: the +$30 bet.
    await expect(page.locator('.history-card tbody tr').first().locator('.td-amt')).toHaveText('+1.50u')
    await expect(page.locator('.history-card tbody tr').first().locator('.td-stake:not(.td-odds)')).toHaveText('3u')

    // The stake box is still in dollars; the note under it says what that is in units.
    await page.click('.fab')
    const sheet = page.locator('.quick-modal')
    await expect(sheet.locator('.amount-cur').first()).toHaveText('$')
    await sheet.locator('.field input').first().fill('30')
    await expect(sheet.locator('.stake-note')).toHaveText('1.5u')
    await page.keyboard.press('Escape')

    // Back to dollars: everything follows at once, and the choice survives a reload.
    await page.click('.settings-btn')
    await page.locator('.settings-units .seg-btn', { hasText: 'Dollars' }).click()
    await page.keyboard.press('Escape')
    await expect(lifetime.locator('.life-value')).toHaveText('+$180.00')
    await reload(page)
    await expect(lifetime.locator('.life-value')).toHaveText('+$180.00')
  })

  test('units need a unit size; clearing it turns units off with it', async ({ page }) => {
    await boot(page)
    await page.click('.settings-btn')
    const dialog = page.locator('.settings-modal')
    const unitsBtn = dialog.locator('.settings-units .seg-btn', { hasText: 'Units' })
    await expect(unitsBtn).toBeDisabled()
    await expect(dialog.locator('.settings-row', { has: page.locator('.settings-units') }).locator('.hint')).toHaveText('Set a unit size first.')

    const size = dialog.locator('.settings-unit input')
    await size.fill('25')
    await size.press('Enter')
    await expect(unitsBtn).toBeEnabled()
    await unitsBtn.click()
    await expect(page.locator('.stat-card').nth(1).locator('.life-value')).toHaveText('+7.20u')

    // Cleared: back to dollars, and the queued change says so, so setting a size later doesn't flip units back on.
    await size.fill('')
    await size.press('Enter')
    await expect(page.locator('.stat-card').nth(1).locator('.life-value')).toHaveText('+$180.00')
    // On screen at once; in storage a moment later.
    const queued = () => page.evaluate((uid) => localStorage.getItem(`bettracker:settings-outbox:${uid}`) ?? '', USER.id)
    await expect.poll(queued).toContain('"unitSize":null')
    expect(await queued()).toContain('"showUnits":false')
  })

  test('closing Settings sends back no box nobody typed in, even after the settings changed elsewhere', async ({ page }) => {
    await boot(page, { backend: 'live', settings: { lossLimit: 100, unitSize: 20 } })
    await page.click('.settings-btn')
    const dialog = page.locator('.settings-modal')
    await expect(dialog.locator('.settings-loss input')).toHaveValue('100')
    // Another device raises the limit and changes the unit while this dialog is open.
    await page.evaluate(() => {
      const row = JSON.parse(localStorage.getItem('e2e:settings') ?? '{}') as Record<string, unknown>
      localStorage.setItem('e2e:settings', JSON.stringify({ ...row, loss_limit: 500, unit_size: 25, updated_at: '2026-06-01T00:00:00.000Z' }))
      window.dispatchEvent(new Event('online'))
    })
    await expect(dialog.locator('.settings-loss input')).toHaveValue('500')
    await expect(dialog.locator('.settings-unit input')).toHaveValue('25')
    const writes = await page.evaluate(() => Number(localStorage.getItem('e2e:writes') ?? 0))
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(await page.evaluate(() => Number(localStorage.getItem('e2e:writes') ?? 0))).toBe(writes)
    const row = await page.evaluate(() => JSON.parse(localStorage.getItem('e2e:settings') ?? '{}') as { loss_limit: number; unit_size: number })
    expect(row).toMatchObject({ loss_limit: 500, unit_size: 25 })
  })

  test('a value typed into a settings box is kept when the dialog is closed with Escape', async ({ page }) => {
    await boot(page)
    await page.click('.settings-btn')
    await page.locator('.settings-modal .settings-unit input').fill('10')
    await page.keyboard.press('Escape')
    await expect(page.locator('.settings-modal')).toHaveCount(0)
    await page.click('.settings-btn')
    await expect(page.locator('.settings-modal .settings-unit input')).toHaveValue('10')
    await expect(page.locator('.settings-units .seg-btn', { hasText: 'Units' })).toBeEnabled()
  })
})

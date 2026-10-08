import { expect, test } from '@playwright/test'
import { boot, entry, SEED } from './harness'

// Two open bets on top of the usual seed: one with odds (settles in one tap)
// and one without (the result can't be worked out, so the day opens instead).
const WITH_PENDING = [
  ...SEED,
  entry({ id: 'p1', date: '2026-08-04', amount: 0, status: 'pending', stake: 50, odds: 2, sport: 'NBA' }),
  entry({ id: 'p2', date: '2026-08-05', amount: 0, status: 'pending', stake: 20, sport: 'NFL' })
]

test.describe('pending bets', () => {
  test('stay out of P/L and ROI, and are counted as riding', async ({ page }) => {
    await boot(page, { entries: WITH_PENDING })
    await expect(page.locator('.history-card tbody tr')).toHaveCount(5)
    await expect(page.locator('.history-card tbody tr.is-pending')).toHaveCount(2)
    await expect(page.locator('.history-card tbody tr.is-pending .pill').first()).toHaveText('PENDING')
    // Lifetime P/L and ROI are what the three settled bets alone give.
    await expect(page.locator('.stat-card').nth(1).locator('.life-value')).toHaveText('+$180.00')
    await expect(page.locator('.stat-card').nth(1).locator('.stat-sub')).toContainText('2 pending, $70.00 riding')
    await expect(page.locator('.roi-card .life-value')).toHaveText('-18.2%')
    // The calendar marks the open days rather than scoring them. The seed is
    // in August 2026; walk back to it from whatever month the test runs in.
    for (let i = 0; i < 24; i++) {
      if ((await page.locator('.calendar-card .card-note').textContent())?.startsWith('August 2026')) break
      await page.click('button[aria-label="Previous month"]')
    }
    await expect(page.locator('.cal-cell.pending')).toHaveCount(2)
  })

  test('settle in one tap from the history when stake and odds give the result', async ({ page }) => {
    await boot(page, { entries: WITH_PENDING })
    const row = page.locator('.history-card tbody tr', { hasText: 'Aug 4, 2026' })
    await row.locator('.settle-btn.win').click()
    await expect(row.locator('.pill')).toHaveText('WON')
    // $50 at 2.00 wins $50; ROI moves from -20/110 to +30/160.
    await expect(row.locator('.td-amt')).toHaveText('+$50.00')
    await expect(page.locator('.roi-card .life-value')).toHaveText('+18.8%')
    await expect(page.locator('.sync-badge')).toHaveText('Offline · 1 queued')
    await expect(page.locator('.toast')).toContainText('Settled as won')
  })

  test('open the day instead when a win cannot be worked out (no odds)', async ({ page }) => {
    await boot(page, { entries: WITH_PENDING })
    const row = page.locator('.history-card tbody tr', { hasText: 'Aug 5, 2026' })
    await row.locator('.settle-btn.win').click()
    const dialog = page.locator('.day-modal')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.day-sub')).toContainText('1 pending')
    // A loss needs no odds: it is one tap even here.
    await page.keyboard.press('Escape')
    await row.locator('.settle-btn.loss').click()
    await expect(row.locator('.pill')).toHaveText('LOST')
    await expect(row.locator('.td-amt')).toHaveText('-$20.00')
  })

  test('the form can log a pending bet, and requires a stake for a new one', async ({ page }) => {
    await boot(page)
    await page.click('text=Log today')
    const dialog = page.locator('.day-modal')
    await dialog.locator('.seg-btn.pending').click()
    const add = dialog.locator('button[type=submit]')
    await expect(add).toBeDisabled()
    await dialog.locator('.field').nth(0).locator('input').fill('35')
    await expect(add).toBeEnabled()
    await add.click()
    await expect(page.locator('.toast')).toContainText('Logged a pending bet')
    await expect(dialog.locator('.bet-item .bet-amt')).toHaveText('PENDING')
    await expect(dialog.locator('.bet-item .bet-stake')).toContainText('$35.00 riding')
  })
})

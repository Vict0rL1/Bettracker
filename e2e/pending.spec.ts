import { expect, test } from '@playwright/test'
import { boot, entry, menu, SEED } from './harness'

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
    await expect(page.locator('.pl-card').locator('.life-value')).toHaveText('+$180.00')
    await expect(page.locator('.roi-card .life-value')).toHaveText('-18.2%')
    // What is riding is said once, on the pending card; the P/L line counts bets and days only.
    await expect(page.locator('.pl-card').locator('.stat-sub')).toHaveText('5 bets over 5 days since Aug 2026')
    await expect(page.locator('.pending-card .key-value')).toHaveText('2')
    await expect(page.locator('.pending-card .key-sub')).toHaveText('$70.00 at risk · 2 past their date')
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

  test('the header counts open bets and the panel settles them in one tap, flagging past dates', async ({ page }) => {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
    await boot(page, { entries: [...WITH_PENDING, entry({ id: 'p3', date: soon, amount: 0, status: 'pending', stake: 10, odds: 3 })] })
    // The menu button carries the count, closed; the menu's item opens the panel.
    const btn = page.locator('.menu-btn')
    await expect(btn.locator('.pending-badge')).toHaveText('3')
    await expect(btn).toHaveAttribute('aria-label', 'Menu · 3 pending bets')
    await menu(page, '.pending-btn')
    const panel = page.locator('.pending-modal')
    await expect(panel.locator('.pend-item')).toHaveCount(3)
    // Oldest first; the two August bets are past due, the one three days out is not.
    await expect(panel.locator('.pend-item').first()).toContainText('Aug 4, 2026')
    await expect(panel.locator('.pend-item.is-past')).toHaveCount(2)
    await expect(panel.locator('.pend-item').last()).not.toHaveClass(/is-past/)
    await expect(panel.locator('.day-sub')).toHaveText('3 bets · $80.00 riding · 2 past due')

    await panel.locator('.pend-item').first().locator('.settle-btn.win').click()
    await expect(panel.locator('.pend-item')).toHaveCount(2)
    await expect(btn.locator('.pending-badge')).toHaveText('2')
    await expect(page.locator('.toast')).toContainText('Settled as won')
    await expect(page.locator('.sync-badge')).toHaveText('Offline · 1 queued')

    // A win with no odds cannot be worked out: the day opens instead.
    await panel.locator('.pend-item').first().locator('.settle-btn.win').click()
    await expect(page.locator('.day-modal')).toBeVisible()
    await expect(panel).toHaveCount(0)
  })

  test('the form can log a pending bet, and requires a stake for a new one', async ({ page }) => {
    await boot(page)
    // The whole day: today on the calendar.
    await page.locator('.cal-cell.is-today').click()
    const dialog = page.locator('.day-modal')
    await dialog.locator('.seg-btn.pending').click()
    const add = dialog.locator('button[type=submit]')
    // Not a dead button: a sentence next to the stake, which gets the focus.
    await add.click()
    const stake = dialog.locator('.field').nth(0).locator('input')
    await expect(stake).toBeFocused()
    await expect(stake).toHaveAttribute('aria-invalid', 'true')
    await expect(dialog.locator('.field-error')).toHaveText('Enter the stake (0 for a free bet).')
    expect(await stake.evaluate((el) => document.getElementById(el.getAttribute('aria-describedby')?.split(' ')[0] ?? '')?.textContent)).toBe('Enter the stake (0 for a free bet).')
    await stake.fill('35')
    await add.click()
    await expect(page.locator('.toast')).toContainText('Logged a pending bet')
    await expect(dialog.locator('.bet-item .bet-amt')).toHaveText('PENDING')
    await expect(dialog.locator('.bet-item .bet-stake')).toContainText('$35.00 riding')
  })
})

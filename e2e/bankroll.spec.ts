import { expect, test } from '@playwright/test'
import { boot, entry, move, reload, SEED, USER } from './harness'

const pad = (n: number): string => String(n).padStart(2, '0')
const now = new Date()
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

// The usual seed nets +$180 settled. With a $1,000 start the bankroll is $1,180.
const START = { startingBankroll: 1000 }

test.describe('bankroll', () => {
  test('adds up from the start, deposits, withdrawals and settled bets, offline, with Undo', async ({ page }) => {
    // A device that has loaded its settings (none changed yet) and its (empty)
    // list of deposits and withdrawals before going offline.
    await boot(page, { settings: {}, moves: [] })
    const mini = page.locator('.mini-bankroll')
    await expect(mini.locator('.mini-value')).toHaveText('—')
    await mini.click()
    const dialog = page.locator('.bank-modal')
    await expect(dialog).toHaveAttribute('aria-modal', 'true')

    const start = dialog.locator('.bank-start input')
    await start.fill('1000')
    await start.press('Enter')
    await expect(dialog.locator('.bank-total dd')).toHaveText('$1,180.00')

    await dialog.locator('.move-amount').fill('500')
    await dialog.locator('.move-note').fill('payday')
    await dialog.locator('.move-save').click()
    await expect(page.locator('.toast')).toContainText('Added a deposit')
    await expect(dialog.locator('.bank-total dd')).toHaveText('$1,680.00')

    await dialog.locator('.move-kind-btn', { hasText: 'Withdrawal' }).click()
    await dialog.locator('.move-amount').fill('120.50')
    await dialog.locator('.move-save').click()
    await expect(dialog.locator('.bank-total dd')).toHaveText('$1,559.50')
    await expect(dialog.locator('.move-item')).toHaveCount(2)
    // Money in and out is never painted as a win or a loss.
    await expect(dialog.locator('.move-item').first().locator('.move-amt')).toHaveText('-$120.50')

    // Deleting asks twice, and the toast offers it back.
    const del = dialog.locator('.move-item').first().locator('.btn-icon.danger')
    await del.click()
    await del.click()
    await expect(dialog.locator('.bank-total dd')).toHaveText('$1,680.00')
    await page.locator('.toast-action').click()
    await expect(dialog.locator('.bank-total dd')).toHaveText('$1,559.50')

    await page.keyboard.press('Escape')
    await expect(mini.locator('.mini-value')).toHaveText('$1,560')

    // Everything was kept on the device.
    await reload(page)
    await expect(mini.locator('.mini-value')).toHaveText('$1,560')
    const queued = await page.evaluate((uid) => localStorage.getItem(`bettracker:moves-outbox:${uid}`), USER.id)
    expect(queued).toContain('"amount":500')
    expect(queued).toContain('"amount":-120.5')
  })

  test('a stake above 5% of the bankroll is flagged, and never blocked', async ({ page }) => {
    await boot(page, { settings: START, moves: [] })
    await page.click('.fab')
    const sheet = page.locator('.quick-modal')
    const note = sheet.locator('.stake-note')
    const lost = sheet.locator('.seg-btn.loss')
    const stake = sheet.locator('.field input').first()
    await stake.fill('')
    await expect(note).toHaveText('Bankroll $1,180')
    // Measured once the sheet has finished opening.
    await page.waitForFunction(() => document.getAnimations().length === 0)
    const before = await lost.boundingBox()

    await stake.fill('59')
    await expect(note).toHaveText('5.0% of your $1,180 bankroll')
    await expect(note).not.toHaveClass(/over/)
    await stake.fill('59.01')
    await expect(note).toHaveText('5.1% of your $1,180 bankroll · over 5%')
    await expect(note).toHaveClass(/over/)
    // Whatever the note says, the result buttons stay where they were.
    expect(await lost.boundingBox()).toEqual(before)

    await lost.click()
    await expect(page.locator('.toast')).toContainText('Added a bet')
  })

  test('the day form measures a bet still riding, not one settled in the past', async ({ page }) => {
    await boot(page, { settings: START, moves: [] })
    await page.locator('.history-card tbody tr').last().locator('.td-actions .btn-icon').first().click()
    const modal = page.locator('.day-modal')
    await modal.locator('.field input').first().fill('100')
    // Aug 1 is past and the form says WON: history, nothing to measure.
    await expect(modal.locator('.stake-note')).toHaveText('')
    await modal.locator('.bet-form .seg-btn.pending').click()
    await expect(modal.locator('.stake-note')).toHaveText('8.5% of your $1,180 bankroll · over 5%')
  })

  test('the chart draws the bankroll, with the money put in as a dashed line', async ({ page }) => {
    await boot(page, { settings: START, moves: [move({ id: 'd1', date: '2026-08-02', amount: 500 })] })
    const card = page.locator('.chart-card')
    await card.locator('.chart-view .scope-btn', { hasText: 'Bankroll' }).click()
    await expect(card.locator('h2')).toHaveText('Bankroll')
    await expect(card.locator('.recharts-wrapper')).toHaveCount(1)
    await expect(card.locator('.chart-legend li')).toHaveText(['Bankroll', 'Put in'])
    // The view is remembered on this device.
    await reload(page)
    await expect(card.locator('.chart-view .scope-btn', { hasText: 'Bankroll' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('with nothing set up, the chart offers to set it up, and Settings leads there too', async ({ page }) => {
    await boot(page, { settings: {}, moves: [] })
    const card = page.locator('.chart-card')
    await card.locator('.chart-view .scope-btn', { hasText: 'Bankroll' }).click()
    await card.locator('.chart-setup .btn').click()
    await expect(page.locator('.bank-modal')).toHaveCount(1)
    await page.keyboard.press('Escape')

    await page.click('.settings-btn')
    await expect(page.locator('.settings-bankroll-value')).toHaveText('Not set')
    await page.locator('.settings-bankroll .btn').click()
    // One dialog at a time.
    await expect(page.locator('.modal')).toHaveCount(1)
    await expect(page.locator('.bank-modal')).toHaveCount(1)
    // Shortcuts stay off while it is open.
    await page.locator('.bank-modal .stat-label').click()
    await page.keyboard.press('t')
    await expect(page.locator('.quick-modal')).toHaveCount(0)
  })

  test('before migration 005 a deposit waits on the device, and syncs once it runs', async ({ page }) => {
    await boot(page, { backend: 'behind-005', settings: START })
    const badge = page.locator('.sync-badge')
    await expect(badge).toHaveText('Synced')
    // The missing table is not an error on read.
    await expect(page.locator('.toast')).toHaveCount(0)
    await expect(page.locator('.mini-bankroll .mini-value')).toHaveText('$1,180')

    await page.locator('.mini-bankroll').click()
    const dialog = page.locator('.bank-modal')
    await dialog.locator('.move-amount').fill('500')
    await dialog.locator('.move-save').click()
    await expect(badge).toHaveText('Update needed · 1 queued')
    await expect(page.locator('.toast')).toContainText('Your database is behind the app')
    await expect(dialog.locator('.settings-sync')).toHaveText('Saved on this device — syncs once your database is updated.')
    await expect(dialog.locator('.bank-total dd')).toHaveText('$1,680.00')
    await page.keyboard.press('Escape')

    // Signing out now would delete it from this device: the first click says so.
    const signOut = page.locator('.btn-signout')
    await signOut.click()
    await expect(signOut).toHaveText('Sign out anyway?')
    await expect(page.locator('.history-card')).toHaveCount(1)

    await reload(page)
    await expect(badge).toHaveText('Update needed · 1 queued')
    await page.evaluate(() => {
      localStorage.setItem('e2e:migrated-005', '1')
      window.dispatchEvent(new Event('online'))
    })
    await expect(badge).toHaveText('Synced')
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('e2e:moves') ?? '[]') as { amount: number }[])
    expect(stored).toHaveLength(1)
    expect(Number(stored[0].amount)).toBe(500)
  })

  test('a bet logged today counts once it settles, not while it is riding', async ({ page }) => {
    const riding = entry({ id: 'r', date: today, amount: 0, status: 'pending', stake: 40 })
    await boot(page, { entries: [...SEED, riding], settings: START, moves: [] })
    const mini = page.locator('.mini-bankroll')
    await expect(mini.locator('.mini-value')).toHaveText('$1,180')
    await expect(mini.locator('.mini-sub')).toHaveText('$40.00 riding')
  })
})

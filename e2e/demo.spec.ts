import { expect, test, type Page } from '@playwright/test'

// `npm run demo` as built (see playwright.config.ts): no Supabase anywhere and
// no harness, only the demo's own fake backend in the browser.
test.use({ baseURL: 'http://localhost:4172' })

const storedBets = (page: Page): Promise<number> =>
  page.evaluate(() => (JSON.parse(localStorage.getItem('demo:rows') ?? '[]') as unknown[]).length)

async function addLoss(page: Page, stake: string): Promise<void> {
  await page.click('.fab')
  const sheet = page.locator('.quick-modal')
  await sheet.locator('.field input').first().fill(stake)
  await sheet.locator('.seg-btn.loss').click()
  await expect(page.locator('.toast')).toContainText('Added a bet')
}

test.describe('demo', () => {
  test('opens signed in with nothing in it, and keeps what you add across reloads', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.demo-banner')).toContainText('everything is kept in this browser only')
    await expect(page.locator('.mini-bankroll .mini-value')).toHaveText('—')
    await expect(page.locator('.history-card tbody tr')).toHaveCount(0)

    await addLoss(page, '20')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    expect(await storedBets(page)).toBe(1)

    await page.reload()
    await expect(page.locator('.history-card tbody tr')).toHaveCount(1)
    await expect(page.locator('.history-card tbody tr').first().locator('.td-amt')).toHaveText('-$20.00')
  })

  test('signing out leads to the sign-in screen, and any email and password lead back to the same data', async ({ page }) => {
    await page.goto('/')
    await addLoss(page, '20')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')

    await page.locator('.btn-signout').click()
    const form = page.locator('.auth-card')
    await expect(form).toBeVisible()
    // Still signed out after a reload: the fake server remembers it.
    await page.reload()
    await expect(form).toBeVisible()

    await form.locator('input[type=email]').fill('someone@example.com')
    await form.locator('input[type=password]').fill('anything')
    await form.locator('.auth-submit').click()
    await expect(page.locator('.history-card tbody tr')).toHaveCount(1)
  })

  test('with the connection off, a change waits on the device and syncs when it is back', async ({ page, context }) => {
    await page.goto('/')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    await context.setOffline(true)
    await addLoss(page, '15')
    await expect(page.locator('.sync-badge')).toHaveText('Offline · 1 queued')
    expect(await storedBets(page)).toBe(0)

    await context.setOffline(false)
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    expect(await storedBets(page)).toBe(1)
  })

  // Signing out on another device ends the session on this one too. A change
  // that went out without it used to be refused, dropped from the queue, and
  // lost; now it waits for the session to come back.
  test('a change made after the session ended elsewhere waits for it, instead of being lost', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    await page.evaluate(() => localStorage.setItem('demo:signed-out', '1'))

    await addLoss(page, '15')
    await expect(page.locator('.sync-badge')).toHaveText('Offline · 1 queued')
    await expect(page.locator('.history-card tbody tr')).toHaveCount(1)
    expect(await storedBets(page)).toBe(0)

    // The session is back (signed in again): the queued bet goes through.
    await page.evaluate(() => {
      localStorage.removeItem('demo:signed-out')
      window.dispatchEvent(new Event('online'))
    })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    expect(await storedBets(page)).toBe(1)
  })

  test('starts as an up-to-date database: a deposit syncs', async ({ page }) => {
    await page.goto('/')
    await page.locator('.mini-bankroll').click()
    const dialog = page.locator('.bank-modal')
    await dialog.locator('.move-amount').fill('500')
    await dialog.locator('.move-save').click()
    await expect(page.locator('.toast')).toContainText('Added a deposit')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    expect(await page.evaluate(() => (JSON.parse(localStorage.getItem('demo:moves') ?? '[]') as unknown[]).length)).toBe(1)
  })

  test('Start over takes back its question after a few seconds', async ({ page }) => {
    await page.goto('/')
    await addLoss(page, '20')
    const reset = page.locator('.demo-reset')
    await reset.click()
    await expect(reset).toHaveText('Delete everything?')
    await expect(reset).toHaveText('Start over', { timeout: 8000 })
    // So the next click only asks again.
    await reset.click()
    await expect(reset).toHaveText('Delete everything?')
    await expect(page.locator('.history-card tbody tr')).toHaveCount(1)
  })

  test('Start over asks twice, then empties the demo', async ({ page }) => {
    await page.goto('/')
    await addLoss(page, '20')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')

    const reset = page.locator('.demo-reset')
    await reset.click()
    await expect(reset).toHaveText('Delete everything?')
    await expect(page.locator('.history-card tbody tr')).toHaveCount(1)
    await reset.click()

    await expect(page.locator('.demo-reset')).toHaveText('Start over')
    await expect(page.locator('.history-card tbody tr')).toHaveCount(0)
    expect(await storedBets(page)).toBe(0)
  })
})

test.describe('the real app', () => {
  // The production build the rest of the suite runs (see playwright.config.ts), here without the harness.
  test.use({ baseURL: 'http://localhost:4173' })

  test('has none of the demo in it: no bar, no fake backend, so signed out it asks you to sign in', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.auth-card')).toBeVisible()
    await expect(page.locator('.demo-banner')).toHaveCount(0)
    expect(await page.evaluate(() => '__supabaseMock' in window)).toBe(false)
  })
})

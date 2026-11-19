import { expect, test, type Page } from '@playwright/test'
import { APP_URL, DEMO_URL } from './urls'
import { addBet, forbidRates, menu, openScan, scanFile } from './harness'

// `npm run demo` as built (see playwright.config.ts): no Supabase anywhere and
// no harness, only the demo's own fake backend in the browser.
test.use({ baseURL: DEMO_URL })

// The demo asks the real exchange-rate service when an expense is in another currency. None of these is: a request to
// it fails the test (and the suite's browser can't reach it anyway: playwright.config.ts).
test.beforeEach(({ context }) => forbidRates(context))

const storedBets = (page: Page): Promise<number> =>
  page.evaluate(() => (JSON.parse(localStorage.getItem('demo:rows') ?? '[]') as unknown[]).length)
const storedExpenses = (page: Page): Promise<number> =>
  page.evaluate(() => (JSON.parse(localStorage.getItem('demo:expenses') ?? '[]') as unknown[]).length)

async function addLoss(page: Page, stake: string): Promise<void> {
  await addBet(page)
  const sheet = page.locator('.quick-modal')
  await sheet.locator('.field input').first().fill(stake)
  await sheet.locator('.seg-btn.loss').click()
  await expect(page.locator('.toast')).toContainText('Added a bet')
}

test.describe('demo', () => {
  test('opens signed in with nothing in it, and keeps what you add across reloads', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.demo-banner')).toContainText('everything is kept in this browser only')
    await expect(page.locator('.bankroll-card .key-value')).toHaveText('—')
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

    await menu(page, '.btn-signout')
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

  // "Start over" in one window left the other showing the demo account, which
  // it had cleared: a bet added there said "Added" and was stored nowhere.
  test('Start over in one window signs the other out, and a bet added there once signed in is kept', async ({ page, context }) => {
    await page.goto('/')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const other = await context.newPage()
    await other.goto('/')
    await expect(other.locator('.sync-badge')).toHaveText('Synced')

    const reset = page.locator('.demo-reset')
    await reset.click()
    await reset.click()
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const form = other.locator('.auth-card')
    await expect(form).toBeVisible()

    await form.locator('input[type=email]').fill('someone@example.com')
    await form.locator('input[type=password]').fill('anything')
    await form.locator('.auth-submit').click()
    await addLoss(other, '66')
    await expect(other.locator('.sync-badge')).toHaveText('Synced')
    await other.reload()
    await expect(other.locator('.history-card tbody tr', { hasText: '-$66.00' })).toHaveCount(1)
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
  // lost; and with no way back but signing out, which wipes the queue.
  test('a change made after the session ended elsewhere waits for a new sign-in, which sends it', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    await page.context().setOffline(true)
    await addLoss(page, '15')
    // Signed out on another device meanwhile: this one's session ends.
    await page.evaluate(() => (window as unknown as { __supabaseMock: { __endSession(): void } }).__supabaseMock.__endSession())
    await page.context().setOffline(false)

    await expect(page.locator('.sync-badge')).toHaveText('Signed out · 1 queued')
    await expect(page.locator('.signed-out-notice')).toContainText('1 change wait here')
    await expect(page.locator('.history-card tbody tr')).toHaveCount(1)
    expect(await storedBets(page)).toBe(0)

    // Sign in again, without signing out: the queue is still there and goes.
    await page.locator('.notice-sign-in').click()
    const form = page.locator('.auth-card')
    await form.locator('input[type=email]').fill('demo@example.com')
    await form.locator('input[type=password]').fill('anything')
    await form.locator('.auth-submit').click()
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    expect(await storedBets(page)).toBe(1)
  })

  test('the way back to the sign-in form also leads back to this device’s data', async ({ page }) => {
    await page.goto('/')
    await addLoss(page, '15')
    await page.evaluate(() => (window as unknown as { __supabaseMock: { __endSession(): void } }).__supabaseMock.__endSession())
    await page.locator('.notice-sign-in').click()
    await page.locator('.login-back').click()
    await expect(page.locator('.history-card tbody tr')).toHaveCount(1)
  })

  // The toast said "will sync when you're back online", with the connection
  // fine and the session gone.
  test('a change made once the session has ended says it waits for a sign-in', async ({ page }) => {
    await page.goto('/')
    // Signed in first: a session that has ended before the app reads it opens on the sign-in screen.
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    await page.evaluate(() => (window as unknown as { __supabaseMock: { __endSession(): void } }).__supabaseMock.__endSession())
    await expect(page.locator('.sync-badge')).toHaveText('Signed out')
    await addLoss(page, '15')
    await expect(page.locator('.toast')).toContainText('will sync once you sign in again')
  })

  // A key or URL in .env was written into the demo's bundle (and the demo is
  // served on the local network).
  test('carries nothing of .env in its bundle', async ({ page }) => {
    const html = await (await page.request.get('/')).text()
    const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1])
    expect(scripts.length).toBeGreaterThan(0)
    for (const src of scripts) {
      const js = await (await page.request.get(src)).text()
      expect(js).not.toContain('demomustnotshipthis')
      expect(js).not.toContain('demo_must_not_ship_this')
    }
  })

  test('starts as an up-to-date database: a deposit syncs', async ({ page }) => {
    await page.goto('/')
    await page.locator('.bankroll-card').click()
    const dialog = page.locator('.bank-modal')
    await dialog.locator('.move-amount').fill('500')
    await dialog.locator('.move-save').click()
    await expect(page.locator('.toast')).toContainText('Added a deposit')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    expect(await page.evaluate(() => (JSON.parse(localStorage.getItem('demo:moves') ?? '[]') as unknown[]).length)).toBe(1)
  })

  test('scanning a receipt shows a sample, says the image stays here, and adds what is ticked', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    await page.locator('.view-tab-expenses').click()
    await openScan(page)
    // No Anthropic and no Supabase here: the demo says so before anything is picked.
    await expect(page.locator('.exp-privacy')).toHaveText('Demo: the image stays on this device and a sample result is shown.')
    await page.setInputFiles('.exp-scan-input', scanFile)
    await expect(page.locator('.exp-sample')).toHaveText('Demo: a sample result, your image was not read.')
    await expect(page.locator('.exp-review-row')).toHaveCount(2)
    await page.locator('.exp-review-add').click()
    await expect(page.locator('.toast')).toContainText('2 expenses added')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    await expect.poll(() => storedExpenses(page)).toBe(2)
  })

  // Two months of a made-up person's bets and expenses, to look at the app full before any real data goes in.
  test('Load sample data fills an empty demo at once and comes back on the same view: bets, cards, expenses in CAD with some paid in USD, budgets near and over', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    await page.locator('.view-tab-expenses').click()
    await page.waitForSelector('.exp-first')

    // Nothing to lose yet: one click, no question.
    await page.locator('.demo-sample').click()
    await page.waitForSelector('.exp-bar')
    await expect(page.locator('.view-tab-expenses')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    expect(await storedBets(page)).toBe(66)
    // Last month whole (28) and this one up to today (4 on its 1st alone).
    expect(await storedExpenses(page)).toBeGreaterThanOrEqual(32)

    // The Expenses view of a real month: Canadian dollars, two cards, a budget near its limit and one over it.
    await expect(page.locator('.exp-currency-code [aria-hidden]')).toHaveText('CAD')
    await expect(page.locator('.spend-card-name').nth(0)).toHaveText('Visa TD')
    await expect(page.locator('.spend-card-name').nth(1)).toHaveText('Amex Cobalt')
    await expect(page.locator('.budget-row')).toHaveCount(4)
    await expect(page.locator('.budget-row.is-near')).toHaveAttribute('data-target', 'subscriptions')
    await expect(page.locator('.budget-row.is-over')).toHaveAttribute('data-target', 'entertainment')
    await expect(page.locator('.spend-vs')).toBeVisible()
    // Paid in US dollars on the 1st: what was paid shows beside its amount in CAD, and its rate is stored with it.
    const dropbox = page.locator('.exp-row', { hasText: 'Dropbox' })
    await expect(dropbox.locator('.exp-amount-main')).toHaveText('$16.83')
    await expect(dropbox.locator('.exp-original [aria-hidden]')).toHaveText('USD 11.99')
    const usd = await page.evaluate(() => (JSON.parse(localStorage.getItem('demo:expenses') ?? '[]') as Record<string, unknown>[]).filter((r) => r.original_currency === 'USD'))
    expect(usd.length).toBeGreaterThanOrEqual(5)
    for (const r of usd) {
      expect(typeof r.original_amount).toBe('number')
      expect(r.fx_rate as number).toBeGreaterThanOrEqual(1.38)
      expect(r.fx_rate as number).toBeLessThanOrEqual(1.41)
    }
    // Last month too: a refund in green and rows read by AI.
    await page.locator('.exp-month-nav .nav-btn').first().click()
    await expect(page.locator('.exp-row')).toHaveCount(28)
    await expect(page.locator('.exp-row .exp-amount.refund')).toHaveText(/-\$25\.00/)
    await expect(page.locator('.exp-row .exp-ai')).toHaveCount(2)

    // The bets: sixty, four still open, and six casino plays that net to nothing; the bankroll from its start, the deposit and what was won.
    await page.locator('.view-tab-bets').click()
    await expect(page.locator('.history-card tbody tr')).toHaveCount(25)
    await expect(page.locator('.history-card')).toContainText('66 bets')
    await expect(page.locator('.bankroll-card .key-value')).toHaveText('$836.40')
    expect(await page.evaluate(() => (JSON.parse(localStorage.getItem('demo:rows') ?? '[]') as { status: string }[]).filter((r) => r.status === 'pending').length)).toBe(4)
    expect(await page.evaluate(() => (JSON.parse(localStorage.getItem('demo:moves') ?? '[]') as unknown[]).length)).toBe(1)

    // It is ordinary data from here on: an edit syncs, and survives a reload.
    await addLoss(page, '20')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    expect(await storedBets(page)).toBe(67)
    await page.reload()
    await expect(page.locator('.history-card')).toContainText('67 bets')
  })

  test('Load sample data asks first when the demo already holds data, takes its question back, and then replaces everything', async ({ page }) => {
    await page.goto('/')
    await addLoss(page, '77')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')

    const sample = page.locator('.demo-sample')
    await expect(sample).toHaveText('Load sample data')
    await sample.click()
    await expect(sample).toHaveText('Replace everything?')
    // Nothing was touched by the question, and asking Start over instead drops it.
    expect(await storedBets(page)).toBe(1)
    await page.locator('.demo-reset').click()
    await expect(page.locator('.demo-reset')).toHaveText('Delete everything?')
    await expect(sample).toHaveText('Load sample data')
    await expect(page.locator('.demo-reset')).toHaveText('Start over', { timeout: 8000 })
    await expect(page.locator('.history-card tbody tr')).toHaveCount(1)

    await sample.click()
    await expect(sample).toHaveText('Replace everything?')
    await sample.click()
    await expect(page.locator('.history-card')).toContainText('66 bets')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    expect(await storedBets(page)).toBe(66)
    // The bet that was there is gone, on the server and on this device.
    await expect(page.locator('.history-card tbody tr', { hasText: '-$77.00' })).toHaveCount(0)
    expect(await page.evaluate(() => (JSON.parse(localStorage.getItem('demo:rows') ?? '[]') as { amount: number }[]).some((r) => r.amount === -77))).toBe(false)

    // Loaded again over itself: the same sixty-six, never a second set.
    await sample.click()
    await expect(sample).toHaveText('Replace everything?')
    await sample.click()
    await expect(page.locator('.history-card')).toContainText('66 bets')
    expect(await storedBets(page)).toBe(66)
    // And Start over still empties it all.
    await page.locator('.demo-reset').click()
    await page.locator('.demo-reset').click()
    await expect(page.locator('.history-card tbody tr')).toHaveCount(0)
    expect(await storedBets(page)).toBe(0)
    expect(await storedExpenses(page)).toBe(0)
  })

  test('in Spanish the sample’s few words are Spanish', async ({ page }) => {
    await page.addInitScript(() => {
      if (!localStorage.getItem('bettracker:lang')) localStorage.setItem('bettracker:lang', 'es')
    })
    await page.goto('/')
    await expect(page.locator('.sync-badge')).toHaveText('Sincronizado')
    await expect(page.locator('.demo-sample')).toHaveText('Cargar datos de ejemplo')
    await page.locator('.demo-sample').click()
    await expect(page.locator('.history-card')).toContainText('66 apuestas')
    await page.locator('.view-tab-expenses').click()
    await expect(page.locator('.exp-row', { hasText: 'Ticketmaster' }).locator('.exp-note')).toHaveText('entradas del concierto')
    // Now there is something to lose: it asks, in Spanish.
    await page.locator('.demo-sample').click()
    await expect(page.locator('.demo-sample')).toHaveText('¿Reemplazar todo?')
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
    // An expense on the demo's server too (as one synced from the Expenses view).
    await page.evaluate(() =>
      localStorage.setItem(
        'demo:expenses',
        JSON.stringify([{ id: '10000000-0000-4000-8000-000000000001', user_id: 'demo', date: '2026-11-17', amount: '4.50', card_id: null, merchant: 'Café', category: 'coffee', note: '', source: 'manual', created_at: '2026-11-17T09:00:00.000Z', updated_at: '2026-11-17T09:00:00.000Z' }])
      )
    )
    expect(await storedExpenses(page)).toBe(1)

    const reset = page.locator('.demo-reset')
    await reset.click()
    await expect(reset).toHaveText('Delete everything?')
    await expect(page.locator('.history-card tbody tr')).toHaveCount(1)
    await reset.click()

    await expect(page.locator('.demo-reset')).toHaveText('Start over')
    await expect(page.locator('.history-card tbody tr')).toHaveCount(0)
    expect(await storedBets(page)).toBe(0)
    expect(await storedExpenses(page)).toBe(0)
  })
})

/** Every script of the build served at `base`: the page's own, and the chunks those name (loaded on demand). */
async function bundle(page: Page, base: string): Promise<string> {
  const html = await (await page.request.get(`${base}/`)).text()
  const seen = new Set<string>()
  const queue = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1].replace(/^\//, ''))
  let all = ''
  while (queue.length > 0) {
    const src = queue.pop() as string
    if (seen.has(src)) continue
    seen.add(src)
    const res = await page.request.get(`${base}/${src}`)
    if (!res.ok()) continue
    const js = await res.text()
    all += js
    for (const m of js.matchAll(/["'`](?:\.\/|assets\/)?([\w.-]+\.js)["'`]/g)) queue.push(`assets/${m[1]}`)
  }
  expect(seen.size).toBeGreaterThan(1)
  return all
}

// The sample data is the demo's alone: its merchants and its ids' seed are in no script of the real app.
test('the sample data is in the demo’s bundle and in none of the real app’s scripts', async ({ page }) => {
  const marks = ['Tacos Frida', 'demo-sample|', 'Amex Cobalt']
  const demo = await bundle(page, DEMO_URL)
  for (const mark of marks) expect(demo, `the demo has "${mark}"`).toContain(mark)
  const app = await bundle(page, APP_URL)
  // The real app's scripts were really read: its own words are there.
  expect(app).toContain('expense-budget|')
  for (const mark of marks) expect(app, `the real app has no "${mark}"`).not.toContain(mark)
})

test.describe('the real app', () => {
  // The production build the rest of the suite runs (see playwright.config.ts), here without the harness.
  test.use({ baseURL: APP_URL })

  test('has none of the demo in it: no bar, no fake backend, so signed out it asks you to sign in', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.auth-card')).toBeVisible()
    await expect(page.locator('.demo-banner')).toHaveCount(0)
    expect(await page.evaluate(() => '__supabaseMock' in window)).toBe(false)
  })
})

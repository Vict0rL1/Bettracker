import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { boot, entry, install, move, reload, USER, type SeedEntry } from './harness'

// The sync engine where real servers and real devices misbehave: several
// windows sharing one storage, a storage that is full, a server that fails
// for now or for good, an import cut halfway, a server that answers fewer
// rows than asked, an edit made while an older one is out. Each of these
// lost or wiped changes before (see each test).

type Row = Record<string, unknown> & { id: string }

const serverRows = (page: Page): Promise<Row[]> => page.evaluate(() => JSON.parse(localStorage.getItem('e2e:rows') ?? '[]') as Row[])
const serverMoves = (page: Page): Promise<Row[]> => page.evaluate(() => JSON.parse(localStorage.getItem('e2e:moves') ?? '[]') as Row[])
const serverSettings = (page: Page): Promise<Row | null> => page.evaluate(() => JSON.parse(localStorage.getItem('e2e:settings') ?? 'null') as Row | null)

/** The fake server's connection: down for every window of the context, and back. */
const setDown = (page: Page, down: boolean): Promise<void> =>
  page.evaluate((d) => (d ? localStorage.setItem('e2e:down', '1') : localStorage.removeItem('e2e:down')), down)

/** A second window of the app, on the same storage (same browser profile). */
async function secondWindow(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  await page.goto('/')
  await page.waitForSelector('.history-card')
  return page
}

async function logLoss(page: Page, stake: string): Promise<void> {
  await page.click('.fab')
  const sheet = page.locator('.quick-modal')
  await sheet.locator('.field input').first().fill(stake)
  await sheet.locator('.seg-btn.loss').click()
  await expect(sheet).toHaveCount(0)
}

const queuedBets = (page: Page): Promise<number> =>
  page.evaluate((uid) => (JSON.parse(localStorage.getItem(`bettracker:outbox:${uid}`) ?? '[]') as unknown[]).length, USER.id)

test.describe('several windows of the app', () => {
  // Each window wrote back the queue it had read at startup: the last write
  // wiped what the other had queued, and closing that one lost it for good.
  test('two windows each queue a bet offline; with one closed, the other sends both', async ({ page, context }) => {
    await boot(page, { backend: 'live' })
    const other = await secondWindow(context)
    await setDown(page, true)

    await logLoss(page, '11')
    await logLoss(other, '22')
    await expect.poll(() => queuedBets(page)).toBe(2)
    await page.close()

    await setDown(other, false)
    await other.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(other.locator('.sync-badge')).toHaveText('Synced')
    const stakes = (await serverRows(other)).map((r) => r.stake).filter((s) => s === 11 || s === 22)
    expect(stakes.sort()).toEqual([11, 22])
  })

  test('a bet queued in one window shows, queued, in the other', async ({ page, context }) => {
    await boot(page, { backend: 'live' })
    const other = await secondWindow(context)
    await setDown(page, true)
    await logLoss(page, '33')
    await expect(page.locator('.sync-badge')).toHaveText('Offline · 1 queued')
    // The other window hasn't tried the server yet: to it the change is on its way.
    await expect(other.locator('.sync-badge')).toHaveText(/1/)
    await expect(other.locator('.history-card tbody tr')).toHaveCount(4)
  })

  // The other window used to know nothing of the add; with the queue shared,
  // its edit must not be folded into an add already on the wire either.
  test('an edit made in one window while the other is sending the add reaches the server', async ({ page, context }) => {
    await boot(page, { backend: 'live', latencyMs: 1500 })
    const other = await secondWindow(context)
    await logLoss(page, '44')
    // The add is on the wire for a second and a half; the other window edits the bet meanwhile.
    await expect(other.locator('.history-card tbody tr')).toHaveCount(4)
    await other.locator('.history-card tbody tr').first().locator('.td-actions .btn-icon').first().click()
    const modal = other.locator('.day-modal')
    await modal.locator('.bet-item .btn-icon').first().click()
    await modal.locator('.bet-form .field-wide input').fill('edited in the other window')
    await modal.locator('.bet-form .bet-add').click()
    await other.keyboard.press('Escape')

    await expect(page.locator('.sync-badge')).toHaveText('Synced', { timeout: 20_000 })
    await expect(other.locator('.sync-badge')).toHaveText('Synced', { timeout: 20_000 })
    const added = (await serverRows(page)).find((r) => r.stake === 44)
    expect(added?.note).toBe('edited in the other window')
  })

  test('two windows each queue a deposit offline; both reach the server', async ({ page, context }) => {
    await boot(page, { backend: 'live', moves: [] })
    const other = await secondWindow(context)
    await setDown(page, true)
    for (const [win, amount] of [
      [page, '100'],
      [other, '200']
    ] as const) {
      await win.locator('.mini-bankroll').click()
      const dialog = win.locator('.bank-modal')
      await dialog.locator('.move-amount').fill(amount)
      await dialog.locator('.move-save').click()
      await win.keyboard.press('Escape')
    }
    await page.close()
    await setDown(other, false)
    await other.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(other.locator('.sync-badge')).toHaveText('Synced')
    expect((await serverMoves(other)).map((m) => m.amount).sort()).toEqual([100, 200])
  })

  test('two windows each change a different setting offline; both reach the server', async ({ page, context }) => {
    await boot(page, { backend: 'live', settings: { oddsFormat: 'american', defaultStake: 10 } })
    const other = await secondWindow(context)
    await setDown(page, true)

    await page.click('.settings-btn')
    await page.locator('.settings-modal .settings-seg .seg-btn', { hasText: 'Decimal' }).click()
    await page.keyboard.press('Escape')
    await other.click('.settings-btn')
    const stake = other.locator('.settings-modal .settings-stake input')
    await stake.fill('35')
    await stake.press('Enter')
    await other.keyboard.press('Escape')
    // The first window goes away before the connection comes back.
    await page.close()

    await setDown(other, false)
    await other.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect.poll(async () => (await serverSettings(other))?.default_stake, { timeout: 15_000 }).toBe(35)
    await expect.poll(async () => (await serverSettings(other))?.odds_format, { timeout: 15_000 }).toBe('decimal')
  })
})

test.describe('a device whose storage is full', () => {
  /** Every write of a queue fails, as a browser's does when its storage is full; caches still fit. */
  const fillStorage = (page: Page) =>
    page.evaluate(() => {
      const real = Storage.prototype.setItem
      ;(window as unknown as { __realSetItem: typeof real }).__realSetItem = real
      Storage.prototype.setItem = function (k: string, v: string) {
        if (/outbox/.test(k)) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        return real.call(this, k, v)
      }
    })
  const makeRoom = (page: Page) =>
    page.evaluate(() => {
      Storage.prototype.setItem = (window as unknown as { __realSetItem: typeof Storage.prototype.setItem }).__realSetItem
    })

  // Storage errors were swallowed: "Added a bet", the change only in memory,
  // and gone with the window.
  test('says a change is only in this window, keeps it there, and stores it once there is room', async ({ page }) => {
    await boot(page)
    await fillStorage(page)
    await logLoss(page, '55')
    await expect(page.locator('.toast')).toContainText('Not saved on this device')
    await expect(page.locator('.unsaved-notice')).toContainText('1 change couldn’t be saved on this device')
    await expect(page.locator('.history-card tbody tr')).toHaveCount(4)
    expect(await queuedBets(page)).toBe(0)

    await makeRoom(page)
    await page.locator('.notice-save-again').click()
    await expect(page.locator('.unsaved-notice')).toHaveCount(0)
    expect(await queuedBets(page)).toBe(1)
    // Stored: it survives the window. (To make room the cached server rows
    // went; they come back from the server.)
    await reload(page)
    await expect(page.locator('.history-card tbody')).toContainText('-$55.00')
    expect(await queuedBets(page)).toBe(1)
  })

  test('a change only in this window still syncs while it is open', async ({ page }) => {
    await boot(page, { backend: 'live' })
    await setDown(page, true)
    await fillStorage(page)
    await logLoss(page, '66')
    await expect(page.locator('.unsaved-notice')).toBeVisible()
    await setDown(page, false)
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect.poll(async () => (await serverRows(page)).some((r) => r.stake === 66), { timeout: 15_000 }).toBe(true)
    await expect(page.locator('.unsaved-notice')).toHaveCount(0)
  })
})

test.describe('a server that fails', () => {
  const failNext = (page: Page, fail: { status: number; message: string; code?: string; times: number }) =>
    page.evaluate((f) => localStorage.setItem('e2e:fail', JSON.stringify(f)), fail)

  // A 503 or a 429 was read as a refusal for good: the change was dropped.
  test('for now (503): keeps the change, says it is retrying, and sends it once', async ({ page }) => {
    await boot(page, { backend: 'live' })
    await failNext(page, { status: 503, message: 'Service Unavailable', times: 2 })
    await logLoss(page, '77')
    await expect(page.locator('.sync-badge')).toHaveText('Retrying · 1 queued')
    await expect(page.locator('.sync-badge')).toHaveText('Synced', { timeout: 20_000 })
    expect((await serverRows(page)).filter((r) => r.stake === 77)).toHaveLength(1)
  })

  test('for good (400): keeps the change apart, visible after a reload, to send again or let go', async ({ page }) => {
    await boot(page, { backend: 'live' })
    await failNext(page, { status: 400, message: 'new row for relation "entries" violates check constraint "entries_note_check"', code: '23514', times: 1 })
    await logLoss(page, '88')
    const notice = page.locator('.refused-notice')
    await expect(notice).toContainText('Supabase refused 1 change for good')
    await expect(notice).toContainText('entries_note_check')
    await reload(page)
    await expect(notice).toBeVisible()

    await notice.locator('.notice-retry').click()
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    await expect(notice).toHaveCount(0)
    expect((await serverRows(page)).filter((r) => r.stake === 88)).toHaveLength(1)
  })

  test('a refused change let go is gone, and nothing else is', async ({ page }) => {
    await boot(page, { backend: 'live' })
    await failNext(page, { status: 400, message: 'violates check constraint', code: '23514', times: 1 })
    await logLoss(page, '99')
    await page.locator('.refused-notice .notice-discard').click()
    await expect(page.locator('.refused-notice')).toHaveCount(0)
    await reload(page)
    await expect(page.locator('.refused-notice')).toHaveCount(0)
    expect((await serverRows(page)).filter((r) => r.stake === 99)).toHaveLength(0)
    await expect(page.locator('.history-card tbody tr')).toHaveCount(3)
  })
})

test.describe('an import cut halfway', () => {
  // The retry upserted every row again: one that had landed and been edited
  // on another device since got the import's values and an older updated_at.
  test('sends only what did not land, and leaves an edit made elsewhere since as it is', async ({ page }) => {
    await boot(page, { backend: 'live' })
    const lines = Array.from({ length: 300 }, (_, i) => `2026-07-${String((i % 28) + 1).padStart(2, '0')},${i + 1}.00,10.00,NBA,DK,Spread,row ${i}`)
    const csv = ['date,amount,stake,sport,book,bet_type,note', ...lines].join('\n')
    // The first chunk (250 rows) lands, then the connection drops.
    await page.evaluate(() => localStorage.setItem('e2e:writes-left', '1'))
    await page.setInputFiles('input[type=file]', { name: 'bets.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await expect.poll(async () => (await serverRows(page)).length, { timeout: 15_000 }).toBe(3 + 250)
    await expect(page.locator('.sync-badge')).toHaveText(/Offline/)

    // Another device edits one of the rows that landed.
    await page.evaluate(() => {
      const rows = JSON.parse(localStorage.getItem('e2e:rows') ?? '[]') as Record<string, unknown>[]
      const row = rows.find((r) => r.note === 'row 0')
      if (row) Object.assign(row, { note: 'edited elsewhere', updated_at: '2099-01-01T00:00:00.000Z' })
      localStorage.setItem('e2e:rows', JSON.stringify(rows))
      localStorage.removeItem('e2e:writes-left')
      window.dispatchEvent(new Event('online'))
    })
    await expect(page.locator('.sync-badge')).toHaveText('Synced', { timeout: 15_000 })
    const rows = await serverRows(page)
    expect(rows.find((r) => r.note === 'edited elsewhere')?.updated_at).toBe('2099-01-01T00:00:00.000Z')
    expect(rows.some((r) => r.note === 'row 0')).toBe(false)
    expect(rows).toHaveLength(3 + 300)
  })

  test('counts on the badge only the rows still to go', async ({ page }) => {
    await boot(page, { backend: 'live' })
    const csv = ['date,amount,stake,note', ...Array.from({ length: 300 }, (_, i) => `2026-07-01,${i + 1}.00,10.00,row ${i}`)].join('\n')
    await page.evaluate(() => localStorage.setItem('e2e:writes-left', '1'))
    await page.setInputFiles('input[type=file]', { name: 'bets.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await expect(page.locator('.sync-badge')).toHaveText('Offline · 50 queued', { timeout: 15_000 })
  })
})

test.describe('a server that answers fewer rows than asked', () => {
  const many = (n: number): SeedEntry[] =>
    Array.from({ length: n }, (_, i) => entry({ id: `h${String(i).padStart(4, '0')}`, date: `2026-0${(i % 6) + 1}-${String((i % 27) + 1).padStart(2, '0')}`, amount: 1 }))

  // The next page started a whole page on: with max-rows 300, a 700-bet
  // history read as 300 (and a 450-move bankroll as 200).
  test('reads the whole history and every deposit, page after shorter page', async ({ page }) => {
    const moves = Array.from({ length: 450 }, (_, i) => move({ id: `mv${i}`, date: '2026-01-01', amount: 2 }))
    await install(page.context(), { backend: 'live', entries: many(700), moves, settings: { startingBankroll: 0 } })
    await page.addInitScript(() => localStorage.setItem('e2e:max-rows', '200'))
    // The device has never read any of it: what shows is what it reads.
    await page.addInitScript((uid) => {
      if (!sessionStorage.getItem('cleared')) {
        sessionStorage.setItem('cleared', '1')
        localStorage.removeItem(`bettracker:cache:${uid}`)
        localStorage.removeItem(`bettracker:moves:${uid}`)
      }
    }, USER.id)
    await page.goto('/')
    await expect(page.locator('.history-card')).toBeVisible()
    await expect.poll(() => page.evaluate((uid) => (JSON.parse(localStorage.getItem(`bettracker:cache:${uid}`) ?? '[]') as unknown[]).length, USER.id), { timeout: 15_000 }).toBe(700)
    await expect.poll(() => page.evaluate((uid) => (JSON.parse(localStorage.getItem(`bettracker:moves:${uid}`) ?? '[]') as unknown[]).length, USER.id), { timeout: 15_000 }).toBe(450)
    // 700 bets of +$1 and 450 deposits of $2.
    await expect(page.locator('.mini-bankroll .mini-value')).toHaveText('$1,600')
  })
})

test.describe('settings changed while a save is out', () => {
  // A refused save cleared whatever was pending, the edit made meanwhile too.
  test('a refusal of the older save leaves the newer edit pending, and it reaches the server', async ({ page }) => {
    await boot(page, { backend: 'live', latencyMs: 1200, settings: { oddsFormat: 'american', defaultStake: 10 } })
    await page.evaluate(() => localStorage.setItem('e2e:fail', JSON.stringify({ status: 400, message: 'violates check constraint', code: '23514', times: 1 })))
    await page.click('.settings-btn')
    const dialog = page.locator('.settings-modal')
    await dialog.locator('.settings-seg .seg-btn', { hasText: 'Decimal' }).click()
    // While that save is out (and about to be refused), another setting changes.
    await expect.poll(() => page.evaluate(() => localStorage.getItem('e2e:writes-started'))).toBe('1')
    const stake = dialog.locator('.settings-stake input')
    await stake.fill('45')
    await stake.press('Enter')
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await serverSettings(page))?.default_stake, { timeout: 20_000 }).toBe(45)
    // The refused field stays as the server had it.
    expect((await serverSettings(page))?.odds_format).toBe('american')
  })
})

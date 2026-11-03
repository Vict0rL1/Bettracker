import { expect, test, type Page } from '@playwright/test'
import { boot, entry, menu, SEED } from './harness'

/**
 * Regression tests for the product items of the audits of 2026-10-20 and
 * 2026-10-22 (base df13583): a decision per possible duplicate in the import
 * review, a date in the quick add, and short actions on a phone. Each asserts
 * the outcome the app must give.
 */

const rows = (page: Page) => page.locator('.history-card tbody tr')
const HEADER = 'date,status,stake,odds,closing_odds,amount,sport,book,bet_type,note'

async function review(page: Page, csv: string) {
  await menu(page, '.data-btn')
  await page.setInputFiles('.data-csv-input', { name: 'bets.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  const dialog = page.locator('.data-modal')
  await expect(dialog.locator('.imp-summary')).toBeVisible()
  return dialog
}

test.describe('import review: a decision for each possible duplicate', () => {
  // Each line looks like one of the seed's bets (the loss of 2026-08-02 and the win of 2026-08-03).
  const LOSS = '2026-08-02,lost,50.00,,,-50.00,NBA,DK,Spread,from the file'
  const WIN = '2026-08-03,won,60.00,,1.95,30.00,NFL,FanDuel,Moneyline,live'

  test('each is shown next to the bet it looks like, skipped unless ticked, with totals that add up', async ({ page }) => {
    await boot(page)
    const dialog = await review(page, [HEADER, LOSS, WIN, '2026-08-20,won,10.00,2.5,,15.00,NBA,DK,Spread,new one'].join('\n'))
    await expect(dialog.locator('.imp-summary')).toHaveText('1 ready · 2 possible duplicates · 0 rejected')
    // The comparison: date, result, stake, profit, odds, closing odds, tags and note, file against here.
    const first = dialog.locator('.imp-dup').first()
    await expect(first.locator('thead')).toContainText('In the file')
    await expect(first.locator('thead')).toContainText('Already here')
    for (const field of ['Date', 'Result', 'Stake', 'Profit', 'Odds', 'Closing odds', 'Tags', 'Note']) await expect(first.locator('tbody th', { hasText: new RegExp(`^${field}$`) })).toHaveCount(1)
    await expect(first.locator('tr', { hasText: 'Note' })).toContainText('from the file')
    // The note differs (it doesn't decide a match): said, also to a screen reader.
    await expect(first.locator('tr.is-diff', { hasText: 'Note' })).toContainText('(differs)')
    await expect(dialog.locator('.imp-dup-check:checked')).toHaveCount(0)
    await expect(dialog.locator('.imp-go')).toHaveText('Import 1 bet')

    // One ticked, by keyboard.
    await dialog.getByLabel('Import line 3 too').focus()
    await page.keyboard.press('Space')
    await expect(dialog.locator('.imp-dup-count')).toHaveText('1 of 2 will be imported; the rest are skipped.')
    await expect(dialog.locator('.imp-go')).toHaveText('Import 2 bets')
    // All, then none.
    await dialog.locator('.imp-dup-all').click()
    await expect(dialog.locator('.imp-go')).toHaveText('Import 3 bets')
    await dialog.locator('.imp-dup-none').click()
    await expect(dialog.locator('.imp-go')).toHaveText('Import 1 bet')
    await dialog.getByLabel('Import line 2 too').check()
    await dialog.locator('.imp-go').click()
    await expect(page.locator('.toast')).toContainText('Imported 2 bets · duplicates skipped: 1')
    // The identical bet is a second bet, not merged into the first.
    await expect(rows(page).filter({ hasText: '-$50.00' })).toHaveCount(2)
    await expect(rows(page)).toHaveCount(5)
  })

  test('a long file: every duplicate can be reached, decided and counted', async ({ page }) => {
    const here = Array.from({ length: 60 }, (_, i) => entry({ id: `h${i}`, date: `2026-07-${String((i % 28) + 1).padStart(2, '0')}`, amount: 10 + i, stake: 10, sport: 'NBA', book: 'DK', betType: 'Spread' }))
    await boot(page, { entries: here })
    const lines = here.map((b) => `${b.date},won,10.00,,,${b.amount.toFixed(2)},NBA,DK,Spread,`)
    const dialog = await review(page, [HEADER, ...lines].join('\n'))
    await expect(dialog.locator('.imp-summary')).toHaveText('0 ready · 60 possible duplicates · 0 rejected')
    await expect(dialog.locator('.imp-dup')).toHaveCount(25)
    await expect(dialog.locator('.imp-dups .imp-more .hint')).toHaveText('Showing 25 of 60')
    await dialog.locator('.imp-dups .imp-show-more').click()
    await dialog.locator('.imp-dups .imp-show-more').click()
    await expect(dialog.locator('.imp-dup')).toHaveCount(60)
    await dialog.getByLabel('Import line 61 too').check()
    await expect(dialog.locator('.imp-dup-count')).toHaveText('1 of 60 will be imported; the rest are skipped.')
    await expect(dialog.locator('.imp-go')).toHaveText('Import 1 bet')
  })

  test('the review is made again when the bets change during it, keeping the choices still in it', async ({ page }) => {
    await boot(page, { backend: 'live' })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const dialog = await review(page, [HEADER, LOSS, WIN].join('\n'))
    await dialog.getByLabel('Import line 2 too').check()
    await expect(dialog.locator('.imp-go')).toHaveText('Import 1 bet')
    // The win it looks like is deleted on another device, and this one hears of it.
    await page.evaluate(() => {
      const all = JSON.parse(localStorage.getItem('e2e:rows') ?? '[]') as { id: string }[]
      localStorage.setItem('e2e:rows', JSON.stringify(all.filter((r) => r.id !== 'c')))
      window.dispatchEvent(new Event('online'))
    })
    await expect(dialog.locator('.plan-changed')).toContainText('Your bets changed while this was open')
    await expect(dialog.locator('.imp-summary')).toHaveText('1 ready · 1 possible duplicates · 0 rejected')
    await expect(dialog.getByLabel('Import line 2 too')).toBeChecked()
    await expect(dialog.locator('.imp-go')).toHaveText('Import 2 bets')
  })
})

test.describe('quick add: a date, today unless chosen', () => {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const local = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

  test('defaults to today; Yesterday logs it, and says so, for yesterday', async ({ page }) => {
    await boot(page, { settings: { defaultStake: 10, oddsFormat: 'decimal' } })
    await page.click('.add-bet-btn')
    const sheet = page.locator('.quick-modal')
    const today = new Date()
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
    await expect(sheet.locator('.quick-date-input')).toHaveValue(local(today))
    await expect(sheet.locator('.quick-today')).toHaveAttribute('aria-pressed', 'true')
    await expect(sheet.locator('.quick-for')).toContainText('(today)')
    await sheet.locator('.quick-yesterday').click()
    await expect(sheet.locator('.quick-date-input')).toHaveValue(local(yesterday))
    await expect(sheet.locator('.quick-for')).toContainText('(yesterday)')
    await sheet.locator('.quick-row input[type=text]').fill('2.5')
    await sheet.locator('.seg-btn.win').click()
    const when = yesterday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    await expect(page.locator('.toast')).toContainText(when)
    const row = rows(page).filter({ hasText: '+$15.00' })
    await expect(row.locator('.td-date')).toContainText(yesterday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))
  })

  test('a date typed in keeps with the draft across closing, and More details opens that day', async ({ page }) => {
    await boot(page, { settings: { oddsFormat: 'decimal' } })
    await page.click('.add-bet-btn')
    const sheet = page.locator('.quick-modal')
    await sheet.locator('.quick-date-input').fill('2026-08-15')
    await sheet.locator('.field input').first().fill('33')
    await page.keyboard.press('Escape')
    await expect(page.locator('.toast')).toContainText('kept')
    await page.click('.add-bet-btn')
    await expect(sheet.locator('.quick-date-input')).toHaveValue('2026-08-15')
    await expect(sheet.locator('.field input').first()).toHaveValue('33')
    await sheet.locator('.quick-more').click()
    const day = page.locator('.day-modal')
    await expect(day.locator('h2')).toContainText('Aug 15, 2026')
    await expect(day.locator('.bet-form input[type=number]').first()).toHaveValue('33')
  })

  test('no date is an inline error on the date, and nothing is logged', async ({ page }) => {
    await boot(page, { settings: { defaultStake: 10 } })
    await page.click('.add-bet-btn')
    const sheet = page.locator('.quick-modal')
    await sheet.locator('.quick-date-input').fill('')
    await sheet.locator('.seg-btn.loss').click()
    await expect(sheet.locator('.quick-date-input')).toHaveAttribute('aria-invalid', 'true')
    await expect(sheet.locator('.quick-date .field-error')).toHaveText('Enter a valid date.')
    await expect(sheet.locator('.quick-date-input')).toBeFocused()
    await expect(rows(page)).toHaveCount(3)
    // The promotional profit and its checks are unchanged.
    await sheet.locator('.quick-today').click()
    await sheet.locator('.field input').first().fill('0')
    await sheet.locator('.seg-btn.win').click()
    await expect(sheet.locator('.quick-profit')).toBeVisible()
    await sheet.locator('.quick-save').click()
    await expect(sheet.locator('.quick-profit .field-error')).toBeVisible()
  })

  for (const tz of ['Pacific/Kiritimati', 'America/Los_Angeles'] as const) {
    test.describe(`around midnight in ${tz}`, () => {
      test.use({ timezoneId: tz })
      test('the day shown is the local day, and a sheet open past midnight logs the day it showed', async ({ page }) => {
        // 23:59:30 local time on 2026-11-02.
        await page.clock.install({ time: tz === 'Pacific/Kiritimati' ? new Date('2026-11-02T09:59:30Z') : new Date('2026-11-03T07:59:30Z') })
        await boot(page, { settings: { defaultStake: 10 } })
        await page.click('.add-bet-btn')
        const sheet = page.locator('.quick-modal')
        await expect(sheet.locator('.quick-date-input')).toHaveValue('2026-11-02')
        // Midnight passes with the sheet open.
        await page.clock.runFor(60_000)
        await sheet.locator('.seg-btn.loss').click()
        await expect(page.locator('.toast')).toContainText('Nov 2, 2026')
        // Opened again now, it is a new day.
        await page.click('.add-bet-btn')
        await expect(sheet.locator('.quick-date-input')).toHaveValue('2026-11-03')
        await expect(sheet.locator('.quick-yesterday')).toHaveAttribute('aria-pressed', 'false')
        await sheet.locator('.quick-yesterday').click()
        await expect(sheet.locator('.quick-date-input')).toHaveValue('2026-11-02')
      })
    })
  }
})

test.describe('phone actions: short words, full names, one line', () => {
  for (const width of [320, 390]) {
    for (const lang of ['en', 'es'] as const) {
      for (const theme of ['dark', 'light'] as const) {
        test(`at ${width}px in ${lang} (${theme}) an opened card reads Edit / View day, each a full tap target on one line`, async ({ page }) => {
          await page.setViewportSize({ width, height: 740 })
          await page.addInitScript((l) => localStorage.setItem('bettracker:lang', l), lang)
          await boot(page, { entries: SEED, theme })
          const card = page.locator('.hcard').first()
          await card.locator('.hcard-toggle').click()
          const edit = card.locator('.hcard-edit')
          const view = card.locator('.hcard-day')
          const del = card.locator('.hcard-delete')
          await expect(edit).toHaveText(lang === 'en' ? 'Edit' : 'Editar')
          await expect(view).toHaveText(lang === 'en' ? 'View day' : 'Ver día')
          await expect(edit).toHaveAccessibleName(lang === 'en' ? /^Edit the bet on / : /^Editar la apuesta del /)
          await expect(view).toHaveAccessibleName(lang === 'en' ? /^Open every bet on / : /^Abrir todas las apuestas del /)
          const boxes = await Promise.all([edit, view, del].map((b) => b.boundingBox()))
          for (const b of boxes) {
            expect(b).not.toBeNull()
            expect(b!.height).toBeGreaterThanOrEqual(44)
            // One line: no button taller than a single line of text plus its padding.
            expect(b!.height).toBeLessThan(56)
            expect(b!.y).toBe(boxes[0]!.y)
          }
          // Each label fits its button.
          for (const b of [edit, view, del]) expect(await b.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
          expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
          // The actions still do what they say.
          await view.click()
          await expect(page.locator('.day-modal')).toBeVisible()
        })
      }
    }
  }

  test('at 320px the import review, the restore result and the quick add fit without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    await boot(page, { settings: { defaultStake: 10 } })
    const wide = (): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    await page.click('.add-bet-btn')
    await expect(page.locator('.quick-modal .quick-date-input')).toBeVisible()
    expect(await wide()).toBeLessThanOrEqual(0)
    const date = await page.locator('.quick-modal .quick-date-input').boundingBox()
    const chips = await page.locator('.quick-modal .quick-date-chips').boundingBox()
    expect(date!.x + date!.width).toBeLessThanOrEqual(320)
    expect(chips!.x + chips!.width).toBeLessThanOrEqual(320)
    await page.keyboard.press('Escape')
    const dialog = await review(page, [HEADER, '2026-08-02,lost,50.00,,,-50.00,NBA,DK,Spread,a very long note that goes on and on to see it wraps inside the comparison table'].join('\n'))
    await expect(dialog.locator('.imp-cmp')).toBeVisible()
    expect(await wide()).toBeLessThanOrEqual(0)
    const table = await dialog.locator('.imp-cmp').boundingBox()
    expect(table!.x + table!.width).toBeLessThanOrEqual(320)
  })
})

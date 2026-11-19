import fs from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { USER, addExpense, boot, businessDay, card, expense, fxRequests, openExpenseSettings, openScan, reload, scanFile, setFx } from './harness'

/**
 * Expenses paid in another currency (migration 009): the main currency is
 * CAD here and the expense is in USD. The sheet converts it with the day's
 * rate, both boxes editable; the list shows both amounts; the scan review
 * does the same for a whole picture; and a database still on 008 makes the
 * change wait. The exchange-rate service is the harness's fake (FX_RATES:
 * 1 USD = 1.4 CAD, 1 EUR = 1.6 CAD): the suite never reaches the real one.
 */

const pad = (n: number): string => String(n).padStart(2, '0')
const local = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const TODAY = local(new Date())
const daysAgo = (n: number): string => local(new Date(Date.now() - n * 86_400_000))
/** The day the fake service's latest rate is of (it goes by the UTC day, as the real one's does not depend on the device's). */
const LATEST = businessDay(new Date().toISOString().slice(0, 10))

/** A rate's day as the app writes it: "Nov 13", with its year when it is not this one. */
const dayWords = (date: string): string => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', date.slice(0, 4) === TODAY.slice(0, 4) ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}
const rateLine = (asOf: string): string => `Rate of ${dayWords(asOf)} (ECB)`

const CARD_A = '6f9619ff-8b86-4011-b42d-00cf4fc964ff'
const cardA = card({ id: CARD_A, name: 'Visa A', last4: '1234' })
const CAD = { expenseCurrency: 'CAD' }

type Row = Record<string, unknown>
const server = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('e2e:expenses') ?? '[]') as Row[])
const counter = (page: Page, name: string) => page.evaluate((n) => Number(localStorage.getItem(`e2e:${n}`) || 0), name)
/** What the server holds of each expense that matters here. */
const money = async (page: Page) => (await server(page)).map((e) => [Number(e.amount), e.original_amount === null ? null : Number(e.original_amount), e.original_currency, e.fx_rate === null ? null : Number(e.fx_rate)])

async function openSheet(page: Page) {
  await addExpense(page)
  const sheet = page.locator('.expense-modal')
  await expect(sheet.locator('.exp-amount')).toBeVisible()
  return sheet
}

/** A row of the fake AI reading's answer. */
const aiRow = (o: { amount: number; merchant: string; date: string; category?: string }) => ({
  date: o.date,
  amount: o.amount,
  merchant: o.merchant,
  category: o.category ?? 'other',
  cardLast4: null,
  cardHint: null,
  note: '',
  pending: false,
  confidence: 'high'
})

test('an expense in USD is converted to the main currency at the day’s rate and saved with what was paid; the list and the CSV show both; editing shows what is stored and asks for nothing', async ({ page }) => {
  await boot(page, { backend: 'live', view: 'expenses', cards: [], expenses: [], budgets: [], settings: CAD, fx: true })
  await expect(page.locator('.sync-badge')).toHaveText('Synced')

  let sheet = await openSheet(page)
  const currency = sheet.locator('.exp-currency')
  // The main currency unless said otherwise; the others after it, dollars first.
  await expect(currency).toHaveValue('CAD')
  expect((await currency.locator('option').allTextContents()).slice(0, 3)).toEqual(['CAD', 'USD', 'EUR'])
  await expect(currency).toHaveAccessibleName('Currency paid in')
  await sheet.locator('.exp-amount').fill('12')
  await expect(sheet.locator('.exp-fx')).toHaveCount(0)
  await expect(sheet.locator('.exp-currency-note')).toHaveText('Amounts in CAD')
  // In the main currency nothing is asked of anyone.
  expect(fxRequests(page)).toEqual([])

  await currency.selectOption('USD')
  const rate = sheet.locator('.exp-fx-rate')
  const converted = sheet.locator('.exp-fx-converted')
  await expect(rate).toHaveValue('1.4000')
  await expect(converted).toHaveValue('16.80')
  await expect(sheet.locator('.exp-fx-line')).toHaveText(rateLine(LATEST))
  await expect(sheet.locator('.exp-currency-note')).toHaveText('Counts in CAD · paid in USD')
  // One request: two currency codes and "latest" for today (the harness checks it carries nothing else).
  expect(fxRequests(page)).toEqual(['/v1/latest?base=USD&symbols=CAD'])
  // The amount in the main currency follows the amount paid.
  await sheet.locator('.exp-amount').fill('12,50')
  await expect(converted).toHaveValue('17.50')
  await expect(sheet.locator('.exp-amount-reads')).toHaveText('= USD 12.50')
  await sheet.locator('.exp-amount').fill('12')
  await sheet.locator('.exp-merchant').fill('Apple.com')
  await sheet.locator('.exp-save').click()
  await expect(sheet).toHaveCount(0)

  // The list and every total are in the main currency; what was paid stands beside it, written with its code.
  const row = page.locator('.exp-row')
  await expect(row.locator('.exp-amount-main')).toHaveText('$16.80')
  await expect(row.locator('.exp-original [aria-hidden]')).toHaveText('USD 12.00')
  await expect(row.locator('.exp-original')).toHaveAttribute('title', /^Paid USD\s12\.00 · 1 USD = 1\.4000 CAD$/)
  await expect(page.locator('.spend-total')).toHaveText('$16.80')
  await expect(page.locator('.exp-currency-code')).toContainText('CAD')
  await expect.poll(() => money(page)).toEqual([[16.8, 12, 'USD', 1.4]])
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  // The rate is kept on this device under one key that names no user, and no second request was needed.
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('bettracker:fx')))).toEqual(['bettracker:fx'])
  expect(await page.evaluate((uid) => (localStorage.getItem('bettracker:fx') ?? '').includes(uid), USER.id)).toBe(false)
  expect(fxRequests(page)).toHaveLength(1)

  // Editing it: what is stored, and nothing is asked.
  await row.locator('.exp-edit').click()
  sheet = page.locator('.expense-modal')
  await expect(sheet.locator('.exp-currency')).toHaveValue('USD')
  await expect(sheet.locator('.exp-amount')).toHaveValue('12.00')
  await expect(rate).toHaveValue('1.4000')
  await expect(converted).toHaveValue('16.80')
  await expect(sheet.locator('.exp-fx-line')).toHaveText('Saved with this expense.')
  // What the bank charged, typed over the converted amount: the rate follows it.
  await converted.fill('17.25')
  await expect(rate).toHaveValue('1.4375')
  await expect(sheet.locator('.exp-fx-line')).toHaveText('Typed by you. Empty the box to get the day’s rate back.')
  await sheet.locator('.exp-save').click()
  await expect(sheet).toHaveCount(0)
  await expect(row.locator('.exp-amount-main')).toHaveText('$17.25')
  await expect.poll(() => money(page)).toEqual([[17.25, 12, 'USD', 1.4375]])
  expect(fxRequests(page)).toHaveLength(1)

  // Another date asks for that day's rate (by its date), since nothing was typed in this sheet.
  const before = daysAgo(3)
  await row.locator('.exp-edit').click()
  await expect(rate).toHaveValue('1.4375')
  await sheet.locator('.exp-date').fill(before)
  await expect(rate).toHaveValue('1.4000')
  await expect(converted).toHaveValue('16.80')
  await expect(sheet.locator('.exp-fx-line')).toHaveText(rateLine(businessDay(before)))
  expect(fxRequests(page)).toEqual(['/v1/latest?base=USD&symbols=CAD', `/v1/${before}?base=USD&symbols=CAD`])
  // A rate the user types is theirs: another date leaves it alone, and asks for nothing.
  await rate.fill('1,5')
  await expect(converted).toHaveValue('18.00')
  await sheet.locator('.exp-date').fill(daysAgo(4))
  await expect(rate).toHaveValue('1,5')
  await expect(converted).toHaveValue('18.00')
  expect(fxRequests(page)).toHaveLength(2)
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)

  // The CSV: the three columns at the end, after the nine a sheet made before expects.
  const [file] = await Promise.all([page.waitForEvent('download'), page.locator('.exp-export-btn').click()])
  const csv = fs.readFileSync((await file.path()) as string, 'utf8').split('\r\n')
  expect(csv[0]).toBe('﻿date,amount,currency,card,card_last4,merchant,category,note,source,original_amount,original_currency,fx_rate')
  expect(csv[1]).toBe(`${TODAY},17.25,CAD,,,Apple.com,other,,manual,12.00,USD,1.4375`)

  // The next sheet offers dollars right after the main currency (the last other one used here), and is in the main one.
  sheet = await openSheet(page)
  await expect(sheet.locator('.exp-currency')).toHaveValue('CAD')
  expect((await sheet.locator('.exp-currency option').allTextContents()).slice(0, 2)).toEqual(['CAD', 'USD'])
})

test('with no rate to be had the boxes stay empty and say what to type; nothing is saved as if it were the main currency; offline, the last saved rate converts', async ({ page }) => {
  // The fake service has no Colombian pesos, as the real one.
  await boot(page, { backend: 'live', view: 'expenses', cards: [], expenses: [], budgets: [], settings: CAD, fx: true })
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  const sheet = await openSheet(page)
  const rate = sheet.locator('.exp-fx-rate')
  const converted = sheet.locator('.exp-fx-converted')
  await sheet.locator('.exp-currency').selectOption('COP')
  await sheet.locator('.exp-amount').fill('12.500')
  await expect(sheet.locator('.exp-fx-line')).toHaveText('No rate is published for COP to CAD. Type the rate, or the amount in CAD.')
  await expect(rate).toHaveValue('')
  await expect(converted).toHaveValue('')
  await expect(sheet.locator('.exp-amount-reads')).toHaveText('= COP 12,500')

  // Saving without a rate: refused next to the box, and nothing leaves the sheet.
  const writes = await counter(page, 'writes-started')
  await sheet.locator('.exp-save').click()
  await expect(sheet.locator('.field-error')).toHaveText('It needs a rate to be saved in CAD.')
  await expect(rate).toBeFocused()
  await expect(rate).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('.exp-row')).toHaveCount(0)
  expect(await counter(page, 'writes-started')).toBe(writes)

  // The amount in the main currency typed by hand: the rate is worked out, and it saves.
  await converted.fill('4.27')
  await expect(rate).toHaveValue('0.0003416')
  await expect(sheet.locator('.field-error')).toHaveCount(0)
  await sheet.locator('.exp-save').click()
  await expect(sheet).toHaveCount(0)
  await expect.poll(() => money(page)).toEqual([[4.27, 12500, 'COP', 0.0003416]])
  await expect(page.locator('.exp-row .exp-original [aria-hidden]')).toHaveText('COP 12,500')
  // The pair is not asked for again in this session.
  const asked = fxRequests(page).length
  expect(fxRequests(page)).toEqual(['/v1/latest?base=COP&symbols=CAD'])

  // Euros have a rate: fetched once, kept on the device.
  const again = await openSheet(page)
  await again.locator('.exp-currency').selectOption('EUR')
  await again.locator('.exp-amount').fill('10')
  await expect(rate).toHaveValue('1.6000')
  expect(fxRequests(page)).toHaveLength(asked + 1)
  // The service can't be reached for another day: the newest saved rate of the pair converts, and the line says which day it is of.
  setFx(page, { mode: 'offline' })
  await again.locator('.exp-date').fill(daysAgo(2))
  await expect(again.locator('.exp-fx-line')).toHaveText(`The rate service can’t be reached: using the saved rate of ${dayWords(LATEST)}.`)
  await expect(rate).toHaveValue('1.6000')
  await expect(converted).toHaveValue('16.00')
  // …and a pair with nothing saved has nothing: the hint, and empty boxes.
  await again.locator('.exp-currency').selectOption('GBP')
  await expect(again.locator('.exp-fx-line')).toHaveText('The rate couldn’t be fetched. Type the rate, or the amount in CAD.')
  await expect(rate).toHaveValue('')
  await expect(converted).toHaveValue('')
  // Back in the main currency there is nothing to convert, and the amount is saved as it is.
  await again.locator('.exp-currency').selectOption('CAD')
  await expect(again.locator('.exp-fx')).toHaveCount(0)
  await again.locator('.exp-save').click()
  await expect(again).toHaveCount(0)
  await expect.poll(async () => (await money(page)).find((m) => m[0] === 10)).toEqual([10, null, null, null])
})

test('a slow rate service blocks nothing: plain words while it is asked, typing goes on, and a rate typed meanwhile is kept', async ({ page }) => {
  await boot(page, { backend: 'live', view: 'expenses', cards: [], expenses: [], budgets: [], settings: CAD, fx: { delayMs: 1500 } })
  const sheet = await openSheet(page)
  const rate = sheet.locator('.exp-fx-rate')
  const converted = sheet.locator('.exp-fx-converted')
  await sheet.locator('.exp-currency').selectOption('USD')
  const line = sheet.locator('.exp-fx-line')
  await expect(line).toHaveText('Getting the rate…')
  await expect(line).toHaveAttribute('data-state', 'loading')
  // Words, not a spinner: nothing in the sheet is animating while it waits.
  await page.waitForFunction(() => document.querySelector('.expense-modal')?.getAnimations({ subtree: true }).length === 0)
  await expect(line).toHaveText('Getting the rate…')
  // Everything can be typed meanwhile, the rate too.
  await sheet.locator('.exp-amount').fill('10')
  await sheet.locator('.exp-merchant').fill('Uber')
  await rate.fill('1.5')
  await expect(converted).toHaveValue('15.00')
  await expect(line).toHaveText('Typed by you. Empty the box to get the day’s rate back.')
  // The answer that was on its way changes nothing.
  await page.waitForTimeout(1800)
  await expect(rate).toHaveValue('1.5')
  await expect(converted).toHaveValue('15.00')
  // Emptied and left: the day's rate is asked for again, and comes.
  await rate.fill('')
  await expect(converted).toHaveValue('')
  await sheet.locator('.exp-merchant').focus()
  await expect(line).toHaveText('Getting the rate…')
  await expect(rate).toHaveValue('1.4000', { timeout: 10_000 })
  await expect(converted).toHaveValue('14.00')
  await expect(line).toHaveText(rateLine(LATEST))
})

test('before 009: an expense waits as Update needed, said once, and the view names the file; reads, budgets and the currency work; all goes by itself once 009 runs', async ({ page }) => {
  await boot(page, {
    backend: 'behind-009',
    view: 'expenses',
    moves: [],
    cards: [cardA],
    expenses: [expense({ id: '10000000-0000-4000-8000-000000000001', date: TODAY, amount: 9.99, merchant: 'From before' })],
    budgets: [],
    settings: CAD,
    fx: true
  })
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  // The table is there: what it holds shows, and nothing says anything is missing.
  await expect(page.locator('.exp-row')).toHaveCount(1)
  await expect(page.locator('.exp-migration')).toHaveCount(0)
  // Every toast from here on is noted.
  await page.evaluate(() => {
    const w = window as unknown as { __toasts: string[] }
    w.__toasts = []
    new MutationObserver(() => {
      for (const el of Array.from(document.querySelectorAll('.toast'))) {
        const text = el.textContent ?? ''
        if (w.__toasts[w.__toasts.length - 1] !== text) w.__toasts.push(text)
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })

  // An expense in the main currency names 009's columns too (as nulls): it waits on the device.
  let sheet = await openSheet(page)
  await sheet.locator('.exp-amount').fill('4.50')
  await sheet.locator('.exp-merchant').fill('Café')
  await sheet.locator('.exp-save').click()
  await expect(sheet).toHaveCount(0)
  await expect(page.locator('.sync-badge')).toHaveText('Update needed · 1 queued')
  await expect(page.locator('.toast')).toContainText('Your database is behind the app')
  await expect(page.locator('.exp-row')).toHaveCount(2)
  expect(await server(page)).toHaveLength(1)
  // The view says which file to run; it is 009's notice, not 008's.
  const banner = page.locator('.exp-migration')
  await expect(banner).toHaveCount(1)
  await expect(banner).toHaveClass(/exp-migration-009/)
  await expect(banner).toContainText('supabase/migrations/009_expense_original_currency.sql')
  // 008 is there, so the budgets and the currency are not held back.
  await openExpenseSettings(page)
  const settings = page.locator('.expense-settings-modal')
  await expect(settings.locator('.currency-select')).toBeEnabled()
  await expect(settings.locator('.budget-input').first()).toBeEnabled()
  await expect(settings.locator('.expset-needs008')).toHaveCount(0)
  await settings.locator('.expset-done').click()
  await expect(settings).toHaveCount(0)

  // A resume and a reconnect: the list is read (it works) and the queue is sent again (refused again).
  const writes = await counter(page, 'writes')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(() => counter(page, 'writes')).toBeGreaterThanOrEqual(writes + 2)
  await expect(page.locator('.sync-badge')).toHaveText('Update needed · 1 queued')
  await expect(banner).toBeVisible()

  // One paid in dollars queues behind it, converted on the device.
  sheet = await openSheet(page)
  await sheet.locator('.exp-currency').selectOption('USD')
  await sheet.locator('.exp-amount').fill('12')
  await expect(sheet.locator('.exp-fx-converted')).toHaveValue('16.80')
  await sheet.locator('.exp-save').click()
  await expect(sheet).toHaveCount(0)
  await expect(page.locator('.sync-badge')).toHaveText('Update needed · 2 queued')
  await expect(page.locator('.exp-row')).toHaveCount(3)
  // Said once: not again on the resume, the reconnect or the second expense. Never refused.
  const said = await page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts.filter((t) => t.includes('Your database is behind the app')))
  expect(said).toHaveLength(1)
  expect(await page.evaluate((uid) => localStorage.getItem(`bettracker:expenses-refused:${uid}`), USER.id)).toBeNull()

  // Kept across a reload, original and all.
  await reload(page, '.exp-bar')
  await expect(page.locator('.sync-badge')).toHaveText('Update needed · 2 queued')
  await expect(page.locator('.exp-row')).toHaveCount(3)
  await expect(page.locator('.exp-row .exp-original [aria-hidden]')).toHaveText('USD 12.00')
  await expect(page.locator('.exp-migration-009')).toBeVisible()

  // 009 runs: both go by themselves, each with its three columns.
  await page.evaluate(() => {
    localStorage.setItem('e2e:migrated-009', '1')
    window.dispatchEvent(new Event('online'))
  })
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  await expect(page.locator('.exp-migration')).toHaveCount(0)
  const rows = await server(page)
  expect(rows).toHaveLength(3)
  expect(rows.find((e) => e.merchant === 'Café')).toMatchObject({ amount: 4.5, original_amount: null, original_currency: null, fx_rate: null })
  expect(rows.find((e) => Number(e.amount) === 16.8)).toMatchObject({ original_amount: 12, original_currency: 'USD', fx_rate: 1.4 })
  await expect(page.locator('.exp-row')).toHaveCount(3)
})

test('scan review: the picture’s currency is chosen at the top; in USD each row is converted at its day’s rate, a duplicate is found by what was paid, and what is added keeps its original', async ({ page }) => {
  const yesterday = daysAgo(1)
  await boot(page, {
    backend: 'live',
    view: 'expenses',
    cards: [cardA],
    // Saved before at another rate: the same purchase all the same.
    expenses: [expense({ id: '10000000-0000-4000-8000-000000000001', date: TODAY, amount: 17.1, originalAmount: 12, originalCurrency: 'USD', fxRate: 1.425, merchant: 'Apple.com' })],
    budgets: [],
    settings: CAD,
    fx: true,
    // An Apple Wallet screen: a bare "$", so the reading names no currency.
    ai: { rows: { kind: 'wallet', currency: null, expenses: [aiRow({ amount: 12, merchant: 'APPLE.COM/BILL', date: TODAY }), aiRow({ amount: 23.5, merchant: 'Uber', date: yesterday }), aiRow({ amount: -5, merchant: 'Refund Co', date: yesterday })] } }
  })
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  await openScan(page)
  await page.setInputFiles('.exp-scan-input', scanFile)
  const rows = page.locator('.exp-review-row')
  await expect(rows).toHaveCount(3)

  // Read in the main currency until told otherwise: nothing to convert, nothing asked, and twelve is not the saved 17.10.
  const select = page.locator('.exp-review-currency')
  await expect(select).toHaveValue('CAD')
  await expect(page.locator('.exp-review-fxinfo')).toHaveText('The picture doesn’t say its currency (a bare “$” can be any dollar). Choose it if it isn’t CAD.')
  await expect(rows.nth(0).locator('.exp-review-amount-text')).toHaveText('$12.00')
  await expect(rows.nth(0)).not.toHaveClass(/is-dup/)
  await expect(page.locator('.exp-review-original')).toHaveCount(0)
  await expect(page.locator('.exp-review-add')).toHaveText('Add 3 expenses')
  expect(fxRequests(page)).toEqual([])

  // "These are dollars": every row is converted at its own day's rate, one request per day.
  await select.selectOption('USD')
  await expect(rows.nth(1).locator('.exp-review-amount-text')).toHaveText('$32.90')
  await expect(rows.nth(1).locator('.exp-review-original')).toHaveText('USD 23.50')
  await expect(rows.nth(2).locator('.exp-review-amount-text')).toHaveText('-$7.00')
  await expect(rows.nth(2).locator('.exp-review-original')).toHaveText('-USD 5.00')
  await expect(page.locator('.exp-review-fxinfo')).toHaveText('Each row is converted to CAD at its day’s rate (ECB). Open a row to change its rate or its CAD amount.')
  expect([...fxRequests(page)].sort()).toEqual([`/v1/${yesterday}?base=USD&symbols=CAD`, '/v1/latest?base=USD&symbols=CAD'].sort())
  // The first is the purchase already saved: the same amount paid in the same currency, whatever rate each got.
  await expect(rows.nth(0)).toHaveClass(/is-dup/)
  await expect(rows.nth(0).locator('.exp-review-include')).not.toBeChecked()
  await expect(rows.nth(0).locator('.exp-review-match')).toContainText('Apple.com')
  await expect(rows.nth(0).locator('.exp-review-match')).toContainText('$17.10 (USD 12.00)')
  await expect(page.locator('.exp-review-add')).toHaveText('Add 2 expenses')

  // A row's own rate and amount, like the sheet's: what the bank charged.
  await rows.nth(1).locator('.exp-review-edit').click()
  await expect(rows.nth(1).locator('.exp-review-rate')).toHaveValue('1.4000')
  await expect(rows.nth(1).locator('.exp-review-fx-line')).toHaveText(rateLine(businessDay(yesterday)))
  await rows.nth(1).locator('.exp-review-converted').fill('33.37')
  await expect(rows.nth(1).locator('.exp-review-rate')).toHaveValue('1.4200')
  await expect(rows.nth(1).locator('.exp-review-amount-text')).toHaveText('$33.37')

  await page.locator('.exp-review-add').click()
  await expect(page.locator('.expense-modal')).toHaveCount(0)
  await expect(page.locator('.toast')).toContainText('2 expenses added')
  await expect.poll(async () => (await server(page)).length).toBe(3)
  const added = (await server(page)).filter((e) => e.source === 'ai')
  expect(added.map((e) => [Number(e.amount), Number(e.original_amount), e.original_currency, Number(e.fx_rate)]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
    [-7, -5, 'USD', 1.4],
    [33.37, 23.5, 'USD', 1.42]
  ])
  // Dollars are offered first the next time (after the main currency).
  const sheet = await openSheet(page)
  expect((await sheet.locator('.exp-currency option').allTextContents()).slice(0, 2)).toEqual(['CAD', 'USD'])
})

test('scan review without rates: rows say so and are left out of Add N until one rate for all of them is typed; a row typed by hand is added on its own and the rest stay', async ({ page }) => {
  const yesterday = daysAgo(1)
  await boot(page, {
    backend: 'live',
    view: 'expenses',
    cards: [],
    expenses: [],
    budgets: [],
    settings: CAD,
    // The service is out of reach, and this device has no rate saved.
    fx: { mode: 'offline' },
    ai: { rows: { kind: 'receipt', currency: 'USD', expenses: [aiRow({ amount: 12, merchant: 'Apple', date: TODAY }), aiRow({ amount: 20, merchant: 'Uber', date: yesterday })] } }
  })
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  await openScan(page)
  await page.setInputFiles('.exp-scan-input', scanFile)
  const rows = page.locator('.exp-review-row')
  await expect(rows).toHaveCount(2)
  // The reading says dollars: chosen from the start.
  await expect(page.locator('.exp-review-currency')).toHaveValue('USD')
  await expect(page.locator('.exp-review-norate')).toHaveCount(2)
  await expect(rows.nth(0).locator('.exp-review-norate')).toHaveText('No rate yet: type one, or the CAD amount.')
  // Only what was read shows: never as if it were the main currency.
  await expect(rows.nth(0).locator('.exp-review-amount-text')).toHaveText('USD 12.00')
  await expect(page.locator('.exp-review-fxinfo')).toHaveText('The rates couldn’t be fetched. Type one rate for the rows without one, or open a row to type its own.')
  await expect(page.locator('.exp-review-waiting')).toHaveText('Ticked rows without a rate (2) are not added until they have one.')
  const add = page.locator('.exp-review-add')
  await expect(add).toHaveText('Add 0 expenses')
  await add.click()
  await expect(page.locator('.exp-review-problem')).toHaveText('None of the ticked rows has a rate yet. Type one first.')
  expect(await server(page)).toHaveLength(0)

  // One row gets its amount in the main currency by hand: it alone can be added, and the other stays in the review.
  await rows.nth(0).locator('.exp-review-edit').click()
  await rows.nth(0).locator('.exp-review-converted').fill('17')
  await expect(rows.nth(0).locator('.exp-review-rate')).toHaveValue('1.41666667')
  await expect(add).toHaveText('Add 1 expense')
  await add.click()
  await expect(page.locator('.toast')).toContainText('Expense added')
  await expect(rows).toHaveCount(1)
  await expect(rows.nth(0).locator('.exp-review-merchant-text')).toHaveText('Uber')
  await expect.poll(() => money(page)).toEqual([[17, 12, 'USD', 1.41666667]])

  // One rate for the rows without one.
  const all = page.locator('.exp-review-rateall')
  await expect(all).toBeVisible()
  await all.fill('1,5')
  await expect(rows.nth(0).locator('.exp-review-amount-text')).toHaveText('$30.00')
  await expect(rows.nth(0).locator('.exp-review-original')).toHaveText('USD 20.00')
  await expect(page.locator('.exp-review-norate')).toHaveCount(0)
  await expect(page.locator('.exp-review-waiting')).toHaveCount(0)
  await expect(add).toHaveText('Add 1 expense')
  await add.click()
  await expect(page.locator('.expense-modal')).toHaveCount(0)
  await expect.poll(async () => (await money(page)).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
    [17, 12, 'USD', 1.41666667],
    [30, 20, 'USD', 1.5]
  ])
})

test('on a 320px phone, in Spanish, the sheet and the review in another currency fit, with no field under 16px; the list shows what was paid under the amount', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.addInitScript(() => {
    if (!localStorage.getItem('bettracker:lang')) localStorage.setItem('bettracker:lang', 'es')
  })
  await boot(page, {
    backend: 'live',
    view: 'expenses',
    cards: [cardA],
    expenses: [expense({ id: '10000000-0000-4000-8000-000000000001', date: TODAY, amount: 16.8, originalAmount: 12, originalCurrency: 'USD', fxRate: 1.4, cardId: CARD_A, merchant: 'Un comercio de nombre bastante largo', note: 'y una nota también larga' })],
    budgets: [],
    settings: CAD,
    fx: true,
    ai: { rows: { kind: 'wallet', currency: 'USD', expenses: [aiRow({ amount: 1234.56, merchant: 'Supermercado La Plaza Mayor', date: TODAY }), aiRow({ amount: 9, merchant: 'Uber', date: daysAgo(1) })] } }
  })
  const small = (): Promise<string[]> =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.expense-modal input, .expense-modal select'))
        .filter((el) => !(el instanceof HTMLInputElement && ['checkbox', 'radio', 'file', 'hidden'].includes(el.type)) && el.getBoundingClientRect().width > 0)
        .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
        .map((el) => el.className)
    )
  /** Nothing in the sheet reaches past the screen, and the page doesn't scroll sideways. */
  const fits = async (): Promise<void> => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    const wide = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.expense-modal *'))
        .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > 320.5)
        .map((el) => el.className)
    )
    expect(wide).toEqual([])
  }

  // The list: the amount in the main currency, and what was paid at the end of the line under it.
  const item = page.locator('.exp-item')
  await expect(item.locator('.exp-item-amount')).toHaveText('$16.80')
  await expect(item.locator('.exp-original [aria-hidden]')).toHaveText('USD 12.00')
  const [amount, original] = [await item.locator('.exp-item-amount').boundingBox(), await item.locator('.exp-original').boundingBox()]
  if (!amount || !original) throw new Error('no boxes')
  expect(original.y).toBeGreaterThan(amount.y)
  expect(original.x + original.width).toBeLessThanOrEqual(320)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)

  // The sheet, in dollars.
  const sheet = await openSheet(page)
  await sheet.locator('.exp-currency').selectOption('USD')
  await sheet.locator('.exp-amount').fill('1234,56')
  await expect(sheet.locator('.exp-fx-converted')).toHaveValue('1728.38')
  await expect(sheet.locator('.exp-fx-line')).toHaveText(/^Tasa del .+ \(BCE\)$/)
  await expect(sheet.locator('.exp-fx-rate')).toBeVisible()
  expect(await small()).toEqual([])
  await fits()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)

  // The review, in dollars, with a row open.
  await openScan(page)
  await page.setInputFiles('.exp-scan-input', scanFile)
  const rows = page.locator('.exp-review-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0).locator('.exp-review-amount-text')).toHaveText('$1,728.38')
  await expect(rows.nth(0).locator('.exp-review-original')).toHaveText('USD 1,234.56')
  await rows.nth(0).locator('.exp-review-edit').click()
  await expect(rows.nth(0).locator('.exp-review-rate')).toHaveValue('1.4000')
  expect(await small()).toEqual([])
  await fits()
  await expect(page.locator('.exp-review-add')).toHaveText('Añadir 2 gastos')
})

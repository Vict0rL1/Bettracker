import { expect, test, type Page } from '@playwright/test'
import { boot, expense, fxRequests, openScan, scanFile } from './harness'

/**
 * The currency of each expense in a scan: the reading gives every row its
 * own (what the image shows for it), a bare "$" takes the currency the
 * merchant was last paid in, a charge the picture shows in the main currency
 * is the converted amount, and the person changes one row's currency or all
 * of them. The main currency is CAD; the AI reading is the fake server's
 * (`ai`), and the exchange-rate service the harness's (`fx`: 1 USD = 1.4 CAD,
 * 1 EUR = 1.6 CAD). Without `fx`, any request to that service fails the test.
 */

const pad = (n: number): string => String(n).padStart(2, '0')
const local = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const TODAY = local(new Date())
const daysAgo = (n: number): string => local(new Date(Date.now() - n * 86_400_000))
const CAD = { expenseCurrency: 'CAD' }

type Row = Record<string, unknown>
const server = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('e2e:expenses') ?? '[]') as Row[])
/** What the server holds of each expense added by the scan: the amount, what was paid, in what, and the rate; by amount. */
const added = async (page: Page) =>
  (await server(page))
    .filter((e) => e.source === 'ai')
    .map((e) => [Number(e.amount), e.original_amount === null ? null : Number(e.original_amount), e.original_currency, e.fx_rate === null ? null : Number(e.fx_rate)])
    .sort((a, b) => Number(a[0]) - Number(b[0]))

/** A row of the fake reading, with the currency the image shows for it (none: a bare "$") and what the card was charged. */
const aiRow = (o: { amount: number; merchant: string; date?: string; currency?: string; basis?: 'code' | 'place'; charged?: [number, string] }) => ({
  date: o.date ?? TODAY,
  amount: o.amount,
  currencyBasis: o.currency ? (o.basis ?? 'code') : 'none',
  currency: o.currency ?? null,
  chargedAmount: o.charged?.[0] ?? null,
  chargedCurrency: o.charged?.[1] ?? null,
  merchant: o.merchant,
  category: 'other',
  cardLast4: null,
  cardHint: null,
  note: '',
  pending: false,
  confidence: 'high'
})

/** An expense saved before, paid in USD. */
const paidInUsd = (id: string, merchant: string) => expense({ id, date: daysAgo(10), amount: 7, originalAmount: 5, originalCurrency: 'USD', fxRate: 1.4, merchant })

/** The scan: the + button, the sheet's "Scan receipt" (harness openScan), then the picture. */
async function scanPicture(page: Page): Promise<void> {
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  await openScan(page)
  await page.setInputFiles('.exp-scan-input', scanFile)
}

test('a Wallet screen with purchases in CAD and in USD: each row in its own currency, only the USD ones converted, and saved so', async ({ page }) => {
  const yesterday = daysAgo(1)
  await boot(page, {
    backend: 'live',
    view: 'expenses',
    cards: [],
    expenses: [],
    budgets: [],
    settings: CAD,
    fx: true,
    ai: {
      rows: {
        kind: 'wallet',
        currency: null,
        expenses: [
          aiRow({ amount: 12, merchant: 'Apple.com', currency: 'USD' }),
          aiRow({ amount: 5.25, merchant: 'Tim Hortons', currency: 'CAD' }),
          aiRow({ amount: 23.5, merchant: 'Target', date: yesterday, currency: 'USD', basis: 'place' })
        ]
      }
    }
  })
  await scanPicture(page)
  const rows = page.locator('.exp-review-row')
  await expect(rows).toHaveCount(3)

  // No one currency for the picture: the bulk select says so.
  const all = page.locator('.exp-review-currency')
  await expect(all).toHaveValue('')
  await expect(all.locator('option:checked')).toHaveText('Mixed')
  await expect(page.locator('.exp-review-currency-field .field-label')).toHaveText('Currency of all rows')

  await expect(rows.nth(0).locator('.exp-review-amount-text')).toHaveText('$16.80')
  await expect(rows.nth(0).locator('.exp-review-original')).toHaveText('USD 12.00')
  await expect(rows.nth(1).locator('.exp-review-amount-text')).toHaveText('$5.25')
  await expect(rows.nth(1).locator('.exp-review-original')).toHaveCount(0)
  await expect(rows.nth(2).locator('.exp-review-amount-text')).toHaveText('$32.90')
  await expect(rows.nth(2).locator('.exp-review-original')).toHaveText('USD 23.50')
  // Every currency was read: nothing assumed.
  await expect(page.locator('.exp-review-assumed')).toHaveCount(0)
  await expect(page.locator('.exp-review-fxinfo')).toHaveText(
    'Rows in another currency are converted to CAD: as charged when the picture shows it, else at their day’s rate (ECB). Open a row to change its rate or its CAD amount.'
  )
  // Only the USD rows' days were asked for; the CAD row needs nothing.
  expect([...fxRequests(page)].sort()).toEqual([`/v1/${yesterday}?base=USD&symbols=CAD`, '/v1/latest?base=USD&symbols=CAD'].sort())

  // A row's own currency is in its fields.
  await rows.nth(1).locator('.exp-review-edit').click()
  await expect(rows.nth(1).locator('.exp-review-row-currency')).toHaveValue('CAD')
  await expect(rows.nth(1).locator('.exp-review-rate')).toHaveCount(0)

  await page.locator('.exp-review-add').click()
  await expect(page.locator('.expense-modal')).toHaveCount(0)
  await expect(page.locator('.toast')).toContainText('3 expenses added')
  await expect.poll(() => added(page)).toEqual([
    [5.25, null, null, null],
    [16.8, 12, 'USD', 1.4],
    [32.9, 23.5, 'USD', 1.4]
  ])
})

test('a bare "$" at a merchant last paid in USD is read as USD; one with no history is CAD, marked as assumed', async ({ page }) => {
  await boot(page, {
    backend: 'live',
    view: 'expenses',
    cards: [],
    expenses: [paidInUsd('10000000-0000-4000-8000-000000000001', 'Blue Bottle Coffee')],
    budgets: [],
    settings: CAD,
    fx: true,
    ai: { rows: { kind: 'wallet', currency: null, expenses: [aiRow({ amount: 6.5, merchant: 'BLUE BOTTLE COFFEE #12' }), aiRow({ amount: 4, merchant: 'Corner Store' })] } }
  })
  await scanPicture(page)
  const rows = page.locator('.exp-review-row')
  await expect(rows).toHaveCount(2)

  await expect(rows.nth(0).locator('.exp-review-amount-text')).toHaveText('$9.10')
  await expect(rows.nth(0).locator('.exp-review-original')).toHaveText('USD 6.50')
  await expect(rows.nth(0).locator('.exp-review-curhow')).toHaveText('USD, as last time at this merchant')
  await expect(rows.nth(0).locator('.exp-review-assumed')).toHaveCount(0)
  // Nothing says which dollar, nothing remembered, and this person pays in USD too: it gets a quiet look.
  await expect(rows.nth(1).locator('.exp-review-amount-text')).toHaveText('$4.00')
  await expect(rows.nth(1).locator('.exp-review-assumed')).toHaveText('Currency assumed: CAD')
  // The note is a hint in a neutral ink: colour is for money.
  const ink = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim()
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })
  await expect(rows.nth(1).locator('.exp-review-assumed')).toHaveCSS('color', ink)
  expect(fxRequests(page)).toEqual(['/v1/latest?base=USD&symbols=CAD'])

  await page.locator('.exp-review-add').click()
  await expect(page.locator('.expense-modal')).toHaveCount(0)
  await expect.poll(() => added(page)).toEqual([
    [4, null, null, null],
    [9.1, 6.5, 'USD', 1.4]
  ])
})

test('a purchase in USD that the picture shows charged in CAD comes to what was charged, with no rate asked for', async ({ page }) => {
  await boot(page, {
    backend: 'live',
    view: 'expenses',
    cards: [],
    expenses: [],
    budgets: [],
    settings: CAD,
    // No `fx`: a request to the rate service would fail this test.
    ai: { rows: { kind: 'wallet', currency: 'USD', expenses: [aiRow({ amount: 12, merchant: 'Amazon.com', currency: 'USD', charged: [16.95, 'CAD'] })] } }
  })
  await scanPicture(page)
  const row = page.locator('.exp-review-row')
  await expect(row).toHaveCount(1)
  await expect(page.locator('.exp-review-currency')).toHaveValue('USD')
  await expect(row.locator('.exp-review-amount-text')).toHaveText('$16.95')
  await expect(row.locator('.exp-review-original')).toHaveText('USD 12.00')
  await expect(row.locator('.exp-review-charged')).toHaveText('As charged')
  await expect(page.locator('.exp-review-norate')).toHaveCount(0)

  await row.locator('.exp-review-edit').click()
  await expect(row.locator('.exp-review-rate')).toHaveValue('1.4125')
  await expect(row.locator('.exp-review-converted')).toHaveValue('16.95')
  await expect(row.locator('.exp-review-fx-line')).toHaveText('What the card was charged, as the picture shows.')

  await page.locator('.exp-review-add').click()
  await expect(page.locator('.expense-modal')).toHaveCount(0)
  await expect.poll(() => added(page)).toEqual([[16.95, 12, 'USD', 1.4125]])
  expect(fxRequests(page)).toEqual([])
})

test('one row’s currency changed in its fields: only that row is converted, and it is no longer assumed', async ({ page }) => {
  await boot(page, {
    backend: 'live',
    view: 'expenses',
    cards: [],
    expenses: [paidInUsd('10000000-0000-4000-8000-000000000001', 'Somewhere else')],
    budgets: [],
    settings: CAD,
    fx: true,
    ai: { rows: { kind: 'receipt', currency: null, expenses: [aiRow({ amount: 4, merchant: 'Corner Store' }), aiRow({ amount: 23.5, merchant: 'Uber' })] } }
  })
  await scanPicture(page)
  const rows = page.locator('.exp-review-row')
  await expect(rows).toHaveCount(2)
  await expect(page.locator('.exp-review-currency')).toHaveValue('CAD')
  await expect(page.locator('.exp-review-assumed')).toHaveCount(2)
  await expect(page.locator('.exp-review-fxinfo')).toHaveText('The picture doesn’t say its currency (a bare “$” can be any dollar). Choose it if it isn’t CAD.')
  expect(fxRequests(page)).toEqual([])

  await rows.nth(1).locator('.exp-review-edit').click()
  await rows.nth(1).getByLabel('Currency paid in').selectOption('USD')
  await expect(rows.nth(1).locator('.exp-review-amount-text')).toHaveText('$32.90')
  await expect(rows.nth(1).locator('.exp-review-original')).toHaveText('USD 23.50')
  await expect(rows.nth(1).locator('.exp-review-field-amount .field-opt')).toHaveText('USD')
  await expect(rows.nth(1).locator('.exp-review-rate')).toHaveValue('1.4000')
  await expect(rows.nth(1).locator('.exp-review-assumed')).toHaveCount(0)
  // The other row is as it was.
  await expect(rows.nth(0).locator('.exp-review-amount-text')).toHaveText('$4.00')
  await expect(rows.nth(0).locator('.exp-review-assumed')).toHaveText('Currency assumed: CAD')
  await expect(page.locator('.exp-review-currency')).toHaveValue('')
  await expect(page.locator('.exp-review-fxinfo')).toContainText('Rows in another currency are converted to CAD')
  expect(fxRequests(page)).toEqual(['/v1/latest?base=USD&symbols=CAD'])

  await page.locator('.exp-review-add').click()
  await expect(page.locator('.expense-modal')).toHaveCount(0)
  await expect.poll(() => added(page)).toEqual([
    [4, null, null, null],
    [32.9, 23.5, 'USD', 1.4]
  ])
})

test('"Currency of all rows" puts every row in one currency, and back in the main one', async ({ page }) => {
  await boot(page, {
    backend: 'live',
    view: 'expenses',
    cards: [],
    expenses: [],
    budgets: [],
    settings: CAD,
    fx: true,
    ai: {
      rows: {
        kind: 'wallet',
        currency: null,
        expenses: [aiRow({ amount: 12, merchant: 'Apple.com', currency: 'USD' }), aiRow({ amount: 5.25, merchant: 'Tim Hortons', currency: 'CAD' }), aiRow({ amount: 9, merchant: 'Uber' })]
      }
    }
  })
  await scanPicture(page)
  const rows = page.locator('.exp-review-row')
  await expect(rows).toHaveCount(3)
  // Two currencies on one screen: the row that doesn't say gets a look.
  await expect(page.locator('.exp-review-assumed')).toHaveCount(1)
  await expect(rows.nth(2).locator('.exp-review-assumed')).toHaveText('Currency assumed: CAD')

  const all = page.locator('.exp-review-currency')
  await all.selectOption('EUR')
  await expect(all).toHaveValue('EUR')
  await expect(rows.nth(0).locator('.exp-review-amount-text')).toHaveText('$19.20')
  await expect(rows.nth(0).locator('.exp-review-original')).toHaveText('EUR 12.00')
  await expect(rows.nth(1).locator('.exp-review-amount-text')).toHaveText('$8.40')
  await expect(rows.nth(2).locator('.exp-review-amount-text')).toHaveText('$14.40')
  await expect(page.locator('.exp-review-assumed')).toHaveCount(0)
  await expect(page.locator('.exp-review-fxinfo')).toHaveText('Each row is converted to CAD at its day’s rate (ECB). Open a row to change its rate or its CAD amount.')
  expect([...fxRequests(page)].sort()).toEqual(['/v1/latest?base=EUR&symbols=CAD', '/v1/latest?base=USD&symbols=CAD'])

  // Back to the main currency: nothing converted, nothing more to say.
  await all.selectOption('CAD')
  await expect(rows.nth(0).locator('.exp-review-amount-text')).toHaveText('$12.00')
  await expect(rows.nth(1).locator('.exp-review-amount-text')).toHaveText('$5.25')
  await expect(rows.nth(2).locator('.exp-review-amount-text')).toHaveText('$9.00')
  await expect(page.locator('.exp-review-original')).toHaveCount(0)
  await expect(page.locator('.exp-review-fxinfo')).toHaveCount(0)

  await page.locator('.exp-review-add').click()
  await expect(page.locator('.expense-modal')).toHaveCount(0)
  await expect.poll(() => added(page)).toEqual([
    [5.25, null, null, null],
    [9, null, null, null],
    [12, null, null, null]
  ])
})

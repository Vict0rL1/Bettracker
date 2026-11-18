import { expect, test, type Page } from '@playwright/test'
import { boot, importCsv, menu, reload } from './harness'

const CSV = [
  'date,stake,amount,sport,book,bet_type,note',
  '2026-08-10,25.00,75.00,Tennis,Pinnacle,Moneyline,"imported, quoted"',
  '2026-08-11,40.00,-40.00,Tennis,Pinnacle,Spread,',
  'garbage,1,1,,,,'
].join('\r\n')

/** Open Import & export and pick a CSV: the review step, before anything is added. */
async function review(page: Page, csv: string, name = 'bets.csv') {
  await menu(page, '.data-btn')
  await page.setInputFiles('.data-csv-input', { name, mimeType: 'text/csv', buffer: Buffer.from(csv) })
  const dialog = page.locator('.data-modal')
  await expect(dialog.locator('.imp-summary')).toBeVisible()
  return dialog
}

const rows = (page: Page) => page.locator('.history-card tbody tr')

test('CSV import applies optimistically, counts rows in the badge, and survives a reload', async ({ page }) => {
  await boot(page)
  await importCsv(page, CSV)

  await expect(page.locator('.toast')).toContainText(
    'Imported 2 bets · lines rejected: 1 — saved on this device, will sync when you’re back online'
  )
  await expect(rows(page)).toHaveCount(5)
  // Rows waiting to sync, not ops: one import of two bets reads as 2.
  await expect(page.locator('.sync-badge')).toHaveText('Offline · 2 queued')
  await expect(page.locator('.history-card tbody')).toContainText('imported, quoted')

  // The import lives in the persisted outbox, not in component state.
  await reload(page)
  await expect(rows(page)).toHaveCount(5)
  await expect(page.locator('.sync-badge')).toHaveText('Offline · 2 queued')
})

test('CSV import reads American and fractional odds, and a whole number by the file\'s other odds', async ({ page }) => {
  await boot(page, { entries: [], settings: { oddsFormat: 'decimal' } })
  const csv = [
    'date,stake,amount,odds,closing',
    '2026-08-10,100,150,+150,+140',
    '2026-08-11,110,-110,-110,-120',
    // A spreadsheet dropped the plus sign: the file's other odds are American, so this is +200.
    '2026-08-12,50,100,200,',
    '2026-08-13,20,30,3/2,6/4'
  ].join('\r\n')
  await importCsv(page, csv, { name: 'american.csv' })
  await expect(page.locator('.toast')).toContainText('Imported 4 bets')
  // Newest first, shown in the user's format (decimal).
  await expect(page.locator('.history-card tbody tr .td-odds')).toHaveText(['2.50', '3.00', '1.91', '2.50'])
})

test('CSV import reads a bare whole number by the odds format the user has just chosen', async ({ page }) => {
  await boot(page, { entries: [], settings: { oddsFormat: 'decimal' } })
  // Switch to American in the settings dialog: the import must use the new choice.
  await menu(page, '.settings-btn')
  await page.locator('.settings-modal .settings-seg .seg-btn', { hasText: 'American' }).click()
  await page.keyboard.press('Escape')
  const csv = ['date,stake,amount,odds', '2026-08-10,10,15,150', '2026-08-11,10,20,200'].join('\r\n')
  await importCsv(page, csv, { name: 'bare.csv' })
  await expect(page.locator('.toast')).toContainText('Imported 2 bets')
  await expect(page.locator('.history-card tbody tr .td-odds')).toHaveText(['+200', '+150'])
})

test.describe('the review step', () => {
  // The seed's loss on 2026-08-02 (NBA · DK · Spread, $50 staked), as an export writes it.
  const DUPLICATE = '2026-08-02,lost,50.00,,,-50.00,NBA,DK,Spread,'
  const HEADER = 'date,status,stake,odds,closing_odds,amount,sport,book,bet_type,note'

  test('says what will go in, what is rejected and why, before anything is added; Cancel adds nothing', async ({ page }) => {
    await boot(page)
    const dialog = await review(page, CSV)
    await expect(dialog.locator('.imp-summary')).toHaveText('2 ready · 0 possible duplicates · 1 rejected')
    await expect(dialog.locator('.imp-rejected')).toContainText('Line 4')
    await expect(dialog.locator('.imp-rejected')).toContainText('“garbage” is not a YYYY-MM-DD date.')
    await expect(rows(page)).toHaveCount(3)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog.locator('.data-import')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(rows(page)).toHaveCount(3)
    await expect(page.locator('.sync-badge')).not.toContainText('queued')
  })

  test('in Spanish too, reasons included', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('bettracker:lang', 'es'))
    await boot(page)
    const dialog = await review(page, CSV)
    await expect(dialog.locator('.imp-summary')).toHaveText('2 listas · 0 posibles duplicados · 1 rechazadas')
    await expect(dialog.locator('.imp-rejected')).toContainText('«garbage» no es una fecha AAAA-MM-DD.')
  })

  test('skips a likely duplicate by default, and says so', async ({ page }) => {
    await boot(page)
    const csv = [HEADER, DUPLICATE, '2026-08-20,won,10.00,2.5,,15.00,NBA,DK,Spread,new one'].join('\n')
    const dialog = await review(page, csv)
    await expect(dialog.locator('.imp-summary')).toHaveText('1 ready · 1 possible duplicates · 0 rejected')
    await expect(dialog.getByLabel('Import line 2 too')).not.toBeChecked()
    await expect(dialog.locator('.imp-dup-count')).toHaveText('0 of 1 will be imported; the rest are skipped.')
    await expect(dialog.locator('.imp-go')).toHaveText('Import 1 bet')
    await dialog.locator('.imp-go').click()
    await expect(page.locator('.toast')).toContainText('Imported 1 bet · duplicates skipped: 1')
    await expect(rows(page)).toHaveCount(4)
    await expect(rows(page).filter({ hasText: '-$50.00' })).toHaveCount(1)
  })

  test('keeps a likely duplicate when told it is a separate bet', async ({ page }) => {
    await boot(page)
    const csv = [HEADER, DUPLICATE].join('\n')
    const dialog = await review(page, csv)
    await expect(dialog.locator('.imp-go')).toHaveCount(0)
    await expect(dialog.locator('.imp-nothing')).toHaveText('Nothing to import: every row is rejected or skipped.')
    await dialog.getByLabel('Import line 2 too').check()
    await expect(dialog.locator('.imp-go')).toHaveText('Import 1 bet')
    await dialog.locator('.imp-go').click()
    await expect(rows(page).filter({ hasText: '-$50.00' })).toHaveCount(2)
  })

  test('two identical rows of a file are two bets: neither is dropped', async ({ page }) => {
    await boot(page, { entries: [] })
    const same = '2026-08-21,won,10.00,2.0,,10.00,NHL,DK,Moneyline,'
    const dialog = await review(page, [HEADER, same, same].join('\n'))
    await expect(dialog.locator('.imp-summary')).toHaveText('2 ready · 0 possible duplicates · 0 rejected')
    await expect(dialog).toContainText('1 rows repeat another row of this file exactly. They are kept')
    await dialog.locator('.imp-go').click()
    await expect(rows(page)).toHaveCount(2)
  })

  test('an import can be undone as a whole, later, from Import & export, and that undone too', async ({ page }) => {
    await boot(page)
    await importCsv(page, CSV, { name: 'august.csv' })
    await expect(rows(page)).toHaveCount(5)
    // One of the imported bets is deleted by hand meanwhile: Undo removes what is left.
    const one = rows(page).filter({ hasText: 'imported, quoted' })
    await one.locator('.btn-icon.danger').click()
    await one.locator('.btn-icon.danger').click()
    await expect(rows(page)).toHaveCount(4)

    await menu(page, '.data-btn')
    const batch = page.locator('.data-batch', { hasText: 'august.csv' })
    await expect(batch).toContainText('2 bets')
    await batch.locator('.data-undo').click()
    await expect(page.locator('.toast')).toContainText('Removed 1 bet of that import')
    await expect(rows(page)).toHaveCount(3)
    await expect(batch).toContainText('undone')
    await page.keyboard.press('Escape')
    // Undo of the undo.
    await page.locator('.toast-action').click()
    await expect(rows(page)).toHaveCount(4)
    await reload(page)
    await expect(rows(page)).toHaveCount(4)
  })

  test('the toast after an import undoes the whole import', async ({ page }) => {
    await boot(page)
    await importCsv(page, CSV)
    await expect(rows(page)).toHaveCount(5)
    await page.locator('.toast-action').click()
    await expect(rows(page)).toHaveCount(3)
  })

  test('the same file picked again says it was imported, and its bets show as possible duplicates', async ({ page }) => {
    await boot(page, { backend: 'live' })
    await importCsv(page, CSV, { name: 'august.csv' })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const dialog = await review(page, CSV, 'august.csv')
    await expect(dialog.locator('.imp-same')).toContainText('You imported this file on')
    await expect(dialog.locator('.imp-summary')).toHaveText('0 ready · 2 possible duplicates · 1 rejected')
  })

  test('the same file picked while its import is still on its way says it will finish on its own', async ({ page }) => {
    await boot(page, { backend: 'live' })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    // The connection drops before the import goes out.
    await page.evaluate(() => localStorage.setItem('e2e:writes-left', '0'))
    await importCsv(page, CSV, { name: 'august.csv' })
    await expect(page.locator('.sync-badge')).toHaveText(/Offline · 2 queued/, { timeout: 15_000 })
    const dialog = await review(page, CSV, 'august.csv')
    await expect(dialog.locator('.imp-same')).toContainText('This file is already being imported (0 of 2 sent)')
    // Its rows are already here, waiting: importing them again is a deliberate choice, twice over.
    await expect(dialog.locator('.imp-summary')).toHaveText('0 ready · 2 possible duplicates · 1 rejected')
    await expect(dialog.locator('.imp-go, .imp-again')).toHaveCount(0)
    await dialog.locator('.imp-dup-all').click()
    await expect(dialog.locator('.imp-go')).toHaveCount(0)
    await expect(dialog.locator('.imp-again')).toHaveText('Import it again anyway')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await page.keyboard.press('Escape')
    // The interrupted import finishes once writes go through: each row once.
    await page.evaluate(() => {
      localStorage.removeItem('e2e:writes-left')
      window.dispatchEvent(new Event('online'))
    })
    await expect(page.locator('.sync-badge')).toHaveText('Synced', { timeout: 15_000 })
    const server = await page.evaluate(() => (JSON.parse(localStorage.getItem('e2e:rows') ?? '[]') as { note: string }[]).filter((r) => r.note === 'imported, quoted').length)
    expect(server).toBe(1)
  })
})

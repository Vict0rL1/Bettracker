import { expect, test } from '@playwright/test'
import { boot, reload } from './harness'

const CSV = [
  'date,stake,amount,sport,book,bet_type,note',
  '2026-08-10,25.00,75.00,Tennis,Pinnacle,Moneyline,"imported, quoted"',
  '2026-08-11,40.00,-40.00,Tennis,Pinnacle,Spread,',
  'garbage,1,1,,,,'
].join('\r\n')

test('CSV import applies optimistically, counts rows in the badge, and survives a reload', async ({ page }) => {
  await boot(page)
  await page.setInputFiles('input[type=file]', { name: 'bets.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) })

  await expect(page.locator('.toast')).toHaveText(
    'Imported 2 bets · skipped 1 line — saved on this device, will sync when you’re back online'
  )
  await expect(page.locator('.history-card tbody tr')).toHaveCount(5)
  // Rows waiting to sync, not ops: one import of two bets reads as 2.
  await expect(page.locator('.sync-badge')).toHaveText('Offline · 2 queued')
  await expect(page.locator('.history-card tbody')).toContainText('imported, quoted')

  // The import lives in the persisted outbox, not in component state.
  await reload(page)
  await expect(page.locator('.history-card tbody tr')).toHaveCount(5)
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
  await page.setInputFiles('input[type=file]', { name: 'american.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await expect(page.locator('.toast')).toContainText('Imported 4 bets')
  // Newest first, shown in the user's format (decimal).
  await expect(page.locator('.history-card tbody tr .td-odds')).toHaveText(['2.50', '3.00', '1.91', '2.50'])
})

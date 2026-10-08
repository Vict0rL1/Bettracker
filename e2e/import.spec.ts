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

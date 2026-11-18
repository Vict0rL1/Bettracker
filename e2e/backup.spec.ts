import fs from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { boot, budget, card, entry, expense, menu, move, reload } from './harness'

// Ids as the database gives them: a backup refuses anything else.
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const BETS = [
  entry({ id: id(1), date: '2026-08-01', amount: 40, stake: 20, odds: 3, note: 'first', sport: 'NBA' }),
  entry({ id: id(2), date: '2026-08-02', amount: -25, stake: 25, note: 'second', sport: 'NFL' }),
  entry({ id: id(3), date: '2026-08-03', amount: 15, stake: 10, note: 'third', sport: 'NBA' })
]
const MOVES = [move({ id: id(101), date: '2026-07-31', amount: 500, note: 'opening deposit' })]
const SETTINGS = { startingBankroll: 1000, oddsFormat: 'decimal', unitSize: 10 }

const rows = (page: Page) => page.locator('.history-card tbody tr')

async function download(page: Page): Promise<Record<string, unknown>> {
  await menu(page, '.data-btn')
  const [file] = await Promise.all([page.waitForEvent('download'), page.locator('.data-backup').click()])
  expect(file.suggestedFilename()).toMatch(/^bettracker-backup-\d{4}-\d{2}-\d{2}\.json$/)
  const json = JSON.parse(fs.readFileSync((await file.path()) as string, 'utf8')) as Record<string, unknown>
  await page.keyboard.press('Escape')
  return json
}

async function pickBackup(page: Page, content: string, name = 'backup.json') {
  await menu(page, '.data-btn')
  await page.setInputFiles('.data-backup-input', { name, mimeType: 'application/json', buffer: Buffer.from(content) })
  return page.locator('.data-modal')
}

test.describe('full backup', () => {
  test('the CSV action says what it is', async ({ page }) => {
    await boot(page)
    await menu(page, '.data-btn')
    await expect(page.locator('.data-export')).toHaveText('Export bets CSV')
  })

  test('holds every bet, deposit and setting, in a versioned file', async ({ page }) => {
    await boot(page, { entries: BETS, moves: MOVES, settings: SETTINGS })
    const backup = await download(page)
    expect(backup.format).toBe('bettracker-backup')
    expect(backup.version).toBe(1)
    expect((backup.bets as { id: string }[]).map((b) => b.id)).toEqual([id(1), id(2), id(3)])
    expect((backup.moves as { note: string }[])[0].note).toBe('opening deposit')
    expect(backup.settings).toMatchObject({ startingBankroll: 1000, oddsFormat: 'decimal', unitSize: 10 })
  })

  test('also holds the expenses, their cards, budgets and currency, which this version reads back but can’t restore yet', async ({ page }) => {
    const cardId = '6f9619ff-8b86-4011-b42d-00cf4fc964ff'
    await boot(page, {
      entries: BETS,
      moves: MOVES,
      settings: SETTINGS,
      cards: [card({ id: cardId, name: 'Visa', last4: '1234' })],
      expenses: [
        expense({ id: id(301), date: '2026-08-02', amount: 4.5, cardId, category: 'coffee', merchant: 'Café' }),
        expense({ id: id(302), date: '2026-08-01', amount: -12, category: 'shopping', source: 'ai' })
      ],
      budgets: [budget({ scope: 'total', monthlyLimit: 600 })]
    })
    const backup = await download(page)
    expect(backup.version).toBe(1)
    expect(backup.settings).toMatchObject({ expenseCurrency: 'USD' })
    expect((backup.expenses as { id: string }[]).map((e) => e.id)).toEqual([id(302), id(301)])
    expect(backup.expenses).toEqual([
      expect.objectContaining({ id: id(302), amount: -12, cardId: null, category: 'shopping', source: 'ai' }),
      expect.objectContaining({ id: id(301), amount: 4.5, cardId, merchant: 'Café', category: 'coffee', source: 'manual' })
    ])
    expect(backup.expenseCards).toEqual([expect.objectContaining({ id: cardId, name: 'Visa', last4: '1234', kind: 'credit', archived: false })])
    expect(backup.expenseBudgets).toEqual([expect.objectContaining({ scope: 'total', target: '', monthlyLimit: 600 })])

    // Restored: the review says what else the file holds, and never counts it.
    // Nor is the file's currency offered: nothing here has shown the expense
    // tables exist (migration 008), so the database might refuse it.
    const dialog = await pickBackup(page, JSON.stringify({ ...backup, settings: { ...(backup.settings as object), expenseCurrency: 'EUR' } }))
    await expect(dialog.locator('.restore-expenses')).toHaveText('This backup also holds 2 expenses, 1 card and 1 budget. This version can’t restore them yet; they stay in the file.')
    await expect(dialog.locator('.restore-settings')).toHaveCount(0)
    await expect(dialog.locator('.imp-nothing')).toHaveText('Nothing to restore: everything in it is already here.')
  })

  test('once the expense tables are known to work, the backup’s expenses currency is offered like any setting', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = await download(page)
    const dialog = await pickBackup(page, JSON.stringify({ ...backup, settings: { ...(backup.settings as object), expenseCurrency: 'EUR' } }))
    await expect(dialog.locator('.imp-section')).toContainText('Expenses in EUR.')
    await dialog.locator('.restore-settings').check()
    await dialog.locator('.restore-go').click()
    await expect(dialog.locator('.result-settings')).toContainText('expenses currency')
    await expect
      .poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('e2e:settings') ?? '{}') as { expense_currency?: string }).expense_currency))
      .toBe('EUR')
  })

  test('restoring brings back what was deleted, changes nothing else, and adds nothing the second time', async ({ page }) => {
    await boot(page, { entries: BETS, moves: MOVES, settings: SETTINGS })
    const backup = JSON.stringify(await download(page))
    // Deleted, and another edited, since.
    const second = rows(page).filter({ hasText: 'second' })
    await second.locator('.btn-icon.danger').click()
    await second.locator('.btn-icon.danger').click()
    await expect(rows(page)).toHaveCount(2)

    const dialog = await pickBackup(page, backup)
    await expect(dialog.locator('.restore-counts')).toContainText('1 bets to add')
    await expect(dialog.locator('.restore-counts')).toContainText('2 bets already here, unchanged')
    await expect(dialog.locator('.restore-counts')).toContainText('0 deposits/withdrawals to add')
    await expect(dialog).toContainText('A restore only adds')
    await dialog.locator('.restore-go').click()
    // No connection here: queued on this device, and said so — never "added".
    await expect(dialog.locator('.result-bets')).toContainText('Saved on this device: 1 bet. Will sync when you’re back online.')
    await expect(dialog.locator('.result-bets')).toContainText('Already here, left as they are: 2.')
    await expect(dialog.locator('.result-moves')).toContainText('Nothing to add.')
    await expect(dialog.locator('.result-settings')).toContainText('Not changed.')
    await expect(dialog.locator('.result-overall')).toHaveText('Not finished yet: part of it is still waiting (see above).')
    await dialog.locator('.result-done').click()
    await page.keyboard.press('Escape')
    await expect(rows(page)).toHaveCount(3)
    await expect(rows(page).filter({ hasText: 'second' })).toHaveCount(1)

    const again = await pickBackup(page, backup)
    await expect(again.locator('.imp-nothing')).toHaveText('Nothing to restore: everything in it is already here.')
    await expect(again.locator('.restore-go')).toHaveCount(0)
    await again.getByRole('button', { name: 'Cancel' }).click()
    await page.keyboard.press('Escape')
    await reload(page)
    await expect(rows(page)).toHaveCount(3)
  })

  test('the settings are replaced only when asked, and a restore can be undone', async ({ page }) => {
    await boot(page, { entries: BETS, moves: MOVES, settings: SETTINGS })
    const original = await download(page)
    const other = JSON.stringify({ ...original, settings: { ...(original.settings as object), oddsFormat: 'american' }, bets: [...(original.bets as object[]), { ...(original.bets as object[])[0], id: id(9), note: 'only in the backup' }] })
    const dialog = await pickBackup(page, other)
    const box = dialog.locator('.restore-settings')
    await expect(box).not.toBeChecked()
    await box.check()
    await dialog.locator('.restore-go').click()
    await expect(dialog.locator('.result-settings')).toContainText('odds format')
    await expect(rows(page).filter({ hasText: 'only in the backup' })).toHaveCount(1)
    // American now: the backup's odds format was taken.
    await expect(rows(page).filter({ hasText: 'only in the backup' }).locator('.td-odds')).toHaveText('+200')
    await dialog.locator('.result-undo-go').click()
    await expect(rows(page).filter({ hasText: 'only in the backup' })).toHaveCount(0)
    // And the odds format it replaced is back.
    await expect(rows(page).filter({ hasText: 'first' }).locator('.td-odds')).toHaveText('3.00')
  })

  test('a file that is not a backup, or from a newer version, is refused before anything changes', async ({ page }) => {
    await boot(page, { entries: BETS })
    let dialog = await pickBackup(page, 'date,amount\n2026-01-01,5', 'bets.csv')
    await expect(dialog.locator('.form-error')).toHaveText('That file is not a BetTracker backup (it isn’t JSON).')
    await page.keyboard.press('Escape')
    dialog = await pickBackup(page, JSON.stringify({ format: 'bettracker-backup', version: 7, bets: [], moves: [], settings: {} }))
    await expect(dialog.locator('.form-error')).toContainText('newer version of BetTracker (format 7)')
    await page.keyboard.press('Escape')
    await expect(rows(page)).toHaveCount(3)
  })

  test('a backup from another account adds its bets as new ones, flagging the ones that look like bets here', async ({ page }) => {
    await boot(page, { entries: BETS })
    const foreign = JSON.stringify({
      format: 'bettracker-backup',
      version: 1,
      exportedAt: '2026-10-01T00:00:00Z',
      account: { id: 'someone-else', email: 'friend@example.com' },
      bets: [
        { ...BETS[0], status: 'won', closingOdds: null },
        { ...BETS[0], id: id(50), date: '2026-08-10', note: 'theirs', status: 'won', closingOdds: null }
      ],
      moves: [],
      settings: { oddsFormat: 'american', unitSize: null, showUnits: false, startingBankroll: null, defaultStake: null, lossLimit: null }
    })
    const dialog = await pickBackup(page, foreign)
    await expect(dialog).toContainText('This backup is from another account.')
    await expect(dialog.locator('.imp-dups h4')).toHaveText('Possible duplicates (1)')
    await dialog.locator('.restore-go').click()
    await expect(rows(page)).toHaveCount(4)
    await expect(rows(page).filter({ hasText: 'first' })).toHaveCount(1)
  })
})

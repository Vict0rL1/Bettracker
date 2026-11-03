import fs from 'node:fs'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { boot, entry, menu, move, reload, USER } from './harness'

/**
 * Regression tests for the audit of 2026-11-02 (base df13583): restore and
 * Undo, and the five reliability defects. Each asserts the outcome the app
 * must give; on df13583 each of these failed.
 */

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const BETS = [
  entry({ id: id(1), date: '2026-08-01', amount: 40, stake: 20, odds: 3, note: 'first', sport: 'NBA' }),
  entry({ id: id(2), date: '2026-08-02', amount: -25, stake: 25, note: 'second', sport: 'NFL' }),
  entry({ id: id(3), date: '2026-08-03', amount: 15, stake: 10, note: 'third', sport: 'NBA' })
]
const MOVES = [move({ id: id(101), date: '2026-07-31', amount: 500, note: 'opening deposit' })]
const SETTINGS = { startingBankroll: 1000, oddsFormat: 'decimal', unitSize: 10 }

const rows = (page: Page) => page.locator('.history-card tbody tr')
const serverRows = (page: Page): Promise<{ id: string; note: string; updated_at: string }[]> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('e2e:rows') ?? '[]'))
const serverMoves = (page: Page): Promise<{ id: string; note: string }[]> => page.evaluate(() => JSON.parse(localStorage.getItem('e2e:moves') ?? '[]'))
const serverSettings = (page: Page): Promise<Record<string, unknown> | null> => page.evaluate(() => JSON.parse(localStorage.getItem('e2e:settings') ?? 'null'))
const setFlag = (page: Page, name: string, value: string | null): Promise<void> =>
  page.evaluate(([k, v]) => (v === null ? localStorage.removeItem(`e2e:${k}`) : localStorage.setItem(`e2e:${k}`, v)), [name, value] as const)
const online = (page: Page): Promise<void> => page.evaluate(() => void window.dispatchEvent(new Event('online')))
/** One of the fake server's read counters, as this window alone counted it (see fakeSupabase.ts). */
const mine = (page: Page, name: string): Promise<number> =>
  page.evaluate((n) => Number(localStorage.getItem(`e2e:${n}@${(window as unknown as { __supabaseMock: { __win: string } }).__supabaseMock.__win}`) || 0), name)

async function download(page: Page): Promise<Record<string, unknown>> {
  await menu(page, '.data-btn')
  const [file] = await Promise.all([page.waitForEvent('download'), page.locator('.data-backup').click()])
  const json = JSON.parse(fs.readFileSync((await file.path()) as string, 'utf8')) as Record<string, unknown>
  await page.keyboard.press('Escape')
  return json
}

async function pickBackup(page: Page, content: string) {
  await menu(page, '.data-btn')
  await page.setInputFiles('.data-backup-input', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(content) })
  const dialog = page.locator('.data-modal')
  await expect(dialog.locator('.restore-counts')).toBeVisible()
  return dialog
}

/** Delete a bet by hand: the row's delete button, twice (it asks). */
async function deleteRow(page: Page, text: string): Promise<void> {
  const row = rows(page).filter({ hasText: text })
  await row.locator('.btn-icon.danger').click()
  await row.locator('.btn-icon.danger').click()
  await expect(rows(page).filter({ hasText: text })).toHaveCount(0)
}

test.describe('restore: what it did, and an Undo that only takes back its own', () => {
  test('the result says what was added, what was skipped and the settings; Undo removes only that', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = JSON.stringify(await download(page))
    await deleteRow(page, 'second')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')

    const dialog = await pickBackup(page, JSON.stringify({ ...JSON.parse(backup), settings: { ...JSON.parse(backup).settings, oddsFormat: 'american' } }))
    await dialog.locator('.restore-settings').check()
    await dialog.locator('.restore-go').click()
    const result = dialog.locator('.restore-result')
    await expect(result.locator('h3')).toHaveText('Restore of backup.json')
    // Confirmed by the server, never before.
    await expect(result.locator('.result-bets')).toContainText('Added: 1 bet.', { timeout: 15_000 })
    await expect(result.locator('.result-bets')).toContainText('Already here, left as they are: 2.')
    await expect(result.locator('.result-moves')).toContainText('Nothing to add.')
    await expect(result.locator('.result-settings')).toContainText('Replaced: odds format.')
    await expect(result.locator('.result-overall')).toHaveText('Finished: everything is on the server.')
    await expect(rows(page).filter({ hasText: 'second' })).toHaveCount(1)

    // Undo: the restored bet goes, the settings come back, nothing else moves.
    await result.locator('.result-undo-go').click()
    await expect(result.locator('.result-undo-state')).toContainText('Removed: 1.', { timeout: 15_000 })
    await expect(result.locator('.result-undo-state')).toContainText('Settings put back: odds format.')
    await expect(rows(page).filter({ hasText: 'second' })).toHaveCount(0)
    await expect(rows(page)).toHaveCount(2)
    await expect.poll(async () => (await serverRows(page)).map((r) => r.note).sort()).toEqual(['first', 'third'])
    await expect.poll(async () => (await serverSettings(page))?.odds_format).toBe('decimal')
  })

  test('a bet another device added with the same id meanwhile is never removed by the Undo, even when this device has not seen it', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = await download(page)
    await deleteRow(page, 'second')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')

    const dialog = await pickBackup(page, JSON.stringify(backup))
    // During the review another device restores the same bet, edited: the
    // server has it, this device does not know yet.
    await page.evaluate(
      ([row]) => {
        const all = JSON.parse(localStorage.getItem('e2e:rows') ?? '[]') as unknown[]
        localStorage.setItem('e2e:rows', JSON.stringify([...all, row]))
      },
      [{ id: id(2), user_id: USER.id, date: '2026-08-02', amount: -25, stake: 25, note: 'theirs', sport: 'NFL', book: '', bet_type: '', status: 'lost', created_at: '2026-11-02T09:00:00Z', updated_at: '2026-11-02T09:00:00.000Z' }]
    )
    // Refreshes come back late from now on: this device keeps believing the row is its own.
    await setFlag(page, 'hold-reads', 'entries:list')
    await dialog.locator('.restore-go').click()
    const result = dialog.locator('.restore-result')
    // The server had it already: left as it was, and said.
    await expect(result.locator('.result-bets')).toContainText('Already on the server (added on another device meanwhile), left as they were: 1.', { timeout: 15_000 })
    await result.locator('.result-undo-go').click()
    await expect(result.locator('.result-undo-state')).toContainText('Kept, changed since the restore (here or on another device): 1.', { timeout: 15_000 })
    // The other device's bet is still on the server, and back on screen.
    expect((await serverRows(page)).find((r) => r.id === id(2))?.note).toBe('theirs')
    await setFlag(page, 'hold-reads', null)
    await page.keyboard.press('Escape')
    await online(page)
    await expect(rows(page).filter({ hasText: 'theirs' })).toHaveCount(1)
  })

  test('a bet edited after the restore stays when it is undone', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = await download(page)
    await deleteRow(page, 'second')
    await deleteRow(page, 'third')
    const dialog = await pickBackup(page, JSON.stringify(backup))
    await dialog.locator('.restore-go').click()
    await expect(dialog.locator('.result-bets')).toContainText('Added: 2 bets.', { timeout: 15_000 })
    // Edited on another device after the restore.
    await page.evaluate((target) => {
      const all = JSON.parse(localStorage.getItem('e2e:rows') ?? '[]') as { id: string; note: string; updated_at: string }[]
      localStorage.setItem('e2e:rows', JSON.stringify(all.map((r) => (r.id === target ? { ...r, note: 'third, edited elsewhere', updated_at: '2099-01-01T00:00:00.000Z' } : r))))
    }, id(3))
    await dialog.locator('.result-undo-go').click()
    await expect(dialog.locator('.result-undo-state')).toContainText('Removed: 1.', { timeout: 15_000 })
    await expect(dialog.locator('.result-undo-state')).toContainText('Kept, changed since the restore (here or on another device): 1.')
    expect((await serverRows(page)).map((r) => r.note).sort()).toEqual(['first', 'third, edited elsewhere'])
  })

  test('the review updates when the data changes during it, and applies the plan shown', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = await download(page)
    await deleteRow(page, 'second')
    await deleteRow(page, 'third')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const dialog = await pickBackup(page, JSON.stringify(backup))
    await expect(dialog.locator('.restore-counts')).toContainText('2 bets to add')
    // Another device puts one of them back, and this device hears of it.
    await page.evaluate((row) => {
      const all = JSON.parse(localStorage.getItem('e2e:rows') ?? '[]') as unknown[]
      localStorage.setItem('e2e:rows', JSON.stringify([...all, row]))
    }, { id: id(3), user_id: USER.id, date: '2026-08-03', amount: 15, stake: 10, note: 'third', sport: 'NBA', book: '', bet_type: '', status: 'won', created_at: '2026-08-03T10:00:00Z', updated_at: '2026-08-03T10:00:00.000Z' })
    await online(page)
    await expect(dialog.locator('.plan-changed')).toContainText('Your data changed while this was open')
    await expect(dialog.locator('.restore-counts')).toContainText('1 bets to add')
    await dialog.locator('.restore-go').click()
    await expect(dialog.locator('.result-bets')).toContainText('Added: 1 bet.', { timeout: 15_000 })
    await expect(rows(page)).toHaveCount(3)
  })

  test('a settings-only restore is undone setting by setting: a later change stays', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = await download(page)
    const other = { ...backup, settings: { ...(backup.settings as object), oddsFormat: 'american', unitSize: 25 } }
    const dialog = await pickBackup(page, JSON.stringify(other))
    await expect(dialog.locator('.restore-counts')).toContainText('0 bets to add')
    await dialog.locator('.restore-settings').check()
    await dialog.locator('.restore-go').click()
    await expect(dialog.locator('.result-settings')).toContainText('Replaced: odds format, unit size.', { timeout: 15_000 })
    await dialog.locator('.result-done').click()
    await page.keyboard.press('Escape')
    // The unit size is changed again by hand after the restore.
    await menu(page, '.settings-btn')
    const unit = page.locator('.settings-modal .settings-unit input')
    await unit.fill('40')
    await unit.blur()
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await serverSettings(page))?.unit_size).toBe(40)
    // Undo from the history: the odds format goes back, the unit size stays 40.
    await menu(page, '.data-btn')
    await page.locator('.data-batch').first().locator('.data-undo').click()
    await expect(page.locator('.toast')).toContainText('settings put back: odds format')
    await expect(page.locator('.toast')).toContainText('kept your later change to unit size')
    await expect.poll(async () => (await serverSettings(page))?.odds_format).toBe('decimal')
    expect((await serverSettings(page))?.unit_size).toBe(40)
  })

  test('an answer lost on the way back still counts as added, and offline it says waiting, not added', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = await download(page)
    await deleteRow(page, 'second')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    // Offline: queued here, and said so.
    await setFlag(page, 'down', '1')
    let dialog = await pickBackup(page, JSON.stringify(backup))
    await dialog.locator('.restore-go').click()
    await expect(dialog.locator('.result-bets')).toContainText('Saved on this device: 1 bet.')
    await expect(dialog.locator('.result-bets')).not.toContainText(/added/i)
    await expect(dialog.locator('.result-overall')).toHaveText('Not finished yet: part of it is still waiting (see above).')
    // Back online, the insert lands but its answer is lost; the retry finds the row with this restore's stamp.
    await setFlag(page, 'lose-answers', '1')
    await setFlag(page, 'down', null)
    await online(page)
    await expect.poll(async () => (await serverRows(page)).some((r) => r.id === id(2))).toBe(true)
    await online(page)
    await expect(dialog.locator('.result-bets')).toContainText('Added: 1 bet.', { timeout: 30_000 })
    await expect(dialog.locator('.result-bets')).not.toContainText('Already on the server')
    dialog = page.locator('.data-modal')
    await expect(dialog.locator('.result-overall')).toHaveText('Finished: everything is on the server.')
  })

  test('restored and undone offline: nothing reaches the server, and the result says so all along', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = await download(page)
    await deleteRow(page, 'second')
    await page.evaluate(() => localStorage.setItem('e2e:moves', '[]'))
    await online(page)
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    await setFlag(page, 'down', '1')
    const dialog = await pickBackup(page, JSON.stringify(backup))
    await dialog.locator('.restore-go').click()
    await expect(dialog.locator('.result-bets')).toContainText('Saved on this device: 1 bet.')
    await expect(dialog.locator('.result-moves')).toContainText('Saved on this device: 1 deposit/withdrawal.')
    await dialog.locator('.result-undo-go').click()
    // Both adds were tried already (no answer: they may have landed), so
    // both removals wait for the server, and say so: nothing is "removed" yet.
    await expect(dialog.locator('.result-undo-state')).toHaveText('Removals saved on this device, waiting to sync: 2.')
    await expect(rows(page).filter({ hasText: 'second' })).toHaveCount(0)
    await setFlag(page, 'down', null)
    await online(page)
    await expect(dialog.locator('.result-undo-state')).toContainText('Removed: 2.', { timeout: 30_000 })
    expect((await serverRows(page)).map((r) => r.note).sort()).toEqual(['first', 'third'])
    expect(await serverMoves(page)).toEqual([])
  })

  test('deposits and withdrawals are restored and undone by the same rules', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = await download(page)
    // The deposit is deleted on the server (another device).
    await page.evaluate(() => localStorage.setItem('e2e:moves', '[]'))
    await online(page)
    const dialog = await pickBackup(page, JSON.stringify(backup))
    await expect(dialog.locator('.restore-counts')).toContainText('1 deposits/withdrawals to add')
    await dialog.locator('.restore-go').click()
    await expect(dialog.locator('.result-moves')).toContainText('Added: 1 deposit/withdrawal.', { timeout: 15_000 })
    expect((await serverMoves(page)).map((m) => m.note)).toEqual(['opening deposit'])
    await dialog.locator('.result-undo-go').click()
    await expect(dialog.locator('.result-undo-state')).toContainText('Removed: 1.', { timeout: 15_000 })
    expect(await serverMoves(page)).toEqual([])
  })
})

test.describe('the five reliability defects', () => {
  test('a refused change stays in the queue until its record can be stored, across a reload', async ({ page }) => {
    await boot(page, { backend: 'live' })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    // Storage turns away the refused list (and only it); the server refuses the next write for good.
    await page.evaluate(() => {
      const real = Storage.prototype.setItem
      Storage.prototype.setItem = function (k: string, v: string) {
        if (k.startsWith('bettracker:refused:') && localStorage.getItem('e2e:refused-full')) throw new DOMException('full', 'QuotaExceededError')
        return real.call(this, k, v)
      }
      localStorage.setItem('e2e:refused-full', '1')
      localStorage.setItem('e2e:fail', JSON.stringify({ status: 400, message: 'new row violates check constraint', code: '23514', times: 1 }))
    })
    await page.click('.add-bet-btn')
    const sheet = page.locator('.quick-modal')
    await sheet.locator('input[type="number"]').first().fill('12')
    await sheet.locator('.seg-btn.loss').click()
    await expect(page.locator('.refusal-blocked-notice')).toBeVisible({ timeout: 15_000 })
    // Still queued: the only stored copy.
    const queued = () => page.evaluate((uid) => (JSON.parse(localStorage.getItem(`bettracker:outbox:${uid}`) ?? '[]') as unknown[]).length, USER.id)
    expect(await queued()).toBe(1)
    // Closed and opened again, with room now (the patch goes with the page):
    // sent again, refused again as it would be, and set apart for good.
    await page.evaluate(() => localStorage.setItem('e2e:fail', JSON.stringify({ status: 400, message: 'new row violates check constraint', code: '23514', times: 1 })))
    await reload(page)
    await expect(page.locator('.refused-notice')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.refused-notice')).toContainText('violates check constraint')
    expect(await queued()).toBe(0)
    expect(await page.evaluate((uid) => localStorage.getItem(`bettracker:refused:${uid}`), USER.id)).not.toBeNull()
  })

  test('an imported row deleted elsewhere after its insert landed (answer lost) is not brought back by the retry', async ({ page }) => {
    await boot(page, { backend: 'live', entries: [] })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    await setFlag(page, 'lose-answers', '1')
    await menu(page, '.data-btn')
    await page.setInputFiles('.data-csv-input', { name: 'a.csv', mimeType: 'text/csv', buffer: Buffer.from('date,stake,amount,note\n2026-08-10,10,15,keep\n2026-08-11,10,-10,delete me') })
    await page.locator('.data-modal .imp-go').click()
    await expect.poll(async () => (await serverRows(page)).length).toBe(2)
    // Another device saw it land and deletes one, through the server.
    await page.evaluate(async () => {
      const all = JSON.parse(localStorage.getItem('e2e:rows') ?? '[]') as { id: string; note: string }[]
      const target = all.find((r) => r.note === 'delete me')?.id
      const mock = (window as unknown as { __supabaseMock: { from: (t: string) => { delete: () => { eq: (c: string, v: unknown) => PromiseLike<unknown> } } } }).__supabaseMock
      await mock.from('entries').delete().eq('id', target)
    })
    // The import is sent again.
    await online(page)
    await expect(page.locator('.sync-badge')).toHaveText('Synced', { timeout: 30_000 })
    expect((await serverRows(page)).map((r) => r.note)).toEqual(['keep'])
    await reload(page)
    await expect(rows(page)).toHaveCount(1)
  })

  test('a settings read answered late, even with no row, never replaces a newer confirmed setting', async ({ page }) => {
    // No settings row on the server yet.
    await boot(page, { backend: 'live' })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    await setFlag(page, 'hold-reads', 'user_settings:list')
    await online(page)
    await expect.poll(() => mine(page, 'reads-held')).toBeGreaterThan(0)
    await menu(page, '.settings-btn')
    await page.locator('.settings-modal .settings-seg .seg-btn', { hasText: 'Decimal' }).click()
    await expect.poll(async () => (await serverSettings(page))?.odds_format).toBe('decimal')
    await page.keyboard.press('Escape')
    // The read that went out before the save comes back now: "no row".
    await setFlag(page, 'hold-reads', null)
    await expect.poll(async () => (await mine(page, 'reads-delivered')) >= (await mine(page, 'reads-held'))).toBe(true)
    expect(await page.evaluate((uid) => JSON.parse(localStorage.getItem(`bettracker:settings:${uid}`) ?? '{}').oddsFormat, USER.id)).toBe('decimal')
    await menu(page, '.settings-btn')
    await expect(page.locator('.settings-modal').getByRole('button', { name: 'Decimal' })).toHaveAttribute('aria-pressed', 'true')
  })

  for (const table of ['entries', 'bankroll_moves'] as const) {
    test(`a read in one window answered late does not bring back what another window deleted (${table})`, async ({ page, context }) => {
      await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
      await expect(page.locator('.sync-badge')).toHaveText('Synced')
      const other = await secondWindow(context)
      // A's read goes out and comes back late.
      await setFlag(page, 'hold-reads', `${table}:list`)
      await online(page)
      await expect.poll(() => mine(page, 'reads-held')).toBeGreaterThan(0)
      // B deletes, and gets it confirmed.
      if (table === 'entries') await deleteRow(other, 'second')
      else {
        await other.locator('.bankroll-card').click()
        const dialog = other.locator('.bank-modal')
        await dialog.locator('.move-item', { hasText: 'opening deposit' }).locator('.btn-icon.danger').click()
        await dialog.locator('.move-item', { hasText: 'opening deposit' }).locator('.btn-icon.danger').click()
        await other.keyboard.press('Escape')
      }
      await expect.poll(async () => (table === 'entries' ? (await serverRows(page)).length : (await serverMoves(page)).length)).toBe(table === 'entries' ? 2 : 0)
      await setFlag(page, 'hold-reads', null)
      // Every late read has been handed over, and the app has taken it in.
      await expect.poll(async () => (await mine(page, 'reads-delivered')) >= (await mine(page, 'reads-held'))).toBe(true)
      // A's late read must not resurrect it, here or in the cache B shows.
      if (table === 'entries') {
        expect(await page.evaluate((uid) => (JSON.parse(localStorage.getItem(`bettracker:cache:${uid}`) ?? '[]') as { note: string }[]).some((b) => b.note === 'second'), USER.id)).toBe(false)
        await expect(rows(page).filter({ hasText: 'second' })).toHaveCount(0)
        await expect(rows(other).filter({ hasText: 'second' })).toHaveCount(0)
      } else {
        expect(await page.evaluate((uid) => (JSON.parse(localStorage.getItem(`bettracker:moves:${uid}`) ?? '[]') as { note: string }[]).length, USER.id)).toBe(0)
      }
    })
  }

  test('a settings change waiting for the storage lock survives a reload, and says where it is', async ({ page, context }) => {
    await boot(page, { backend: 'live', settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    // Another window holds the settings queue's lock for as long as it likes.
    const holder = await secondWindow(context)
    await holder.evaluate((uid) => {
      void navigator.locks.request(`bettracker:queue:settings:${uid}`, () => new Promise<void>((r) => ((window as unknown as { release: () => void }).release = r)))
    }, USER.id)
    await menu(page, '.settings-btn')
    await page.locator('.settings-modal .settings-seg .seg-btn', { hasText: 'American' }).click()
    // Stored on this device at once (its journal), not yet in the cloud.
    await expect(page.locator('.settings-modal .settings-sync')).toHaveText('Saved on this device — syncing to the cloud…')
    await reload(page)
    await holder.evaluate(() => (window as unknown as { release: () => void }).release())
    await expect.poll(async () => (await serverSettings(page))?.odds_format, { timeout: 15_000 }).toBe('american')
  })
})

/** A second window of the app, on the same storage (same browser profile). */
async function secondWindow(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  await page.goto('/')
  await page.waitForSelector('.history-card')
  return page
}

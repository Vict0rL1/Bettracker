import fs from 'node:fs'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { boot, entry, menu, move, reload, USER } from './harness'

/**
 * Regression tests for the audit of 2026-11-05 (base 2bc6310): a restore or
 * an Undo interrupted is resumed and says only what the server said; the
 * settings a restore (or its Undo) writes are reported as the server
 * answered; a read in one window that overlaps more confirmations of another
 * than are kept is read again, never installed; and what the history and the
 * details say. Synchronisation is driven, never waited for: locks held by
 * another window, reads held per window and the fake server's counters.
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
const win = (page: Page): Promise<string> => page.evaluate(() => (window as unknown as { __supabaseMock: { __win: string } }).__supabaseMock.__win)
/** One of the fake server's counters, as this window alone counted it (see fakeSupabase.ts). */
const mine = async (page: Page, name: string): Promise<number> => {
  const w = await win(page)
  return page.evaluate(([n, x]) => Number(localStorage.getItem(`e2e:${n}@${x}`) || 0), [name, w] as const)
}
const history = (page: Page): Promise<Record<string, unknown>[]> => page.evaluate((uid) => JSON.parse(localStorage.getItem(`bettracker:imports:${uid}`) ?? '[]'), USER.id)

async function download(page: Page): Promise<Record<string, unknown>> {
  await menu(page, '.data-btn')
  const [file] = await Promise.all([page.waitForEvent('download'), page.locator('.data-backup').click()])
  const json = JSON.parse(fs.readFileSync((await file.path()) as string, 'utf8')) as Record<string, unknown>
  await page.keyboard.press('Escape')
  return json
}

async function pickBackup(page: Page, backup: Record<string, unknown>, settings = false) {
  await menu(page, '.data-btn')
  await page.setInputFiles('.data-backup-input', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) })
  const dialog = page.locator('.data-modal')
  await expect(dialog.locator('.restore-counts')).toBeVisible()
  if (settings) await dialog.locator('.restore-settings').check()
  return dialog
}

/** The details of the newest batch in the history. */
async function details(page: Page) {
  await menu(page, '.data-btn')
  await page.locator('.data-batch').first().locator('.data-details').click()
  return page.locator('.data-modal')
}

async function deleteRow(page: Page, text: string): Promise<void> {
  const row = rows(page).filter({ hasText: text })
  await row.locator('.btn-icon.danger').click()
  await row.locator('.btn-icon.danger').click()
  await expect(rows(page).filter({ hasText: text })).toHaveCount(0)
}

/** A second window of the app, on the same storage (same browser profile). */
async function secondWindow(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  await page.goto('/')
  await page.waitForSelector('.history-card')
  return page
}

/** Another window holds a lock (a queue's, say) until `release` is called in it. */
async function holdLock(holder: Page, name: string): Promise<void> {
  await holder.evaluate(
    (n) =>
      new Promise<void>((acquired) => {
        void navigator.locks.request(n, () => {
          acquired()
          return new Promise<void>((r) => ((window as unknown as { release: () => void }).release = r))
        })
      }),
    name
  )
}
const release = (holder: Page): Promise<void> => holder.evaluate(() => (window as unknown as { release: () => void }).release())

/** A backup of the seed with one bet and one deposit that are not here (deleted by hand first). */
async function backupWithGaps(page: Page): Promise<Record<string, unknown>> {
  const backup = await download(page)
  await deleteRow(page, 'second')
  await expect(page.locator('.sync-badge')).toHaveText('Synced')
  return backup
}

test.describe('a restore interrupted is resumed, and says only what the server confirmed', () => {
  test('a reload after the restore was written down but before its bets were queued: resumed, added once, never called finished before', async ({ page, context }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = await backupWithGaps(page)
    // Another window holds the bets' queue: the restore is written down, and waits to queue them.
    const holder = await secondWindow(context)
    await holdLock(holder, `bettracker:queue:bets:${USER.id}`)
    const dialog = await pickBackup(page, backup)
    await dialog.locator('.restore-go').click()
    await expect.poll(async () => (await history(page)).length).toBe(1)
    // The window goes before it could queue them.
    await reload(page)
    await menu(page, '.data-btn')
    const batch = page.locator('.data-batch').first()
    await expect(batch).toContainText('not queued yet — it goes on by itself')
    await expect(batch.locator('.data-undo')).toHaveCount(0)
    await batch.locator('.data-details').click()
    const result = page.locator('.data-modal')
    await expect(result.locator('.result-bets')).toContainText('Not queued yet: 1 bet. It goes on by itself; nothing is lost.')
    await expect(result.locator('.result-overall')).toHaveText('Not finished yet: part of it is not queued yet, and goes on by itself.')
    await expect(result.locator('.result-undo-wait')).toBeVisible()
    await release(holder)
    await expect(result.locator('.result-bets')).toContainText('Added: 1 bet.', { timeout: 30_000 })
    await expect(result.locator('.result-overall')).toHaveText('Finished: everything is on the server.')
    expect((await serverRows(page)).filter((r) => r.id === id(2))).toHaveLength(1)
  })

  test('a reload between parts (bets queued, deposits not yet): the deposits are queued after it, nothing twice', async ({ page, context }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = await download(page)
    await deleteRow(page, 'second')
    await page.locator('.bankroll-card').click()
    const bank = page.locator('.bank-modal')
    await bank.locator('.move-item', { hasText: 'opening deposit' }).locator('.btn-icon.danger').click()
    await bank.locator('.move-item', { hasText: 'opening deposit' }).locator('.btn-icon.danger').click()
    await page.keyboard.press('Escape')
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    await expect.poll(async () => (await serverMoves(page)).length).toBe(0)
    const holder = await secondWindow(context)
    await holdLock(holder, `bettracker:queue:moves:${USER.id}`)
    const dialog = await pickBackup(page, backup)
    await dialog.locator('.restore-go').click()
    await expect.poll(async () => ((await history(page))[0]?.parts as { bets?: { phase: string } } | undefined)?.bets?.phase).toBe('queued')
    await reload(page)
    await release(holder)
    await expect.poll(async () => (await serverMoves(page)).length, { timeout: 30_000 }).toBe(1)
    await expect.poll(async () => (await serverRows(page)).filter((r) => r.id === id(2)).length).toBe(1)
    const result = await details(page)
    await expect(result.locator('.result-moves')).toContainText('Added: 1 deposit/withdrawal.', { timeout: 15_000 })
    await expect(result.locator('.result-bets')).toContainText('Added: 1 bet.')
  })

  test('the server took the rows but its answer was lost, then a reload: sent again, told as added once, never as there already', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = await backupWithGaps(page)
    await setFlag(page, 'lose-answers', '1')
    const dialog = await pickBackup(page, backup)
    await dialog.locator('.restore-go').click()
    await expect.poll(async () => (await serverRows(page)).some((r) => r.id === id(2))).toBe(true)
    await reload(page)
    await online(page)
    const result = await details(page)
    await expect(result.locator('.result-bets')).toContainText('Added: 1 bet.', { timeout: 30_000 })
    await expect(result.locator('.result-bets')).not.toContainText('Already on the server')
    expect((await serverRows(page)).filter((r) => r.id === id(2))).toHaveLength(1)
  })

  test('the row landed, its answer was lost, and another device deleted it before the retry: skipped, said so, never added', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = await backupWithGaps(page)
    await setFlag(page, 'lose-answers', '1')
    const dialog = await pickBackup(page, backup)
    await dialog.locator('.restore-go').click()
    await expect.poll(async () => (await serverRows(page)).some((r) => r.id === id(2))).toBe(true)
    // Another device deletes it (migration 007 keeps its stamp), before this one sends it again.
    await page.evaluate((gone) => {
      const all = JSON.parse(localStorage.getItem('e2e:rows') ?? '[]') as { id: string; updated_at: string }[]
      const row = all.find((r) => r.id === gone) as { updated_at: string }
      localStorage.setItem('e2e:rows', JSON.stringify(all.filter((r) => r.id !== gone)))
      const stones = JSON.parse(localStorage.getItem('e2e:tombstones') ?? '{}') as Record<string, string>
      localStorage.setItem('e2e:tombstones', JSON.stringify({ ...stones, [`rows:${gone}`]: row.updated_at }))
    }, id(2))
    await online(page)
    const result = page.locator('.data-modal')
    await expect(result.locator('.result-bets')).toContainText('Skipped by the server (deleted on another device since): 1.', { timeout: 30_000 })
    await expect(result.locator('.result-bets')).not.toContainText('Added')
    await expect(result.locator('.result-overall')).toHaveText('Finished: what is not on the server was skipped by it or changed later (see above).')
    expect((await serverRows(page)).some((r) => r.id === id(2))).toBe(false)
  })

  test('offline, through a reload: saved on this device, never finished, until the server says so', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = await backupWithGaps(page)
    await setFlag(page, 'down', '1')
    const dialog = await pickBackup(page, backup)
    await dialog.locator('.restore-go').click()
    const result = page.locator('.data-modal')
    await expect(result.locator('.result-bets')).toContainText('1 bet', { timeout: 15_000 })
    await expect(result.locator('.result-bets')).not.toContainText('Added')
    await expect(result.locator('.result-overall')).not.toHaveText(/Finished/)
    await reload(page)
    const again = await details(page)
    await expect(again.locator('.result-bets')).toContainText('Saved on this device: 1 bet. Will sync when you’re back online.')
    await expect(again.locator('.result-overall')).toHaveText('Not finished yet: part of it is still waiting (see above).')
    await setFlag(page, 'down', null)
    await online(page)
    await expect(again.locator('.result-bets')).toContainText('Added: 1 bet.', { timeout: 30_000 })
    await expect(again.locator('.result-overall')).toHaveText('Finished: everything is on the server.')
  })

  test('another window shows the same restore, as the server answered it', async ({ page, context }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = await backupWithGaps(page)
    const other = await secondWindow(context)
    const dialog = await pickBackup(page, backup)
    await dialog.locator('.restore-go').click()
    await expect(dialog.locator('.result-bets')).toContainText('Added: 1 bet.', { timeout: 15_000 })
    const result = await details(other)
    await expect(result.locator('.result-bets')).toContainText('Added: 1 bet.', { timeout: 15_000 })
    await expect(result.locator('.result-overall')).toHaveText('Finished: everything is on the server.')
  })
})

test.describe('the history keeps what to do about a batch that is not finished', () => {
  test('an entry with rows the device has no answer for says so, and Check again asks the server', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    // An import whose answers were never recorded: one of its rows is on the server with its stamp, the other is not.
    const stamp = (await serverRows(page)).find((r) => r.id === id(1))?.updated_at as string
    await page.evaluate(
      ({ uid, ids, stamp }) =>
        localStorage.setItem(
          `bettracker:imports:${uid}`,
          JSON.stringify([{ id: 'old-import', at: stamp, file: 'august.csv', fingerprint: 'fp', ids, stamp, parts: { bets: { phase: 'queued' } } }])
        ),
      { uid: USER.id, ids: [id(1), id(9)], stamp }
    )
    await reload(page)
    await menu(page, '.data-btn')
    const batch = page.locator('.data-batch').first()
    await expect(batch).toContainText('not finished — see details')
    await expect(batch).not.toContainText('imported')
    await batch.locator('.data-recover-check').click()
    await expect(batch).toContainText('finished — part was not added (see details)')
    await batch.locator('.data-details').click()
    const result = page.locator('.data-modal')
    await expect(result.locator('.result-bets')).toContainText('Added: 1 bet.')
    await expect(result.locator('.result-bets')).toContainText('Not on the server (never arrived, or deleted since): 1 bet. To add them, pick the file again')
    await expect(result.locator('.result-recover-pickAgain')).toHaveText('Pick the file again')
    await expect(result.locator('.result-overall')).toHaveText('Finished, but part of it is not on the server (see above).')
  })
})

test.describe('settings restored: reported as the server answered', () => {
  const withOdds = (backup: Record<string, unknown>, oddsFormat: string): Record<string, unknown> => ({ ...backup, settings: { ...(backup.settings as object), oddsFormat } })

  test('a settings restore the server refuses for good is reported as refused, never as replaced or finished, and can be tried again after a reload', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = withOdds(await download(page), 'american')
    await setFlag(page, 'fail', JSON.stringify({ status: 400, message: 'new row violates check constraint', code: '23514', times: 1 }))
    const dialog = await pickBackup(page, backup, true)
    await dialog.locator('.restore-go').click()
    const settings = dialog.locator('.result-settings')
    await expect(settings).toContainText('Refused by the server, not replaced: odds format. Choose Try the settings again.', { timeout: 15_000 })
    await expect(settings).not.toContainText('Replaced')
    await expect(dialog.locator('.result-reason')).toHaveText('The server said: new row violates check constraint')
    await expect(dialog.locator('.result-overall')).toHaveText('Not finished: part of it needs you (see above).')
    expect((await serverSettings(page))?.odds_format).toBe('decimal')
    await reload(page)
    const result = await details(page)
    await expect(result.locator('.result-settings')).toContainText('Refused by the server, not replaced: odds format.')
    await result.locator('.result-recover-retrySettings').click()
    await expect(result.locator('.result-settings')).toContainText('Replaced: odds format.', { timeout: 15_000 })
    await expect(result.locator('.result-overall')).toHaveText('Finished: everything is on the server.')
    expect((await serverSettings(page))?.odds_format).toBe('american')
  })

  test('a newer edit from another device wins: not replaced, said so, and that edit stays', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = withOdds(await download(page), 'american')
    await setFlag(page, 'down', '1')
    const dialog = await pickBackup(page, backup, true)
    await dialog.locator('.restore-go').click()
    await expect(dialog.locator('.result-settings')).toContainText('Saved on this device, waiting to sync: odds format.', { timeout: 15_000 })
    // Meanwhile another device sets the odds format, later.
    await page.evaluate(() => {
      const row = JSON.parse(localStorage.getItem('e2e:settings') ?? '{}') as Record<string, unknown>
      localStorage.setItem('e2e:settings', JSON.stringify({ ...row, odds_format: 'fractional', updated_at: new Date(Date.now() + 3_600_000).toISOString() }))
    })
    await setFlag(page, 'down', null)
    await online(page)
    await expect(dialog.locator('.result-settings')).toContainText('Not replaced, changed later (here or on another device): odds format.', { timeout: 15_000 })
    await expect(dialog.locator('.result-settings')).not.toContainText('Replaced:')
    expect((await serverSettings(page))?.odds_format).toBe('fractional')
  })

  test('a later edit here, before the restore synced: not replaced, and the later edit is what reaches the server', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = await download(page)
    await setFlag(page, 'down', '1')
    const dialog = await pickBackup(page, { ...backup, settings: { ...(backup.settings as object), unitSize: 25 } }, true)
    await dialog.locator('.restore-go').click()
    await expect(dialog.locator('.result-settings')).toContainText('Saved on this device, waiting to sync: unit size.', { timeout: 15_000 })
    await page.keyboard.press('Escape')
    await menu(page, '.settings-btn')
    const box = page.locator('.settings-modal input[inputmode="decimal"]').first()
    await box.fill('30')
    await box.blur()
    await page.keyboard.press('Escape')
    await setFlag(page, 'down', null)
    await online(page)
    await expect.poll(async () => Number((await serverSettings(page))?.unit_size), { timeout: 15_000 }).toBe(30)
    const result = await details(page)
    await expect(result.locator('.result-settings')).toContainText('Not replaced, changed later (here or on another device): unit size.', { timeout: 15_000 })
  })

  test('an Undo the server guard skips (changed on another device since): kept, never "put back"', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const backup = withOdds(await download(page), 'american')
    const dialog = await pickBackup(page, backup, true)
    await dialog.locator('.restore-go').click()
    await expect(dialog.locator('.result-settings')).toContainText('Replaced: odds format.', { timeout: 15_000 })
    // Another device changes it, after the restore; this device has not heard yet.
    await page.evaluate(() => {
      const row = JSON.parse(localStorage.getItem('e2e:settings') ?? '{}') as Record<string, unknown>
      localStorage.setItem('e2e:settings', JSON.stringify({ ...row, odds_format: 'fractional', updated_at: new Date().toISOString() }))
    })
    await dialog.locator('.result-undo-go').click()
    await expect(dialog.locator('.result-undo-state')).toContainText('Settings kept because they changed since: odds format.', { timeout: 15_000 })
    await expect(dialog.locator('.result-undo-state')).not.toContainText('put back')
    expect((await serverSettings(page))?.odds_format).toBe('fractional')
  })
})

test.describe('a late read that overlaps more confirmations than are kept', () => {
  // 210 deletes, sent one by one by another window.
  test.describe.configure({ timeout: 180_000 })
  const MANY = 210
  const many = Array.from({ length: MANY }, (_, i) => entry({ id: id(1000 + i), date: '2026-06-01', amount: 1, note: `many ${i}` }))
  const manyMoves = Array.from({ length: MANY }, (_, i) => move({ id: id(5000 + i), date: '2026-06-01', amount: 1, note: `move ${i}` }))

  for (const table of ['bets', 'moves'] as const) {
    test(`is discarded and read again, never installed: nothing another window deleted comes back (${table})`, async ({ page, context }) => {
      await boot(page, table === 'bets' ? { backend: 'live', entries: many, settings: SETTINGS } : { backend: 'live', entries: BETS, moves: manyMoves, settings: SETTINGS })
      await expect(page.locator('.sync-badge')).toHaveText('Synced')
      const other = await secondWindow(context)
      // This window's list read goes out, and comes back late.
      const w = await win(page)
      await setFlag(page, `hold-reads@${w}`, table === 'bets' ? 'entries:list' : 'bankroll_moves:list')
      await page.evaluate(
        ({ key, uid }) => {
          ;(window as unknown as { __stale: boolean }).__stale = false
          const setItem = Storage.prototype.setItem
          Storage.prototype.setItem = function (k: string, v: string) {
            // Once the other window's deletes are confirmed, a copy with any of them is the late read installed.
            if (k === `${key}${uid}` && localStorage.getItem('e2e:all-gone') && /"(many|move) \d+"/.test(v)) (window as unknown as { __stale: boolean }).__stale = true
            return setItem.call(this, k, v)
          }
        },
        { key: table === 'bets' ? 'bettracker:cache:' : 'bettracker:moves:', uid: USER.id }
      )
      await online(page)
      await expect.poll(() => mine(page, 'reads-held')).toBeGreaterThan(0)
      // The other window deletes all of them, one confirmation each: more than the log keeps.
      await other.evaluate(
        ({ key, ids }) => localStorage.setItem(key, JSON.stringify(ids.map((x, i) => ({ opId: `del-${i}`, kind: 'delete', id: x })))),
        { key: table === 'bets' ? `bettracker:outbox:${USER.id}` : `bettracker:moves-outbox:${USER.id}`, ids: (table === 'bets' ? many : manyMoves).map((r) => r.id) }
      )
      await online(other)
      await expect.poll(async () => (table === 'bets' ? (await serverRows(page)).length : (await serverMoves(page)).length), { timeout: 150_000 }).toBe(0)
      await page.evaluate(() => localStorage.setItem('e2e:all-gone', '1'))
      await setFlag(page, `hold-reads@${w}`, null)
      await expect.poll(async () => (await mine(page, 'reads-delivered')) >= (await mine(page, 'reads-held'))).toBe(true)
      // The late read was read again: what shows, and what is cached, has none of them.
      if (table === 'bets') {
        await expect(rows(page).filter({ hasText: 'many' })).toHaveCount(0, { timeout: 15_000 })
        await expect.poll(() => page.evaluate((uid) => (JSON.parse(localStorage.getItem(`bettracker:cache:${uid}`) ?? '[]') as unknown[]).length, USER.id)).toBe(0)
      } else {
        await expect.poll(() => page.evaluate((uid) => (JSON.parse(localStorage.getItem(`bettracker:moves:${uid}`) ?? '[]') as unknown[]).length, USER.id), { timeout: 15_000 }).toBe(0)
      }
      expect(await page.evaluate(() => (window as unknown as { __stale: boolean }).__stale)).toBe(false)
    })
  }

  test('a window that can not write its confirmation down says so, and a read out elsewhere is read again', async ({ page, context }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    const other = await secondWindow(context)
    // The other window's storage refuses the shared log.
    await other.evaluate((key) => {
      const setItem = Storage.prototype.setItem
      Storage.prototype.setItem = function (k: string, v: string) {
        if (k === key) throw new DOMException('full', 'QuotaExceededError')
        return setItem.call(this, k, v)
      }
    }, `bettracker:confirmed-bets:${USER.id}`)
    const w = await win(page)
    await setFlag(page, `hold-reads@${w}`, 'entries:list')
    // A copy with the bet in it, written after its delete was confirmed, is the late read installed.
    await page.evaluate(
      ({ uid, gone }) => {
        const setItem = Storage.prototype.setItem
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key === `bettracker:cache:${uid}` && localStorage.getItem('e2e:deleted')) {
            if (value.includes(gone)) (window as unknown as { __stale: boolean }).__stale = true
            else (window as unknown as { __fresh: boolean }).__fresh = true
          }
          return setItem.call(this, key, value)
        }
      },
      { uid: USER.id, gone: id(2) }
    )
    await online(page)
    await expect.poll(() => mine(page, 'reads-held')).toBeGreaterThan(0)
    await deleteRow(other, 'second')
    await expect.poll(async () => (await serverRows(page)).length).toBe(2)
    await page.evaluate(() => localStorage.setItem('e2e:deleted', '1'))
    await setFlag(page, `hold-reads@${w}`, null)
    await expect.poll(async () => (await mine(page, 'reads-delivered')) >= (await mine(page, 'reads-held'))).toBe(true)
    // A list read after the delete is installed (the late one was read again)...
    await expect.poll(() => page.evaluate(() => (window as unknown as { __fresh: boolean }).__fresh), { timeout: 15_000 }).toBe(true)
    // ...and the late one, from before it, never was: the bet stays gone in both windows.
    expect(await page.evaluate(() => (window as unknown as { __stale?: boolean }).__stale ?? false)).toBe(false)
    await expect(rows(page).filter({ hasText: 'second' })).toHaveCount(0)
    await expect(rows(other).filter({ hasText: 'second' })).toHaveCount(0)
  })
})

test.describe('what the history and the details say, as it is', () => {
  const CSV = ['date,stake,amount,sport,book,bet_type,note', '2026-08-10,25.00,75.00,Tennis,Pinnacle,Moneyline,"imported, first"', '2026-08-11,40.00,-40.00,Tennis,Pinnacle,Spread,imported second'].join('\r\n')

  async function importFile(page: Page, csv: string, name: string) {
    await menu(page, '.data-btn')
    const dialog = page.locator('.data-modal')
    await page.setInputFiles('.data-csv-input', { name, mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await dialog.locator('.imp-summary').waitFor()
    await dialog.locator('.imp-go').click()
    await dialog.waitFor({ state: 'detached' })
  }

  test('an import the server refused, let go from the notice: "nothing was added", never imported nor finished, and no Undo', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    await setFlag(page, 'fail', JSON.stringify({ status: 400, message: 'new row violates check constraint', code: '23514', times: 1 }))
    await importFile(page, CSV, 'refused.csv')
    await expect(page.locator('.refused-notice')).toBeVisible({ timeout: 15_000 })
    const result = await details(page)
    await expect(result.locator('.result-bets')).toContainText('Refused by the server: 2 bets. Send it again, or let it go from the notice at the top.')
    await expect(result.locator('.result-recover-sendAgain')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.locator('.refused-notice .notice-discard').click()
    await expect(page.locator('.refused-notice')).toHaveCount(0)
    await menu(page, '.data-btn')
    const batch = page.locator('.data-batch', { hasText: 'refused.csv' })
    await expect(batch).toContainText('finished — nothing was added (see details)')
    await expect(batch.locator('.data-undo')).toHaveCount(0)
    await batch.locator('.data-details').click()
    await expect(result.locator('.result-bets')).toContainText('Refused by the server, not added: 2 bets.')
    await expect(result.locator('.result-bets')).not.toContainText('notice at the top')
    await expect(result.locator('.result-bets')).toHaveClass(/has-gap/)
    await expect(result.locator('.result-overall')).toHaveText('Finished, but none of it is on the server (see above).')
    await expect(result.locator('.result-recover-sendAgain')).toHaveCount(0)
    await expect(result.locator('.result-undo-nothing')).toHaveText('None of it is on the server: there is nothing to undo.')
    await expect(result.locator('.result-undo-go')).toHaveCount(0)
  })

  test('an import undone with a bet edited since: "changed since the import", not since a restore', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    await importFile(page, CSV, 'august.csv')
    await expect(page.locator('.sync-badge')).toHaveText('Synced', { timeout: 15_000 })
    // One of its bets is edited on another device: its stamp is not the import's any more.
    await page.evaluate(() => {
      const all = JSON.parse(localStorage.getItem('e2e:rows') ?? '[]') as { note: string; updated_at: string }[]
      for (const r of all) if (r.note === 'imported second') r.updated_at = new Date(Date.now() + 60_000).toISOString()
      localStorage.setItem('e2e:rows', JSON.stringify(all))
    })
    await online(page)
    const result = await details(page)
    await expect(result.locator('.result-bets')).toContainText('Added: 2 bets.')
    await result.locator('.result-undo-go').click()
    await expect(result.locator('.result-undo-state')).toContainText('Kept, changed since the import (here or on another device): 1.', { timeout: 15_000 })
    await expect(result.locator('.result-undo-state')).not.toContainText('restore')
  })

  test('an entry from before this version: no answer was kept, and it does not say all of it is on the server', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await page.evaluate((uid) => localStorage.setItem(`bettracker:imports:${uid}`, JSON.stringify([{ id: 'old', at: '2026-10-01T10:00:00.000Z', file: 'old.csv', fingerprint: 'fp-old', ids: ['a', 'b'] }])), USER.id)
    await reload(page)
    const result = await details(page)
    await expect(result.locator('.result-bets')).toContainText('From before this version, as they were queued (no answer was kept): 2 bets.')
    await expect(result.locator('.result-overall')).toHaveText('From before this version: what the server did with it was not recorded.')
    await expect(result.locator('.result-recover-check')).toHaveCount(0)
  })

  test('finished with gaps: "part was not added" with Undo kept, an amber border, and each text names only a button that is there', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    const AT = '2026-11-05T10:00:00.000Z'
    const settings = (over: Record<string, unknown>) => ({ before: { oddsFormat: 'decimal', unitSize: 10 }, after: { oddsFormat: 'american', unitSize: 25 }, editedAt: AT, phase: 'queued', ...over })
    await page.evaluate(
      ({ uid, ids, AT, s1, u2 }) => {
        localStorage.setItem(
          `bettracker:imports:${uid}`,
          JSON.stringify([
            // One bet made, one not there when asked again.
            { id: 'mixed', at: '2026-11-06T09:00:00.000Z', file: 'mixed.csv', fingerprint: 'fp-mixed', ids: [ids[0], ids[1]], stamp: '2026-11-06T09:00:00.000Z', parts: { bets: { phase: 'queued' } }, made: [ids[0]], missing: [ids[1]] },
            // A restore: unit size replaced, odds format not on the server (asked again).
            { id: 'gap', kind: 'restore', at: AT, file: 'gap.json', fingerprint: 'fp-gap', ids: [], moveIds: [], stamp: AT, parts: {}, restore: { skippedBets: 0, skippedMoves: 0, skippedDuplicates: 0, settings: s1, failed: [], held: [] } },
            // The same, undone, with a bet not there when asked: unit size was to go back, and the server still has the backup's.
            {
              id: 'undone',
              kind: 'restore',
              at: '2026-11-04T10:00:00.000Z',
              file: 'undone.json',
              fingerprint: 'fp-undone',
              ids: [ids[2]],
              moveIds: [],
              stamp: AT,
              parts: { bets: { phase: 'queued' } },
              missing: [ids[2]],
              undone: true,
              restore: { skippedBets: 0, skippedMoves: 0, skippedDuplicates: 0, settings: s1, failed: [], held: [] },
              undo: { at: AT, stamp: AT, phase: 'queued', bets: [], moves: [], changedHere: 0, goneHere: 0, removed: [], kept: [], settings: u2 }
            }
          ])
        )
      },
      {
        uid: USER.id,
        ids: [id(1), id(2), id(3)],
        AT,
        s1: settings({ confirmed: ['unitSize'], missing: ['oddsFormat'] }),
        u2: { asked: ['unitSize'], keptHere: [], already: ['oddsFormat'], editedAt: '2026-11-05T11:00:00.000Z', phase: 'queued', missing: ['unitSize'] }
      }
    )
    await reload(page)
    await menu(page, '.data-btn')
    const mixed = page.locator('.data-batch', { hasText: 'mixed.csv' })
    await expect(mixed).toContainText('finished — part was not added (see details)')
    await expect(mixed.locator('.data-undo')).toBeVisible()
    await expect(page.locator('.data-batch', { hasText: 'gap.json' })).toContainText('finished — part was not added (see details)')
    const undone = page.locator('.data-batch', { hasText: 'undone.json' })
    await expect(undone).toContainText('undone — part was not put back (see details)')
    await expect(undone.locator('.data-recover-retrySettings')).toBeVisible()
    const result = page.locator('.data-modal')

    await mixed.locator('.data-details').click()
    await expect(result.locator('.result-overall')).toHaveText('Finished, but part of it is not on the server (see above).')
    await expect(result.locator('.result-bets')).toContainText('Not on the server (never arrived, or deleted since): 1 bet. To add them, pick the file again')
    await expect(result.locator('.result-bets')).toHaveClass(/has-gap/)
    const amber = await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.color = 'var(--amber)'
      document.body.appendChild(probe)
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    })
    await expect(result.locator('.result-bets')).toHaveCSS('border-left-color', amber)
    await expect(result.locator('.result-undo-go')).toBeVisible()
    // Done goes back to the list.
    await result.locator('.result-done').click()

    await page.locator('.data-batch', { hasText: 'gap.json' }).locator('.data-details').click()
    await expect(result.locator('.result-settings')).toContainText('Replaced: unit size.')
    await expect(result.locator('.result-settings')).toContainText('Not on the server, which still has the value from before: odds format. To apply the backup’s, choose Try the settings again.')
    await expect(result.locator('.result-settings')).toHaveCSS('border-left-color', amber)
    await expect(result.locator('.result-recover-retrySettings')).toHaveText('Try the settings again')
    await result.locator('.result-done').click()

    await page.locator('.data-batch', { hasText: 'undone.json' }).locator('.data-details').click()
    // The restore's own row and setting: said as they are, with no button that is not there.
    await expect(result.locator('.result-bets')).toContainText('Not on the server (never arrived, or deleted since): 1 bet.')
    await expect(result.locator('.result-bets')).not.toContainText('pick the file again')
    await expect(result.locator('.result-recover-pickAgain')).toHaveCount(0)
    await expect(result.locator('.result-settings')).toContainText('Not on the server, which still has the value from before: odds format.')
    await expect(result.locator('.result-settings')).not.toContainText('choose')
    // Its Undo's: not put back (with its button, in its section), and what it had nothing to put back for.
    await expect(result.locator('.result-undo-state')).toContainText('Not put back, the server still has the backup’s value: unit size. To put it back, choose Try the settings again.')
    await expect(result.locator('.result-undo-state')).toContainText('Nothing to put back, it still had the value from before: odds format.')
    await expect(result.locator('.result-undo-state')).not.toContainText('changed since')
    await expect(result.locator('.result-undo .result-recover-retrySettings')).toBeVisible()
  })

  test('an Undo of a restore whose setting never arrived: nothing to put back, said as a restore, never as a later change', async ({ page }) => {
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    const AT = '2026-11-05T10:00:00.000Z'
    await page.evaluate(
      ({ uid, AT }) =>
        localStorage.setItem(
          `bettracker:imports:${uid}`,
          JSON.stringify([
            {
              id: 'lost',
              kind: 'restore',
              at: AT,
              file: 'lost.json',
              fingerprint: 'fp-lost',
              ids: [],
              moveIds: [],
              stamp: AT,
              parts: {},
              restore: { skippedBets: 0, skippedMoves: 0, skippedDuplicates: 0, settings: { before: { oddsFormat: 'decimal' }, after: { oddsFormat: 'american' }, editedAt: AT, phase: 'queued' }, failed: [], held: [] }
            }
          ])
        ),
      { uid: USER.id, AT }
    )
    await reload(page)
    await expect(page.locator('.sync-badge')).toHaveText('Synced')
    await menu(page, '.data-btn')
    const batch = page.locator('.data-batch', { hasText: 'lost.json' })
    await batch.locator('.data-undo').click()
    await expect(page.locator('.toast')).toContainText('Nothing to undo: nothing this restore added or set is left to take back.')
    await expect(page.locator('.toast')).not.toContainText('later change')
    await batch.locator('.data-details').click()
    const result = page.locator('.data-modal')
    await expect(result.locator('.result-undo-state')).toHaveText(/Nothing to put back, it still had the value from before: odds format\./)
    await expect(result.locator('.result-undo-state')).not.toContainText('changed since')
    expect((await serverSettings(page))?.odds_format).toBe('decimal')
  })

  test('a batch with something to do, in a desktop window, in Spanish: its buttons go under its name, which keeps its width', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 })
    await page.addInitScript(() => localStorage.setItem('bettracker:lang', 'es'))
    await boot(page, { backend: 'live', entries: BETS, moves: MOVES, settings: SETTINGS })
    await page.evaluate(
      ({ uid, ids }) => {
        localStorage.setItem(
          `bettracker:imports:${uid}`,
          JSON.stringify([
            {
              id: 'needs',
              kind: 'restore',
              at: '2026-11-05T10:00:00.000Z',
              file: 'copia-de-seguridad-noviembre-2026.json',
              fingerprint: 'fp-needs',
              ids,
              stamp: '2026-11-05T10:00:00.000Z',
              parts: { bets: { phase: 'queued' } },
              made: [ids[0]],
              restore: {
                skippedBets: 0,
                skippedMoves: 0,
                skippedDuplicates: 0,
                settings: { before: { oddsFormat: 'decimal' }, after: { oddsFormat: 'american' }, editedAt: '2026-11-05T10:00:00.000Z', phase: 'queued', rejected: ['oddsFormat'] },
                failed: [],
                held: []
              }
            }
          ])
        )
      },
      { uid: USER.id, ids: [id(1), id(2)] }
    )
    await reload(page)
    await menu(page, '.data-btn')
    const batch = page.locator('.data-batch').first()
    await expect(batch).toHaveClass(/has-recover/)
    await expect(batch.locator('.data-recover-check')).toHaveText('Comprobar de nuevo')
    await expect(batch.locator('.data-recover-retrySettings')).toHaveText('Reintentar los ajustes')
    const name = await batch.locator('.data-batch-text').boundingBox()
    const actions = await batch.locator('.data-batch-actions').boundingBox()
    expect(name?.width ?? 0).toBeGreaterThan(300)
    expect(actions?.y ?? 0).toBeGreaterThanOrEqual((name?.y ?? 0) + (name?.height ?? 0) - 1)
  })

  test('the Add bet button and the first steps say a bet can be for any day', async ({ page }) => {
    await boot(page, { backend: 'live', entries: [], settings: SETTINGS })
    await expect(page.locator('.add-bet-btn')).toHaveAttribute('title', 'Add a bet (T). Pick its date in the form: Today, Yesterday or any day.')
  })
})

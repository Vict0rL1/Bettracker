import { expect, test, type Page } from '@playwright/test'
import { boot, entry, reload } from './harness'

const sheet = (page: Page) => page.locator('.quick-modal')
const stakeBox = (page: Page) => sheet(page).locator('.quick-row').first().locator('input').first()
const oddsBox = (page: Page) => sheet(page).locator('.quick-row input[type=text]')
const rows = (page: Page) => page.locator('.history-card tbody tr')

test.describe('quick add: free bets and results that can’t be worked out', () => {
  // Stake $0, decimal odds 2.0, WON: the stake works out a $0 profit, which is
  // no win. It used to fail silently: the sheet closed and nothing was logged.
  test('a free bet’s win asks for the promotional profit, and counts as bonus, not ROI', async ({ page }) => {
    await boot(page, { settings: { oddsFormat: 'decimal' } })
    const roiBefore = await page.locator('.roi-card .life-value').textContent()
    await page.click('.add-bet-btn')
    await stakeBox(page).fill('0')
    await expect(sheet(page).locator('.free-bet-note')).toContainText('Free bet: no cash at risk.')
    await oddsBox(page).fill('2.0')
    await sheet(page).locator('.seg-btn.win').click()

    const profit = sheet(page).locator('.quick-profit')
    await expect(profit).toContainText('Promotional profit')
    await expect(sheet(page).locator('.hint')).toContainText('A free bet’s profit can’t be worked out from a $0 stake.')
    await expect(profit.locator('input')).toBeFocused()
    // Saving without it says what is missing, next to the box.
    await sheet(page).locator('.quick-save').click()
    await expect(profit.locator('.field-error')).toHaveText('Enter the amount, more than 0.')
    await expect(sheet(page)).toBeVisible()

    await profit.locator('input').fill('25')
    await sheet(page).locator('.quick-save').click()
    await expect(sheet(page)).toHaveCount(0)
    await expect(page.locator('.toast')).toContainText('Added a bet')
    await expect(rows(page).first().locator('.td-amt')).toHaveText('+$25.00')
    // P/L counts it; ROI does not, and the bonus is said apart.
    await expect(page.locator('.pl-card .life-value')).toHaveText('+$205.00')
    await expect(page.locator('.roi-card .life-value')).toHaveText(roiBefore ?? '')
    await expect(page.locator('.roi-card .bonus')).toHaveText('+$25.00 bonus from 1 free bet')
  })

  test('a free bet that loses is logged as lost at $0', async ({ page }) => {
    await boot(page)
    await page.click('.add-bet-btn')
    await stakeBox(page).fill('0')
    await sheet(page).locator('.seg-btn.loss').click()
    await expect(sheet(page)).toHaveCount(0)
    const row = rows(page).first()
    await expect(row.locator('.pill')).toHaveText('LOST')
    await expect(row.locator('.td-amt')).toHaveText('$0.00')
  })

  test('a profit that rounds to $0.00 is asked for, saying why', async ({ page }) => {
    await boot(page, { settings: { oddsFormat: 'decimal' } })
    await page.click('.add-bet-btn')
    await stakeBox(page).fill('0.01')
    await oddsBox(page).fill('1.2')
    await sheet(page).locator('.seg-btn.win').click()
    await expect(sheet(page).locator('.hint')).toContainText('the profit on this stake rounds to $0.00')
    await sheet(page).locator('.quick-profit input').fill('0.004')
    await sheet(page).locator('.quick-save').click()
    await expect(sheet(page).locator('.quick-profit .field-error')).toHaveText('That rounds to 0.00. Enter at least 0.01.')
    await sheet(page).locator('.quick-profit input').fill('0.01')
    await sheet(page).locator('.quick-save').click()
    await expect(rows(page).first().locator('.td-amt')).toHaveText('+$0.01')
  })
})

test.describe('quick add: problems in words, and nothing lost on the way', () => {
  test('a result tapped without a stake says so next to the stake, which takes the focus', async ({ page }) => {
    await boot(page)
    await page.click('.add-bet-btn')
    await stakeBox(page).fill('')
    await oddsBox(page).fill('+abc')
    await sheet(page).locator('.seg-btn.win').click()
    await expect(sheet(page)).toBeVisible()
    await expect(stakeBox(page)).toBeFocused()
    await expect(stakeBox(page)).toHaveAttribute('aria-invalid', 'true')
    const described = await stakeBox(page).evaluate((el) =>
      (el.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' | ')
    )
    expect(described).toContain('Enter the stake (0 for a free bet).')
    await expect(sheet(page).locator('.field-error').nth(1)).toHaveText('Not a price this app can read. Type it like +150, or leave it empty.')
    // The buttons are never dead: they say what is wrong instead.
    await expect(sheet(page).locator('.seg-btn.win')).toBeEnabled()
  })

  test('a bet refused on the way in keeps the sheet open with everything typed, and says why', async ({ page }) => {
    await boot(page, { settings: { oddsFormat: 'american' } })
    await page.click('.add-bet-btn')
    await stakeBox(page).fill('40')
    await oddsBox(page).fill('+120')
    // The outbox can't take the change (here: no ids to give it).
    await page.evaluate(() => {
      const real = crypto.randomUUID.bind(crypto)
      ;(window as unknown as { __realUuid: () => string }).__realUuid = real
      crypto.randomUUID = () => {
        throw new Error('No ids today')
      }
    })
    await sheet(page).locator('.seg-btn.win').click()
    await expect(sheet(page).locator('.form-error')).toHaveText('No ids today')
    await expect(sheet(page).locator('.form-error')).toHaveAttribute('role', 'alert')
    await expect(stakeBox(page)).toHaveValue('40')
    await expect(oddsBox(page)).toHaveValue('+120')
    await expect(rows(page)).toHaveCount(3)

    await page.evaluate(() => {
      crypto.randomUUID = (window as unknown as { __realUuid: () => `${string}-${string}-${string}-${string}-${string}` }).__realUuid
    })
    await sheet(page).locator('.seg-btn.win').click()
    await expect(sheet(page)).toHaveCount(0)
    await expect(rows(page).first().locator('.td-amt')).toHaveText('+$48.00')
  })

  test('closed by accident, the sheet keeps what was typed, across a reload, until saved or discarded', async ({ page }) => {
    await boot(page, { settings: { defaultStake: 25 } })
    await page.click('.add-bet-btn')
    await stakeBox(page).fill('70')
    await oddsBox(page).fill('-110')
    await page.keyboard.press('Escape')
    await expect(page.locator('.toast')).toContainText('Not saved yet: what you typed is kept.')

    await reload(page)
    await page.click('.add-bet-btn')
    await expect(sheet(page).locator('.draft-note')).toContainText('Your unfinished bet is back.')
    await expect(stakeBox(page)).toHaveValue('70')
    await expect(oddsBox(page)).toHaveValue('-110')

    await sheet(page).locator('.draft-discard').click()
    await expect(stakeBox(page)).toHaveValue('25')
    await expect(oddsBox(page)).toHaveValue('')
    await page.keyboard.press('Escape')
    await page.click('.add-bet-btn')
    await expect(sheet(page).locator('.draft-note')).toHaveCount(0)

    // Saved, the draft is gone too.
    await stakeBox(page).fill('15')
    await sheet(page).locator('.seg-btn.pending').click()
    await expect(sheet(page)).toHaveCount(0)
    await page.click('.add-bet-btn')
    await expect(sheet(page).locator('.draft-note')).toHaveCount(0)
  })

  test('More details carries what was typed to the full form for today', async ({ page }) => {
    await boot(page, { settings: { oddsFormat: 'decimal' } })
    await page.click('.add-bet-btn')
    await stakeBox(page).fill('12')
    await oddsBox(page).fill('2.4')
    await sheet(page).locator('.quick-more').click()
    const day = page.locator('.day-modal')
    await expect(day).toBeVisible()
    await expect(day.locator('.field').nth(0).locator('input')).toHaveValue('12')
    await expect(day.locator('.odds-input').first()).toHaveValue('2.4')
  })
})

test.describe('editing one bet from the history', () => {
  const BETS = [
    entry({ id: 'a', date: '2026-08-01', amount: 200, note: 'legacy', sport: 'NBA', book: 'DK', betType: 'Parlay' }),
    entry({ id: 'b', date: '2026-08-02', amount: -50, stake: 50, note: 'first of the day', sport: 'NBA', book: 'DK', betType: 'Spread' }),
    entry({ id: 'c', date: '2026-08-02', amount: 30, stake: 60, note: 'second of the day', sport: 'NFL', book: 'FanDuel', betType: 'Moneyline' })
  ]

  test('the pencil opens that exact bet, ready to edit; the date opens the whole day', async ({ page }) => {
    await boot(page, { entries: BETS })
    const row = rows(page).filter({ hasText: 'second of the day' })
    await row.locator('.td-edit').click()
    const day = page.locator('.day-modal')
    await expect(day.locator('.bet-form-head')).toContainText('Edit bet')
    await expect(day.locator('.bet-item.editing')).toContainText('second of the day')
    await expect(day.locator('.field').nth(0).locator('input')).toHaveValue('60')
    await expect(day.locator('.field').nth(0).locator('input')).toBeFocused()
    await expect(day.locator('.bet-add')).toHaveText('Save changes')
    await page.keyboard.press('Escape')

    await rows(page).filter({ hasText: 'second of the day' }).locator('.td-day').click()
    await expect(day.locator('.bet-form-head')).toContainText('Add a bet')
    await expect(day.locator('.bet-item')).toHaveCount(2)
  })

  // The pencil focused the stake a moment later, even when another box had
  // been focused since: what was typed there went into the stake.
  test('a box focused right after Edit keeps the focus: what is typed goes there', async ({ page }) => {
    await boot(page, { entries: BETS })
    await rows(page).filter({ hasText: 'first of the day' }).locator('.td-day').click()
    const day = page.locator('.day-modal')
    await expect(day.locator('.bet-item')).toHaveCount(2)
    // Edit, then straight into the note, before the dialog has had a moment.
    await page.evaluate(() => {
      const item = Array.from(document.querySelectorAll('.day-modal .bet-item')).find((li) => li.textContent?.includes('second of the day'))
      ;(item?.querySelector('.bet-actions .btn-icon') as HTMLElement).click()
      ;(document.querySelector('.day-modal .field-wide input') as HTMLInputElement).focus()
    })
    await page.keyboard.type(', checked')
    await expect(day.locator('.field-wide input')).toHaveValue('second of the day, checked')
    await expect(day.locator('.field-wide input')).toBeFocused()
    await expect(day.locator('.field').nth(0).locator('input')).toHaveValue('60')
  })

  test('an unfinished edit survives closing the dialog, and Discard changes puts the bet back', async ({ page }) => {
    await boot(page, { entries: BETS })
    await rows(page).filter({ hasText: 'second of the day' }).locator('.td-edit').click()
    const day = page.locator('.day-modal')
    const note = day.locator('.field-wide input')
    await note.fill('second, renamed')
    await page.keyboard.press('Escape')
    await expect(page.locator('.toast')).toContainText('Not saved yet')
    // Nothing was saved.
    await expect(rows(page).filter({ hasText: 'second of the day' })).toHaveCount(1)

    await reload(page)
    await rows(page).filter({ hasText: 'second of the day' }).locator('.td-edit').click()
    await expect(day.locator('.draft-note')).toContainText('Your unfinished changes to this bet are back.')
    await expect(note).toHaveValue('second, renamed')
    await day.locator('.bet-discard').click()
    await expect(note).toHaveValue('second of the day')

    await note.fill('second, saved')
    await day.locator('.bet-add').click()
    await expect(page.locator('.toast')).toContainText('Updated a bet')
    await expect(day.locator('.bet-form-head')).toContainText('Add a bet')
    await expect(rows(page).filter({ hasText: 'second, saved' })).toHaveCount(1)
  })

  test('a new bet half typed on one day and an edit on another are both kept', async ({ page }) => {
    await boot(page, { entries: BETS })
    await rows(page).filter({ hasText: 'legacy' }).locator('.td-day').click()
    const day = page.locator('.day-modal')
    await day.locator('.field').nth(0).locator('input').fill('33')
    await page.keyboard.press('Escape')
    await rows(page).filter({ hasText: 'first of the day' }).locator('.td-edit').click()
    await day.locator('.field-wide input').fill('first, renamed')
    await page.keyboard.press('Escape')

    await rows(page).filter({ hasText: 'legacy' }).locator('.td-day').click()
    await expect(day.locator('.field').nth(0).locator('input')).toHaveValue('33')
    await page.keyboard.press('Escape')
    await rows(page).filter({ hasText: 'first of the day' }).locator('.td-day').click()
    // The other bet of that day shows its edit is waiting.
    await expect(day.locator('.bet-item', { hasText: 'first of the day' }).locator('.draft-tag')).toHaveText('unsaved changes')
  })

  test('settling a free bet as won from the history opens it to type the profit', async ({ page }) => {
    await boot(page, { entries: [entry({ id: 'f', date: '2026-08-05', amount: 0, status: 'pending', stake: 0, odds: 2, note: 'promo' })] })
    await rows(page).first().locator('.settle-btn.win').click()
    const day = page.locator('.day-modal')
    await expect(day.locator('.bet-form-head')).toContainText('Edit bet')
    await expect(day.locator('.seg-btn.win')).toHaveAttribute('aria-pressed', 'true')
    await expect(day.locator('.field').nth(2)).toContainText('Promotional profit')
  })
})

import { expect, test, type Page } from '@playwright/test'
import { addBet, boot, entry, menu, openAdvanced, SEED } from './harness'

// The strip and the cards under it (P/L, bankroll, pending, month, ROI), the
// calendar's cells and the balance chart: what each says, and when.

const pad = (n: number): string => String(n).padStart(2, '0')
const now = new Date()
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
const thisMonth = today.slice(0, 7)
// Two other days of this month, never today.
const [otherDay, thirdDay] = [1, 2, 3].filter((d) => d !== now.getDate()).map((d) => `${thisMonth}-${pad(d)}`)

// Recharts draws the tick labels in a layer of their own, above the axes.
const X_LABELS = '.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value'

/** The label's box is inside the drawing's: nothing is cut off at the right edge. */
async function lastLabelFits(page: Page): Promise<void> {
  const chart = page.locator('.chart-card')
  await expect(chart.locator('.recharts-surface')).toHaveCount(1)
  const labels = chart.locator(X_LABELS)
  await expect(labels.last()).toBeVisible()
  const label = await labels.last().boundingBox()
  const surface = await chart.locator('.recharts-surface').boundingBox()
  expect(label && surface && label.x + label.width <= surface.x + surface.width + 0.5, `label ${JSON.stringify(label)} inside ${JSON.stringify(surface)}`).toBe(true)
}

test.describe('the strip: P/L, bankroll, pending', () => {
  test('what is riding is said once, on the pending card; the bankroll line says what was contributed', async ({ page }) => {
    const riding = entry({ id: 'r', date: today, amount: 0, status: 'pending', stake: 40 })
    await boot(page, { entries: [...SEED, riding], settings: { startingBankroll: 1000 }, moves: [] })
    const key = page.locator('.key-stats')
    await expect(key.locator('.pl-card .life-value')).toHaveText('+$180.00')
    await expect(key.locator('.pl-card .stat-sub')).toHaveText('4 bets over 4 days since Aug 2026')
    await expect(key.locator('.bankroll-card .key-value')).toHaveText('$1,180')
    await expect(key.locator('.bankroll-card .key-sub')).toHaveText('$1,000 contributed')
    await expect(key.locator('.pending-card .key-value')).toHaveText('1')
    await expect(key.locator('.pending-card .key-sub')).toHaveText('$40.00 at risk')
    await expect(key.locator('.pl-card')).not.toContainText('$40.00')
    await expect(key.locator('.bankroll-card')).not.toContainText('$40.00')
  })

  test('nothing pending is a quiet 0, not a headline', async ({ page }) => {
    await boot(page, { settings: { startingBankroll: 1000 }, moves: [] })
    const card = page.locator('.pending-card')
    await expect(card.locator('.key-value')).toHaveText('0')
    await expect(card.locator('.key-value')).toHaveClass(/flat/)
    await expect(card.locator('.key-sub')).toHaveText('Nothing waiting for a result')
    await expect(card).not.toHaveClass(/has-open/)
  })

  test('a pending bet is a headline again', async ({ page }) => {
    await boot(page, { entries: [...SEED, entry({ id: 'p', date: today, amount: 0, status: 'pending', stake: 10 })] })
    const card = page.locator('.pending-card')
    await expect(card.locator('.key-value')).toHaveText('1')
    await expect(card.locator('.key-value')).not.toHaveClass(/flat/)
    await expect(card).toHaveClass(/has-open/)
  })

  test('with all time no card says which dates it covers; a range makes each say it, and the range note appears', async ({ page }) => {
    await boot(page, { settings: { startingBankroll: 1000 }, moves: [] })
    await openAdvanced(page)
    await expect(page.locator('.scope-tag')).toHaveCount(0)
    const note = page.locator('.range-bar .scope-note')
    await expect(note).toHaveClass(/visually-hidden/)
    // Still the group's description for a screen reader.
    await expect(page.locator('.range-toggle')).toHaveAttribute('aria-describedby', 'range-scope')
    await expect(note).toHaveAttribute('id', 'range-scope')

    await page.locator('.range-bar .scope-btn', { hasText: 'This month' }).click()
    await expect(note).not.toHaveClass(/visually-hidden/)
    await expect(page.locator('.roi-card .scope-tag')).toHaveText('This month')
    await expect(page.locator('.advanced-toggle .scope-tag')).toHaveText('This month')
    await expect(page.locator('.bankroll-card .scope-tag')).toHaveText('All dates')
    await expect(page.locator('.pending-card .scope-tag')).toHaveText('All dates')
    await expect(page.locator('.history-card .scope-tag')).toHaveText('All dates')
    await expect(page.locator('.history-card .hist-count')).toHaveText('3 bets')

    await page.locator('.range-bar .scope-btn', { hasText: 'All time' }).click()
    await expect(page.locator('.scope-tag')).toHaveCount(0)
    await expect(note).toHaveClass(/visually-hidden/)
    await expect(page.locator('.history-card .hist-count')).toHaveText('3 bets')
  })

  test('a range with no bets in it says so on P/L, ROI and the chart; the first-bet copy only with no bets at all', async ({ page }) => {
    // The seed is in August 2026: this week has none of it.
    await boot(page, { settings: { startingBankroll: 1000 }, moves: [] })
    await page.locator('.range-bar .scope-btn', { hasText: 'This week' }).click()
    await expect(page.locator('.pl-card .life-value')).toHaveText('$0.00')
    await expect(page.locator('.pl-card .stat-sub')).toHaveText('No bets in This week')
    await expect(page.locator('.roi-card .life-value')).toHaveText('—')
    await expect(page.locator('.roi-card .stat-sub')).toHaveText('No bets in This week')
    await expect(page.locator('.chart-card .chart-empty')).toHaveText('No bets in This week')
    await menu(page, '.lang-btn')
    await expect(page.locator('.pl-card .stat-sub')).toHaveText('Sin apuestas en Esta semana')
    await expect(page.locator('.chart-card .chart-empty')).toHaveText('Sin apuestas en Esta semana')
  })

  test('with no bets at all the first steps are said, whatever the range', async ({ page }) => {
    await boot(page, { entries: [], settings: { startingBankroll: 1000 }, moves: [] })
    await expect(page.locator('.pl-card .stat-sub')).toHaveText('Log your first bet to get started')
    await expect(page.locator('.roi-card .stat-sub')).toHaveText('Log a bet with its stake to see ROI')
    await expect(page.locator('.chart-card .chart-empty')).toHaveText('Your balance curve starts with your first settled bet.')
    await page.locator('.range-bar .scope-btn', { hasText: 'This week' }).click()
    await expect(page.locator('.pl-card .stat-sub')).toHaveText('Log your first bet to get started')
    await expect(page.locator('.chart-card .chart-empty')).toHaveText('Your balance curve starts with your first settled bet.')
  })

  test('the ROI line carries the average stake; the header keeps only the small-sample caveat', async ({ page }) => {
    await boot(page)
    await expect(page.locator('.roi-card .stat-sub')).toHaveText('-$20.00 on $110.00 staked · avg $55.00 · 2 of 3 bets with a stake')
    await expect(page.locator('.roi-card .stat-chips .chip')).toHaveText(['small sample'])
    await expect(page.locator('.roi-card .stat-head')).not.toContainText('avg')
  })

  test('a P/L of $0.00 is an ROI of 0.0%, in the flat tone, not +0.0% in green', async ({ page }) => {
    // 45.45 − 50 + 30 − 25.45 is 1.8e-15 in floating point.
    const zero = [45.45, -50, 30, -25.45].map((amount, i) => entry({ id: `z${i}`, date: `2026-08-0${i + 1}`, amount, stake: 50 }))
    await boot(page, { entries: zero })
    await expect(page.locator('.pl-card .life-value')).toHaveText('$0.00')
    await expect(page.locator('.pl-card .life-value')).toHaveClass(/flat/)
    await expect(page.locator('.roi-card .life-value')).toHaveText('0.0%')
    await expect(page.locator('.roi-card .life-value')).toHaveClass(/flat/)
    await expect(page.locator('.roi-card .stat-sub')).toHaveText('$0.00 on $200.00 staked · avg $50.00 · 4 bets')
  })

  test('one of each reads in the singular, in both languages', async ({ page }) => {
    const month = [
      entry({ id: 'l', date: otherDay, amount: -10, stake: 10 }),
      entry({ id: 'w', date: today, amount: 20, stake: 10 }),
      entry({ id: 'p', date: today, amount: 0, status: 'pending', stake: 5 })
    ]
    await boot(page, { entries: month })
    await openAdvanced(page)
    await expect(page.locator('.month-card .stat-sub')).toHaveText('3 bets · 1 winning day, 1 losing day · 1 pending')
    await expect(page.locator('.mini-days .mini-sub')).toHaveText('1 winning day, 1 losing day')
    await expect(page.locator('.cal-cell.is-today')).toHaveAttribute('title', /1 pending/)
    await menu(page, '.lang-btn')
    await expect(page.locator('.month-card .stat-sub')).toHaveText('3 apuestas · 1 día ganador, 1 día perdedor · 1 pendiente')
    await expect(page.locator('.mini-days .mini-sub')).toHaveText('1 día ganador, 1 día perdedor')
    await expect(page.locator('.cal-cell.is-today')).toHaveAttribute('title', /1 pendiente$/)
  })
})

test.describe('the calendar', () => {
  test('at 320px a day of a thousand or more reads in whole thousands, with no ellipsis; the exact figure is in its title', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 })
    await boot(page, {
      entries: [
        entry({ id: 'big', date: today, amount: -1234.5, stake: 1300 }),
        entry({ id: 'win', date: otherDay, amount: 12345, stake: 500 }),
        entry({ id: 'small', date: thirdDay, amount: -335, stake: 400 })
      ]
    })
    const cell = page.locator('.cal-cell.is-today')
    await expect(cell.locator('.cal-amt')).toHaveText('-$1k')
    await expect(cell).toHaveAttribute('title', /-\$1,234\.50/)
    expect(await cell.locator('.cal-amt').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    const win = page.locator('.cal-cell', { hasText: '+$12k' })
    await expect(win).toHaveCount(1)
    expect(await win.locator('.cal-amt').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    // Under a thousand, as before.
    await expect(page.locator('.cal-cell', { hasText: '-$335' })).toHaveCount(1)
  })
})

test.describe('the balance chart', () => {
  test('one settled day already draws, from an opening point at zero, with the running P/L signed', async ({ page }) => {
    await boot(page, { entries: [entry({ id: 'one', date: today, amount: 10, stake: 10 })] })
    const chart = page.locator('.chart-card')
    await expect(chart.locator('.chart-empty')).toHaveCount(0)
    await expect(chart.locator('.recharts-area-curve')).toHaveCount(1)
    // Two dates: the day before (the opening) and today.
    await expect(chart.locator(X_LABELS)).toHaveCount(2)
    await lastLabelFits(page)
    // The tooltip on the last point: the running result, signed. (Recharts reads the pointer from the move event itself.)
    const surface = chart.locator('.recharts-surface')
    const box = await surface.boundingBox()
    if (!box) throw new Error('no chart')
    await surface.dispatchEvent('mousemove', { clientX: box.x + box.width - 30, clientY: box.y + box.height / 2 })
    await expect(chart.locator('.chart-tip .tip-value')).toHaveText('+$10.00')
    await expect(chart.locator('.chart-tip .tip-sub')).toContainText('day +$10.00')
  })

  test('a chart chunk that cannot be downloaded (a first run offline) leaves the dashboard standing, with a line in the card', async ({ page, context }) => {
    // No bets yet, so the chart's chunk has never been fetched; then the first bet is logged offline.
    await boot(page, { entries: [], settings: { startingBankroll: 1000 }, moves: [] })
    await expect(page.locator('.chart-card .chart-empty')).toHaveText('Your balance curve starts with your first settled bet.')
    await context.route('**/BalanceChartInner*.js', (route) => route.abort('internetdisconnected'))
    await addBet(page)
    const sheet = page.locator('.quick-modal')
    await sheet.locator('.field input').first().fill('20')
    await sheet.locator('.seg-btn.loss').click()
    await expect(page.locator('.toast')).toContainText('Added a bet')
    // The card says so; the rest of the page is untouched (without the boundary the whole app unmounted).
    await expect(page.locator('.chart-card .chart-offline')).toHaveText('The chart couldn’t load without a connection. It loads the next time you open the app online.')
    await expect(page.locator('.sync-badge')).toBeVisible()
    await expect(page.locator('.pl-card .life-value')).toHaveText('-$20.00')
    await expect(page.locator('.calendar-card')).toBeVisible()
    // The browser remembers the module URL that failed, so the chunk comes with the next load: online again, a reload draws it.
    await context.unroute('**/BalanceChartInner*.js')
    await page.reload()
    await expect(page.locator('.chart-card .recharts-area-curve')).toHaveCount(1)
  })

  test('the last date label is not clipped, on a computer or a phone', async ({ page }) => {
    await boot(page)
    await lastLabelFits(page)
    await page.setViewportSize({ width: 320, height: 740 })
    await lastLabelFits(page)
  })
})

test.describe('on a phone', () => {
  test('the ROI card comes before the month card, which sits right above the calendar; the DOM keeps month then ROI', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await boot(page)
    await expect(page.locator('.hero-2 > .stat-card').first()).toHaveClass(/month-card/)
    const roi = await page.locator('.roi-card').boundingBox()
    const month = await page.locator('.month-card').boundingBox()
    const calendar = await page.locator('.calendar-card').boundingBox()
    if (!roi || !month || !calendar) throw new Error('cards not laid out')
    expect(roi.y + roi.height).toBeLessThanOrEqual(month.y + 1)
    expect(month.y + month.height).toBeLessThanOrEqual(calendar.y + 1)
    expect(calendar.y - (month.y + month.height)).toBeLessThan(40)
  })

  test('at 320px every range fits its segment on one line, in Spanish too', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 })
    await page.addInitScript(() => localStorage.setItem('bettracker:lang', 'es'))
    await boot(page)
    const buttons = page.locator('.range-toggle .scope-btn')
    await expect(buttons).toHaveText(['Todo', 'Esta semana', 'Este mes', '30 días', 'Este año', 'Personalizado'])
    for (let i = 0; i < 6; i++) {
      const box = await buttons.nth(i).boundingBox()
      expect(box && box.height <= 40, `segment ${i} on one line`).toBe(true)
    }
    await expect(page.locator('.pl-card .stat-label')).toHaveText('P/L total')
    await buttons.nth(3).click()
    await expect(page.locator('.pl-card .stat-label')).toHaveText('P/L · 30 días')
  })
})

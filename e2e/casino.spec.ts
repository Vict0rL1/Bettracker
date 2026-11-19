import { expect, test, type Page } from '@playwright/test'
import { addBet, boot, entry, menu, openAdvanced, SEED, USER } from './harness'

// Casino plays (Stake's Dice, Limbo, Mines …) beside the sports bets: a bet
// with sport "Casino", the game as its type, the site as its book, no odds,
// and what it won or lost as its result (src/renderer/src/lib/casino.ts).

const sheet = (page: Page) => page.locator('.quick-modal')
const rows = (page: Page) => page.locator('.history-card tbody tr')
const kind = (page: Page, k: 'sports' | 'casino') => sheet(page).locator(`.quick-kind-${k}`)
const chip = (page: Page, game: string) => sheet(page).getByRole('button', { name: game, exact: true })
const amountBox = (page: Page) => sheet(page).locator('.quick-casino-amount input')
const wageredBox = (page: Page) => sheet(page).locator('.quick-wagered input')
const siteBox = (page: Page) => sheet(page).locator('.quick-site input')

/** A casino play as the device has it cached. */
const play = (over: Parameters<typeof entry>[0]) => entry({ sport: 'Casino', book: 'Stake', ...over })

test.describe('casino plays in the quick add', () => {
  test('Casino, a game, an amount: Won logs a + row "Casino · Limbo", Lost a − one, and the sheet comes back on Casino with that game', async ({ page }) => {
    await boot(page)
    await addBet(page)
    // The last bet logged is a sports one: the sheet opens as it always has.
    await expect(kind(page, 'sports')).toHaveAttribute('aria-checked', 'true')
    await expect(sheet(page).locator('.quick-results')).toBeVisible()

    await kind(page, 'casino').click()
    await expect(kind(page, 'casino')).toHaveAttribute('aria-checked', 'true')
    await expect(sheet(page).locator('.quick-results')).toHaveCount(0)
    await expect(sheet(page).locator('.quick-casino-results .seg-btn')).toHaveText(['Won', 'Lost'])
    // No casino play yet: no game chosen, and the site is Stake.
    await expect(sheet(page).locator('.quick-game-chip[aria-pressed="true"]')).toHaveCount(0)
    await expect(siteBox(page)).toHaveValue('Stake')
    await expect(sheet(page).locator('.hint')).toHaveText('Type what you won or lost, net, then tap Won or Lost.')

    await chip(page, 'Limbo').click()
    await expect(chip(page, 'Limbo')).toHaveAttribute('aria-pressed', 'true')
    await amountBox(page).fill('25.50')
    await sheet(page).locator('.quick-casino-won').click()
    await expect(page.locator('.toast')).toContainText('Added a bet')
    await expect(sheet(page)).toHaveCount(0)

    const won = rows(page).first()
    await expect(won.locator('.pill')).toHaveText('WON')
    await expect(won.locator('.td-amt')).toHaveText('+$25.50')
    await expect(won.locator('.td-tags .tag')).toHaveText(['Casino', 'Limbo', 'Stake'])
    // No odds, and no wager typed: both say so with a dash.
    await expect(won.locator('.td-odds')).toHaveText('—')
    await expect(won.locator('.td-stake').first()).toHaveText('—')

    // Back on Casino, with the last game; what is won or lost is the box to type in.
    await addBet(page)
    await expect(kind(page, 'casino')).toHaveAttribute('aria-checked', 'true')
    await expect(chip(page, 'Limbo')).toHaveAttribute('aria-pressed', 'true')
    await expect(amountBox(page)).toBeFocused()
    await expect(amountBox(page)).toHaveValue('')
    await amountBox(page).fill('10')
    await wageredBox(page).fill('40')
    await sheet(page).locator('.quick-casino-lost').click()
    await expect(sheet(page)).toHaveCount(0)
    const lost = rows(page).first()
    await expect(lost.locator('.pill')).toHaveText('LOST')
    await expect(lost.locator('.td-amt')).toHaveText('-$10.00')
    await expect(lost.locator('.td-stake').first()).toHaveText('$40.00')
    // Wagered typed: its return shows like any staked bet's.
    await expect(lost.locator('.td-roi').first()).toHaveText('-25.0%')

    // Queued as a bet: sport Casino, the game as its type, the site as its book, no odds.
    const queued = await page.evaluate(
      (uid) => (JSON.parse(localStorage.getItem(`bettracker:outbox:${uid}`) ?? '[]') as { kind: string; input: Record<string, unknown> }[]).filter((op) => op.kind === 'add').map((op) => op.input),
      USER.id
    )
    expect(queued.map((b) => [b.sport, b.amount, b.stake, b.odds, b.closingOdds, b.status, b.book, b.betType])).toEqual([
      ['Casino', 25.5, null, null, null, 'won', 'Stake', 'Limbo'],
      ['Casino', -10, 40, null, null, 'lost', 'Stake', 'Limbo']
    ])
  })

  test('problems are said next to their box, and nothing is logged until they are fixed', async ({ page }) => {
    await boot(page)
    await addBet(page)
    await kind(page, 'casino').click()

    await sheet(page).locator('.quick-casino-won').click()
    await expect(sheet(page).locator('.quick-casino-amount .field-error')).toHaveText('Enter the amount, more than 0.')
    await expect(amountBox(page)).toBeFocused()

    // A loss can't top what was wagered.
    await amountBox(page).fill('30')
    await wageredBox(page).fill('20')
    await sheet(page).locator('.quick-casino-lost').click()
    await expect(sheet(page).locator('.quick-casino-amount .field-error')).toHaveText('A loss can’t be more than what was wagered.')
    await expect(amountBox(page)).toHaveAttribute('aria-invalid', 'true')

    await wageredBox(page).fill('0')
    await sheet(page).locator('.quick-casino-won').click()
    await expect(sheet(page).locator('.quick-wagered .field-error')).toHaveText('Leave it empty, or enter more than 0.')
    await expect(wageredBox(page)).toBeFocused()
    await expect(sheet(page)).toHaveCount(1)
    await expect(rows(page)).toHaveCount(SEED.length)

    // A game of its own, typed: it is what the play is filed under.
    await wageredBox(page).fill('')
    await sheet(page).locator('.quick-game-other').fill('Wheel')
    await sheet(page).locator('.quick-casino-won').click()
    await expect(sheet(page)).toHaveCount(0)
    await expect(rows(page).first().locator('.td-tags .tag')).toHaveText(['Casino', 'Wheel', 'Stake'])
  })

  test('the sports side’s tags ignore the casino play, and the sheet opens on the kind logged last', async ({ page }) => {
    await boot(page, { settings: { defaultStake: 25 } })
    await addBet(page)
    await kind(page, 'casino').click()
    await chip(page, 'Dice').click()
    await amountBox(page).fill('5')
    await sheet(page).locator('.quick-casino-lost').click()
    await expect(sheet(page)).toHaveCount(0)

    await addBet(page)
    await expect(kind(page, 'casino')).toHaveAttribute('aria-checked', 'true')
    await kind(page, 'sports').click()
    // The seed's last sports bet, not the casino play just logged.
    const tags = sheet(page).locator('.quick-tags input')
    await expect(tags.nth(0)).toHaveValue('NFL')
    await expect(tags.nth(1)).toHaveValue('FanDuel')
    await expect(tags.nth(2)).toHaveValue('Moneyline')
    await expect(sheet(page).locator('.field input').first()).toHaveValue('25')
    await sheet(page).locator('.seg-btn.loss').click()
    await expect(sheet(page)).toHaveCount(0)
    await expect(rows(page).first().locator('.td-tags .tag')).toHaveText(['NFL', 'FanDuel', 'Moneyline'])

    await addBet(page)
    await expect(kind(page, 'sports')).toHaveAttribute('aria-checked', 'true')
  })

  test('Sports | Casino is a radio group: Tab reaches the chosen one, the arrows, Home and End move and choose', async ({ page }) => {
    await boot(page)
    await addBet(page)
    const group = sheet(page).getByRole('radiogroup', { name: 'What to log' })
    await expect(group.getByRole('radio')).toHaveText(['Sports', 'Casino'])
    await expect(kind(page, 'sports')).toHaveAttribute('tabindex', '0')
    await expect(kind(page, 'casino')).toHaveAttribute('tabindex', '-1')

    await sheet(page).getByRole('button', { name: 'Close' }).focus()
    await page.keyboard.press('Tab')
    await expect(kind(page, 'sports')).toBeFocused()

    await page.keyboard.press('ArrowRight')
    await expect(kind(page, 'casino')).toBeFocused()
    await expect(kind(page, 'casino')).toHaveAttribute('aria-checked', 'true')
    await expect(kind(page, 'casino')).toHaveAttribute('tabindex', '0')
    await expect(amountBox(page)).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(kind(page, 'sports')).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('End')
    await expect(kind(page, 'casino')).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Home')
    await expect(kind(page, 'sports')).toHaveAttribute('aria-checked', 'true')
    await expect(kind(page, 'sports')).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(kind(page, 'casino')).toHaveAttribute('aria-checked', 'true')

    // From the radio on, Tab goes on into the casino side, and Space on a chip picks its game.
    await page.keyboard.press('Tab')
    await expect(sheet(page).locator('.quick-date-input')).toBeFocused()
    await chip(page, 'Mines').focus()
    await page.keyboard.press('Space')
    await expect(chip(page, 'Mines')).toHaveAttribute('aria-pressed', 'true')
    await amountBox(page).fill('12')
    await sheet(page).locator('.quick-casino-won').focus()
    await page.keyboard.press('Enter')
    await expect(sheet(page)).toHaveCount(0)
    await expect(rows(page).first().locator('.td-tags .tag')).toHaveText(['Casino', 'Mines', 'Stake'])
  })

  test('closing by accident keeps the casino side as a draft; More details carries it to the full form as a casino bet', async ({ page }) => {
    await boot(page)
    await addBet(page)
    await kind(page, 'casino').click()
    await chip(page, 'Plinko').click()
    await amountBox(page).fill('18')
    await page.keyboard.press('Escape')
    await expect(sheet(page)).toHaveCount(0)
    await expect(page.locator('.toast')).toContainText('Not saved yet')

    await addBet(page)
    await expect(sheet(page).locator('.draft-note')).toBeVisible()
    await expect(kind(page, 'casino')).toHaveAttribute('aria-checked', 'true')
    await expect(chip(page, 'Plinko')).toHaveAttribute('aria-pressed', 'true')
    await expect(amountBox(page)).toHaveValue('18')

    await sheet(page).locator('.quick-more').click()
    const day = page.locator('.day-modal')
    await expect(day).toBeVisible()
    const fields = day.locator('.bet-form .field')
    await expect(fields.nth(0).locator('input')).toHaveValue('')
    await expect(fields.nth(2).locator('input')).toHaveValue('18')
    await expect(fields.nth(4).locator('input')).toHaveValue('Casino')
    await expect(fields.nth(5).locator('input')).toHaveValue('Stake')
    await expect(fields.nth(6).locator('input')).toHaveValue('Plinko')
    // A casino play needs no odds and its stake (what was wagered) is optional.
    await expect(fields.nth(0)).toContainText('optional')
    await expect(day.locator('.bet-submit .hint')).toContainText('A casino play')
    await day.locator('.bet-add').click()
    await expect(day.locator('.bet-item')).toHaveCount(1)
    await expect(day.locator('.bet-item .tag')).toHaveText(['Casino', 'Plinko', 'Stake'])
    await expect(day.locator('.bet-item .bet-amt')).toHaveText('+$18.00')
  })
})

test.describe('casino plays elsewhere', () => {
  const PLAYS = [
    ...SEED,
    play({ id: 'p1', date: '2026-08-04', amount: 40, stake: 20, betType: 'Limbo', note: 'cashed at 3x' }),
    play({ id: 'p2', date: '2026-08-05', amount: -15, betType: 'Dice', sport: 'casino' }),
    play({ id: 'p3', date: '2026-08-06', amount: -10, stake: 10, betType: 'Limbo' })
  ]

  test('the breakdown shows Casino as one sport (however it was tagged) and the games as bet types', async ({ page }) => {
    await boot(page, { entries: PLAYS })
    await openAdvanced(page)
    const card = page.locator('.breakdown-card')
    await expect(card.locator('.bd-label')).toHaveText(['NBA', 'NFL', 'Casino'])
    const casino = card.locator('.bd-row', { hasText: 'Casino' })
    await expect(casino.locator('.bd-profit')).toHaveText('+$15.00')
    await expect(casino.locator('.bd-meta')).toContainText('3 bets')
    // ROI over the two that recorded a wager.
    await expect(casino.locator('.bd-meta')).toContainText('+100.0% on $30.00 (2/3)')
    await card.locator('.scope-btn', { hasText: 'Bet type' }).click()
    await expect(card.locator('.bd-label')).toContainText(['Limbo', 'Dice'])
  })

  test('the full form edits a casino play without asking for odds, and it stays a casino play', async ({ page }) => {
    await boot(page, { entries: PLAYS })
    await rows(page).filter({ hasText: 'cashed at 3x' }).locator('.td-edit').click()
    const day = page.locator('.day-modal')
    await expect(day.locator('.bet-form-head')).toContainText('Edit bet')
    const fields = day.locator('.bet-form .field')
    await expect(fields.nth(1).locator('input')).toHaveValue('')
    await expect(fields.nth(2).locator('input')).toHaveValue('40')
    // Lost, as typed: the amount is kept, not replaced by the stake.
    await day.locator('.bet-form .seg-btn.loss').click()
    await expect(fields.nth(2).locator('input')).toHaveValue('40')
    await fields.nth(2).locator('input').fill('20')
    await fields.nth(0).locator('input').fill('')
    await day.locator('.bet-add').click()
    await expect(day.locator('.bet-form-head')).toContainText('Add a bet')
    const item = day.locator('.bet-item')
    await expect(item.locator('.bet-amt')).toHaveText('-$20.00')
    await expect(item.locator('.tag')).toHaveText(['Casino', 'Limbo', 'Stake'])
    await page.keyboard.press('Escape')
    const row = rows(page).filter({ hasText: 'cashed at 3x' })
    await expect(row.locator('.td-amt')).toHaveText('-$20.00')
    await expect(row.locator('.td-stake').first()).toHaveText('—')
  })

  test('a pending casino play without a wager: Lost opens its form to type what it cost; the panel reads it as Casino · game', async ({ page }) => {
    await boot(page, { entries: [...SEED, play({ id: 'open', date: '2026-08-07', amount: 0, status: 'pending', betType: 'Crash' })] })
    await menu(page, '.pending-btn')
    const panel = page.locator('.pending-modal')
    await expect(panel.locator('.bet-item .tag')).toHaveText(['Casino', 'Crash', 'Stake'])
    await panel.locator('.settle-btn.loss').click()
    const day = page.locator('.day-modal')
    await expect(day.locator('.bet-form-head')).toContainText('Edit bet')
    await expect(day.locator('.bet-form .seg-btn.loss')).toHaveAttribute('aria-pressed', 'true')
    const amount = day.locator('.bet-form .field').nth(2).locator('input')
    await expect(amount).toBeFocused()
    await amount.fill('7')
    await day.locator('.bet-add').click()
    await expect(day.locator('.bet-item .bet-amt')).toHaveText('-$7.00')
  })

  test('on a phone the history card reads Casino · game · site, without a "stake not recorded" for a play with no wager', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await boot(page, { entries: PLAYS })
    // Tagged "casino" by hand, it reads as Casino all the same.
    const card = page.locator('.hcard', { hasText: 'Dice' })
    await expect(card.locator('.hcard-desc')).toHaveText('Casino · Dice · Stake')
    await expect(card.locator('.hcard-stake')).toHaveText('')
    await expect(page.locator('.hcard', { hasText: 'cashed at 3x' }).locator('.hcard-stake')).toHaveText('$20.00 staked')
    // Opened, it has no price to show: no odds or closing odds rows, only what it has.
    await card.locator('.hcard-toggle').click()
    await expect(card.locator('.hcard-details dt')).toHaveText(['Return', 'Tags', 'Note'])
    await expect(card.locator('.hcard-details .tag')).toHaveText(['Casino', 'Dice', 'Stake'])
    // A sports bet keeps them.
    const sports = page.locator('.hcard', { hasText: 'live' })
    await sports.locator('.hcard-toggle').click()
    await expect(sports.locator('.hcard-details dt').first()).toHaveText('Odds')
  })
})

test('in Spanish: Deportes | Casino, Juego, Importe, Sitio, Apostado, Gané and Perdí', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('bettracker:lang')) localStorage.setItem('bettracker:lang', 'es')
  })
  await boot(page)
  await addBet(page)
  await expect(sheet(page).getByRole('radiogroup', { name: 'Qué registrar' }).getByRole('radio')).toHaveText(['Deportes', 'Casino'])
  await kind(page, 'casino').click()
  await expect(sheet(page).locator('.quick-game .field-label')).toHaveText('Juego')
  await expect(sheet(page).locator('.quick-game-other')).toHaveAttribute('placeholder', 'Otro juego')
  await expect(sheet(page).locator('.quick-casino-amount .field-label')).toHaveText('Importe')
  await expect(sheet(page).locator('.quick-site .field-label')).toHaveText('Sitio')
  await expect(sheet(page).locator('.quick-wagered .field-label')).toHaveText('Apostado opcional')
  await expect(sheet(page).locator('.quick-casino-results .seg-btn')).toHaveText(['Gané', 'Perdí'])
  await expect(sheet(page).locator('.hint')).toHaveText('Escribe cuánto ganaste o perdiste (neto) y toca Gané o Perdí.')
  await expect(sheet(page).locator('.quick-more')).toHaveText('Más datos (nota…)')
  await sheet(page).locator('.quick-casino-lost').click()
  await expect(sheet(page).locator('.quick-casino-amount .field-error')).toHaveText('Escribe el importe, más de 0.')
  await chip(page, 'Limbo').click()
  await amountBox(page).fill('9')
  await sheet(page).locator('.quick-casino-lost').click()
  await expect(page.locator('.toast')).toContainText('Apuesta añadida')
  await expect(rows(page).first().locator('.td-tags .tag')).toHaveText(['Casino', 'Limbo', 'Stake'])
})

for (const width of [320, 390]) {
  test(`at ${width}px in Spanish the casino side fits the phone: nothing sideways, fields at 16px, its toggles and chips thumb-sized`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 })
    await page.addInitScript(() => localStorage.setItem('bettracker:lang', 'es'))
    await boot(page)
    await addBet(page)
    await kind(page, 'casino').click()
    await sheet(page).locator('.quick-casino-lost').click()
    await expect(sheet(page).locator('.quick-casino-amount .field-error')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    expect(await sheet(page).evaluate((el) => el.scrollWidth <= el.clientWidth), 'nothing sideways inside the sheet').toBe(true)
    const box = await sheet(page).boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true)
    const small = await sheet(page).evaluate((el) =>
      Array.from(el.querySelectorAll<HTMLElement>('input')).filter((i) => i.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(i).fontSize) < 16).length
    )
    expect(small, 'no field under 16px (iOS would zoom in)').toBe(0)
    const heights = await sheet(page).evaluate((el) =>
      Array.from(el.querySelectorAll<HTMLElement>('.quick-kind-btn, .quick-game-chip, .quick-casino-results .seg-btn')).map((b) => b.getBoundingClientRect().height)
    )
    expect(heights).toHaveLength(14)
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44)
  })
}

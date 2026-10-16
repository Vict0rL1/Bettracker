import { expect, test } from '@playwright/test'
import { boot, reload } from './harness'

test('the interface follows the toggle into Spanish and remembers it', async ({ page }) => {
  await boot(page)
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.locator('.history-card h2')).toHaveText('History')
  await page.click('.lang-btn')
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
  await expect(page.locator('.history-card h2')).toHaveText('Historial')
  await expect(page.locator('.history-card tbody tr').first().locator('.pill')).toHaveText('GANADA')
  // Dates follow the language too.
  await expect(page.locator('.history-card tbody tr').first().locator('.td-date')).toContainText('ago')
  await reload(page)
  await expect(page.locator('.history-card h2')).toHaveText('Historial')
  await page.click('.lang-btn')
  await expect(page.locator('.history-card h2')).toHaveText('History')
})

test('the language button sits clear of its neighbours, in both languages, on a computer and on a phone', async ({ page }) => {
  await boot(page)
  // The label has to fit its button (an overflowing label is drawn over the
  // next one), and the buttons must not cover each other.
  const overlaps = async (): Promise<string[]> => {
    const lang = await page.locator('.lang-btn').boundingBox()
    const out: string[] = []
    if (await page.locator('.lang-btn').evaluate((b) => b.scrollWidth > b.clientWidth)) out.push('label overflows')
    for (const sel of ['.theme-btn:not(.settings-btn)', '.settings-btn']) {
      const other = await page.locator(sel).boundingBox()
      if (!lang || !other) throw new Error(`no box for ${sel}`)
      const apart = lang.x + lang.width <= other.x || other.x + other.width <= lang.x || lang.y + lang.height <= other.y || other.y + other.height <= lang.y
      if (!apart) out.push(sel)
    }
    return out
  }
  for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size)
    expect(await overlaps(), `English, ${size.width}px`).toEqual([])
    await page.click('.lang-btn')
    await expect(page.locator('html')).toHaveAttribute('lang', 'es')
    expect(await overlaps(), `Spanish, ${size.width}px`).toEqual([])
    await page.click('.lang-btn')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  }
})

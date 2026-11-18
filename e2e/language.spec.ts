import { expect, test } from '@playwright/test'
import { boot, menu, reload } from './harness'

test('the interface follows the toggle into Spanish and remembers it', async ({ page }) => {
  await boot(page)
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.locator('.history-card h2')).toHaveText('History')
  await menu(page, '.lang-btn')
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
  await expect(page.locator('.history-card h2')).toHaveText('Historial')
  await expect(page.locator('.history-card tbody tr').first().locator('.pill')).toHaveText('GANADA')
  // Dates follow the language too.
  await expect(page.locator('.history-card tbody tr').first().locator('.td-date')).toContainText('ago')
  await reload(page)
  await expect(page.locator('.history-card h2')).toHaveText('Historial')
  await menu(page, '.lang-btn')
  await expect(page.locator('.history-card h2')).toHaveText('History')
})

test('the menu fits the screen with every label whole, in both languages, on a computer and on a phone', async ({ page }) => {
  await boot(page)
  const problems = async (): Promise<string[]> =>
    page.evaluate(() => {
      const out: string[] = []
      const box = document.querySelector('.app-menu')?.getBoundingClientRect()
      if (!box) return ['no menu']
      if (box.left < 0 || box.right > window.innerWidth) out.push('menu off screen')
      for (const item of Array.from(document.querySelectorAll<HTMLElement>('.app-menu .menu-item'))) {
        if (item.scrollWidth > item.clientWidth) out.push(`${item.className} overflows`)
      }
      // The top bar keeps Add bet and the menu button apart (side by side, or on two rows on a phone).
      const add = document.querySelector('.add-bet-btn')?.getBoundingClientRect()
      const btn = document.querySelector('.menu-btn')?.getBoundingClientRect()
      const apart = add && btn && (add.right <= btn.left || btn.right <= add.left || add.bottom <= btn.top || btn.bottom <= add.top)
      if (!apart) out.push('add bet covers the menu button')
      if (document.documentElement.scrollWidth > window.innerWidth) out.push('page wider than the screen')
      return out
    })
  for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
    await page.setViewportSize(size)
    await page.locator('.menu-btn').click()
    expect(await problems(), `English, ${size.width}px`).toEqual([])
    await page.locator('.app-menu .lang-btn').click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'es')
    expect(await problems(), `Spanish, ${size.width}px`).toEqual([])
    await page.locator('.app-menu .lang-btn').click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await page.keyboard.press('Escape')
  }
})

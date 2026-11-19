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
      // The + button (the one add button, on every screen) keeps clear of the menu button, and never covers an item
      // of the open menu: what is under each item, at both ends and the middle, is that item.
      const add = document.querySelector('.fab')?.getBoundingClientRect()
      const btn = document.querySelector('.menu-btn')?.getBoundingClientRect()
      const apart = add && btn && (add.right <= btn.left || btn.right <= add.left || add.bottom <= btn.top || btn.bottom <= add.top)
      if (!apart) out.push('the + button covers the menu button')
      for (const item of Array.from(document.querySelectorAll<HTMLElement>('.app-menu .menu-item'))) {
        // On a short window the menu runs past the screen's foot, and clicking an item scrolls the page: each in view.
        item.scrollIntoView({ block: 'nearest' })
        const r = item.getBoundingClientRect()
        const y = r.top + r.height / 2
        if ([r.left + 8, r.left + r.width / 2, r.right - 8].some((x) => !item.contains(document.elementFromPoint(x, y)))) out.push(`${item.className} is covered`)
      }
      if (document.documentElement.scrollWidth > window.innerWidth) out.push('page wider than the screen')
      return out
    })
  // 1024×440: a short window (or a phone on its side), where the open menu reaches down over the + button.
  for (const size of [{ width: 1280, height: 800 }, { width: 1024, height: 440 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
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

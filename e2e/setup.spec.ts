import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEV_URL } from './urls'

// `npm run dev` with a .env whose URL lacks https:// (playwright.config.ts).
// supabase-js throws on such a URL, and the page used to stay blank.
test.describe('npm run dev with a .env that can’t work', () => {
  test.use({ baseURL: DEV_URL })

  test('opens on the setup screen, saying what is wrong and what to put instead', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.setup-problems')).toContainText(
      'VITE_SUPABASE_URL has to start with https://. Use https://abcdefghijklmnopqrst.supabase.co.'
    )
    await expect(page.locator('.setup-steps')).toBeVisible()
    await expect(page.locator('.auth-card input')).toHaveCount(0)
  })

  test('says it in Spanish too, and fits a 320px phone', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 })
    await page.addInitScript(() => localStorage.setItem('bettracker:lang', 'es'))
    await page.goto('/')
    await expect(page.locator('.setup-problems')).toContainText('Hay que corregir el .env:')
    await expect(page.locator('.setup-problems')).toContainText('VITE_SUPABASE_URL tiene que empezar por https://.')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  })
})

test('npm run build refuses a secret key, says why, and writes nothing', async () => {
  // A service_role key, put together here (see src/shared/supabaseEnv.test.ts).
  const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  const serviceRole = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role: 'service_role' })}.${'A'.repeat(43)}`
  const outDir = join(mkdtempSync(join(tmpdir(), 'bettracker-')), 'dist')
  // The terminal's language is the build's: English here, whatever this machine's is.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LANG: 'en_US.UTF-8',
    VITE_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    VITE_SUPABASE_ANON_KEY: serviceRole
  }
  delete env.LC_ALL
  delete env.LC_MESSAGES

  const result = await new Promise<{ failed: boolean; output: string }>((resolve) => {
    // Node runs Vite's own script: no shell, no npx.cmd to find on Windows.
    execFile(process.execPath, [join('node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', outDir], { env }, (err, stdout, stderr) =>
      resolve({ failed: err !== null, output: `${stdout}${stderr}` })
    )
  })

  expect(result.failed).toBe(true)
  expect(result.output).toContain('BetTracker can’t be built with this .env:')
  expect(result.output).toContain('VITE_SUPABASE_ANON_KEY is a secret key (sb_secret_… or service_role).')
  expect(result.output).not.toContain(serviceRole)
  expect(existsSync(outDir)).toBe(false)
})

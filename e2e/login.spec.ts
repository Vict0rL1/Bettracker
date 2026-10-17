import { expect, test, type Locator, type Page } from '@playwright/test'

// The production build (playwright.config.ts) without the harness: the real
// supabase-js, signing in against https://example.supabase.co — which these
// tests play with page.route, answering as Supabase does.
type Answer = { status: number; body: object } | 'offline'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*'
}

async function signIn(page: Page, answer: Answer, lang: 'en' | 'es' = 'en'): Promise<Locator> {
  await page.route('https://example.supabase.co/**', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    if (answer === 'offline') return route.abort('internetdisconnected')
    return route.fulfill({ status: answer.status, headers: CORS, contentType: 'application/json', body: JSON.stringify(answer.body) })
  })
  if (lang === 'es') await page.addInitScript(() => localStorage.setItem('bettracker:lang', 'es'))
  await page.goto('/')
  const form = page.locator('.auth-card')
  await form.locator('input[type=email]').fill('you@example.com')
  await form.locator('input[type=password]').fill('hunter22')
  await form.locator('.auth-submit').click()
  return form.locator('.auth-error')
}

// What Supabase's API gateway answers for a key that isn't the project's.
const INVALID_KEY = { status: 401, body: { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' } }

test.describe('signing in, when Supabase says no', () => {
  test('"Invalid API key" says which key to put in .env, instead of only repeating it', async ({ page }) => {
    const error = await signIn(page, INVALID_KEY)
    await expect(error).toContainText('Supabase rejected this app’s key (“Invalid API key”).')
    await expect(error).toContainText('publishable key (sb_publishable_…) of the same project as the URL')
  })

  test('the same, in Spanish', async ({ page }) => {
    const error = await signIn(page, INVALID_KEY, 'es')
    await expect(error).toContainText('Supabase ha rechazado la clave de esta app («Invalid API key»).')
  })

  test('a wrong password, an unconfirmed email and no connection, in plain words', async ({ page }) => {
    const answers: [Answer, string][] = [
      [{ status: 400, body: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } }, 'Wrong email or password.'],
      [{ status: 400, body: { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' } }, 'Confirm your email first'],
      ['offline', 'Couldn’t reach Supabase.']
    ]
    for (const [answer, words] of answers) {
      await page.unrouteAll()
      const error = await signIn(page, answer)
      await expect(error).toContainText(words)
    }
  })
})

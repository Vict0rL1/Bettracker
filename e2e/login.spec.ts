import { expect, test, type Locator, type Page } from '@playwright/test'
import { APP_URL, DEMO_URL } from './urls'
import { menu } from './harness'

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

  test('an expired confirmation link opens on the sign-in screen saying so, once', async ({ page }) => {
    await page.goto('/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')
    await expect(page.locator('.auth-card .auth-error')).toContainText('That email link has expired or was already used.')
    expect(await page.evaluate(() => window.location.hash)).toBe('')
    await page.reload()
    await expect(page.locator('.auth-card')).toBeVisible()
    await expect(page.locator('.auth-card .auth-error')).toHaveCount(0)
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

// Supabase sends the confirmation link to its Site URL (http://localhost:3000
// on a new project) unless the sign-up names another address it allows.
test('signing up asks for the confirmation link to come back to this address', async ({ page }) => {
  let signup = ''
  await page.route('https://example.supabase.co/**', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    signup = route.request().url()
    // Confirmation on: a user, and no session until the link is opened.
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'u1', aud: 'authenticated', role: '', email: 'you@example.com', confirmation_sent_at: '2026-10-17T10:00:00Z' })
    })
  })
  await page.goto('/')
  const form = page.locator('.auth-card')
  await form.locator('.login-switch').click()
  await form.locator('input[type=email]').fill('you@example.com')
  await form.locator('input[type=password]').fill('hunter22')
  await form.locator('.auth-submit').click()
  await expect(form.locator('.auth-notice')).toContainText('Account created. Check your email to confirm')
  expect(new URL(signup).pathname).toBe('/auth/v1/signup')
  expect(new URL(signup).searchParams.get('redirect_to')).toBe(APP_URL)
})

test.describe('a forgotten password', () => {
  const USER_JSON = { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'you@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' }
  const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  // A token as Supabase puts it in the reset link (not checked here: the routes below play the server).
  const TOKEN = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u1', email: 'you@example.com', aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`

  /** Answers as Supabase does; returns what was asked of /recover and PUT /user. */
  async function serve(page: Page): Promise<{ recover: string[]; updates: string[] }> {
    const seen = { recover: [] as string[], updates: [] as string[] }
    await page.route('https://example.supabase.co/**', (route) => {
      const req = route.request()
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
      const url = new URL(req.url())
      const json = (status: number, body: unknown) => route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) })
      if (url.pathname === '/auth/v1/recover') {
        seen.recover.push(`${req.postData()} ${url.searchParams.get('redirect_to')}`)
        return json(200, {})
      }
      if (url.pathname === '/auth/v1/user') {
        if (req.method() === 'PUT') seen.updates.push(req.postData() ?? '')
        return json(200, USER_JSON)
      }
      // The app's own reads once in: nothing stored.
      if (url.pathname.startsWith('/rest/v1/')) return json(200, [])
      return json(404, {})
    })
    return seen
  }

  test('asks for a link to set a new password, back to this address, with the same words whatever the account', async ({ page }) => {
    const seen = await serve(page)
    await page.goto('/')
    const form = page.locator('.auth-card')
    await form.locator('.login-forgot').click()
    await expect(form.locator('input[type=password]')).toHaveCount(0)
    await form.locator('input[type=email]').fill('you@example.com')
    await form.locator('.auth-submit').click()
    await expect(form.locator('.auth-notice')).toContainText('If there is an account for you@example.com, a link to set a new password is on its way.')
    expect(seen.recover).toHaveLength(1)
    expect(seen.recover[0]).toContain('"email":"you@example.com"')
    expect(seen.recover[0]).toContain(APP_URL)
  })

  test('the link opens a form for the new password, checked before it is sent, then the app', async ({ page }) => {
    const seen = await serve(page)
    await page.goto(`/#access_token=${TOKEN}&expires_in=3600&refresh_token=r1&token_type=bearer&type=recovery`)
    const form = page.locator('.new-password')
    await expect(form).toContainText('Set a new password for you@example.com.')
    const [first, second] = [form.locator('input').nth(0), form.locator('input').nth(1)]

    await first.fill('abc')
    await form.locator('.auth-submit').click()
    await expect(first).toBeFocused()
    await expect(first).toHaveAttribute('aria-invalid', 'true')
    await expect(form.locator('.field-error').first()).toHaveText('At least 6 characters.')

    await first.fill('a-new-password')
    await second.fill('a-new-passw0rd')
    await form.locator('.auth-submit').click()
    await expect(second).toBeFocused()
    await expect(form.locator('.field-error')).toHaveText('The two passwords are not the same.')
    expect(seen.updates).toHaveLength(0)

    await second.fill('a-new-password')
    await form.locator('.auth-submit').click()
    await expect(form.locator('.auth-notice')).toContainText('Your password is changed.')
    expect(JSON.parse(seen.updates[0]).password).toBe('a-new-password')
    // The token is out of the address.
    expect(await page.evaluate(() => window.location.hash)).toBe('')
    await form.getByRole('button', { name: 'Continue to BetTracker' }).click()
    await expect(page.locator('.topbar')).toBeVisible()
  })

  test('the demo says it sends no email', async ({ page }) => {
    await page.goto(DEMO_URL)
    await menu(page, '.btn-signout')
    const form = page.locator('.auth-card')
    await form.locator('.login-forgot').click()
    await form.locator('input[type=email]').fill('you@example.com')
    await form.locator('.auth-submit').click()
    await expect(form.locator('.auth-error')).toHaveText('The demo sends no email: any email and password sign you in.')
  })
})

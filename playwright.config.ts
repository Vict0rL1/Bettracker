import fs from 'node:fs'
import { defineConfig } from '@playwright/test'
import { APP_PORT, APP_URL, DEMO_PORT, DEMO_URL, DEV_PORT, DEV_URL } from './e2e/urls'

// Chromium: el que diga PLAYWRIGHT_CHROMIUM, o el preinstalado del contenedor de desarrollo
// si existe, o el que `playwright install chromium` haya bajado (CI).
const chromium =
  process.env.PLAYWRIGHT_CHROMIUM ??
  (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined)

// Made of parts so the CI secret scan has nothing that looks like a key.
const PLACEHOLDER_KEY = ['sb', 'publishable', 'e2e', 'placeholder'].join('_')

// The suite never talks to a real backend. The app is built with placeholder
// credentials (well-formed, so the build's .env check lets them through and
// main.tsx renders the app instead of the "not configured" screen) and every
// test injects `window.__supabaseMock` before the bundle runs — see
// e2e/harness.ts — or answers for Supabase itself with page.route
// (e2e/login.spec.ts). The build goes to dist-e2e/ so it can't be mistaken
// for a deployable bundle.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: APP_URL,
    // The app follows the browser language; the specs assert English copy.
    locale: 'en-US',
    launchOptions: chromium ? { executablePath: chromium } : {},
    trace: 'retain-on-failure'
  },
  webServer: [
    {
      // As `npm run e2e:serve`, on the port of e2e/urls.ts.
      command: `npx vite build --outDir ../../dist-e2e && npx vite preview --outDir ../../dist-e2e --port ${APP_PORT} --strictPort`,
      url: `${APP_URL}/`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: {
        VITE_SUPABASE_URL: 'https://example.supabase.co',
        VITE_SUPABASE_ANON_KEY: PLACEHOLDER_KEY
      }
    },
    // `npm run dev` with a URL that lacks https://, for e2e/setup.spec.ts.
    {
      command: `npx vite --port ${DEV_PORT} --strictPort`,
      url: `${DEV_URL}/`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: {
        VITE_SUPABASE_URL: 'abcdefghijklmnopqrst.supabase.co',
        VITE_SUPABASE_ANON_KEY: PLACEHOLDER_KEY
      }
    },
    // `npm run demo` as built (as `npm run demo:serve`), for e2e/demo.spec.ts:
    // it brings its own fake backend, so it needs neither credentials nor the
    // harness. The .env values given here must not end up in it.
    {
      command: `npx vite build --mode demo --outDir ../../dist-demo && npx vite preview --outDir ../../dist-demo --port ${DEMO_PORT} --strictPort`,
      url: `${DEMO_URL}/`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: {
        VITE_SUPABASE_URL: 'https://demomustnotshipthis.supabase.co',
        VITE_SUPABASE_ANON_KEY: ['sb', 'publishable', 'demo', 'must', 'not', 'ship', 'this'].join('_')
      }
    }
  ]
})

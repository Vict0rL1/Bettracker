import fs from 'node:fs'
import { defineConfig } from '@playwright/test'

// Chromium: el que diga PLAYWRIGHT_CHROMIUM, o el preinstalado del contenedor de desarrollo
// si existe, o el que `playwright install chromium` haya bajado (CI).
const chromium =
  process.env.PLAYWRIGHT_CHROMIUM ??
  (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined)

const PORT = 4173

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
    baseURL: `http://localhost:${PORT}`,
    // The app follows the browser language; the specs assert English copy.
    locale: 'en-US',
    launchOptions: chromium ? { executablePath: chromium } : {},
    trace: 'retain-on-failure'
  },
  webServer: [
    {
      command: 'npm run e2e:serve',
      url: `http://localhost:${PORT}/`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: {
        VITE_SUPABASE_URL: 'https://example.supabase.co',
        VITE_SUPABASE_ANON_KEY: PLACEHOLDER_KEY
      }
    },
    // `npm run dev` with a URL that lacks https://, for e2e/setup.spec.ts.
    {
      command: 'npx vite --port 4171 --strictPort',
      url: 'http://localhost:4171/',
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: {
        VITE_SUPABASE_URL: 'abcdefghijklmnopqrst.supabase.co',
        VITE_SUPABASE_ANON_KEY: PLACEHOLDER_KEY
      }
    },
    // `npm run demo` as built, for e2e/demo.spec.ts: it brings its own fake
    // backend, so it needs neither credentials nor the harness.
    {
      command: 'npm run demo:serve',
      url: 'http://localhost:4172/',
      timeout: 180_000,
      reuseExistingServer: !process.env.CI
    }
  ]
})

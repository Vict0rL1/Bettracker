import fs from 'node:fs'
import { defineConfig } from '@playwright/test'

// Chromium: el que diga PLAYWRIGHT_CHROMIUM, o el preinstalado del contenedor de desarrollo
// si existe, o el que `playwright install chromium` haya bajado (CI).
const chromium =
  process.env.PLAYWRIGHT_CHROMIUM ??
  (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined)

const PORT = 4173

// The suite never talks to a real backend. The app is built with placeholder
// credentials (so main.tsx renders the app instead of the "not configured"
// screen) and every test injects `window.__supabaseMock` before the bundle
// runs — see e2e/harness.ts. The build goes to dist-e2e/ so it can't be
// mistaken for a deployable bundle.
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
  webServer: {
    command: 'npm run e2e:serve',
    url: `http://localhost:${PORT}/`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'e2e-placeholder-not-a-real-key'
    }
  }
})

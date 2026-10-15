import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// The project folder (where package.json and .env live). `root` points Vite at
// the renderer sources, but env files should load from the project folder so
// `.env` sits next to package.json — the natural place to put it.
const projectDir = fileURLToPath(new URL('.', import.meta.url))

// `npm run demo` (mode "demo"): a script ahead of main.tsx installs a fake
// backend that keeps everything in the browser — see src/demo/. Any other
// mode leaves index.html alone, so the demo is never in the real app.
const demo: Plugin = {
  name: 'bettracker-demo',
  transformIndexHtml: {
    // Before Vite reads the page's scripts, so the build bundles this one too.
    order: 'pre',
    handler(html) {
      const main = '<script type="module" src="/src/main.tsx">'
      if (!html.includes(main)) throw new Error('bettracker-demo: index.html no longer loads /src/main.tsx')
      return html.replace(main, `<script type="module" src="/src/demo/start.ts"></script>\n    ${main}`)
    }
  }
}

// Standalone web build — this is what you deploy and install on your phone.
// (The desktop Electron build uses electron.vite.config.ts instead.)
export default defineConfig(({ mode }) => ({
  root: 'src/renderer',
  publicDir: 'public',
  envDir: projectDir,
  base: '/',
  server: {
    host: true, // expose on the LAN so you can open the dev app on your phone
    // The demo gets its own port, so its browser storage never mixes with the
    // real app's: below 5173, where a busy 5173 never sends `npm run dev`
    // (Vite only tries higher ports).
    port: mode === 'demo' ? 5172 : 5173,
    strictPort: mode === 'demo'
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true
  },
  plugins: [
    ...(mode === 'demo' ? [demo] : []),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'BetTracker',
        short_name: 'BetTracker',
        description: 'Track your daily sports betting wins and losses, synced across your devices.',
        theme_color: '#0a0f14',
        background_color: '#0a0f14',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}']
      }
    })
  ]
}))

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// The project folder (where package.json and .env live). `root` points Vite at
// the renderer sources, but env files should load from the project folder so
// `.env` sits next to package.json — the natural place to put it.
const projectDir = fileURLToPath(new URL('.', import.meta.url))

// Standalone web build — this is what you deploy and install on your phone.
// (The desktop Electron build uses electron.vite.config.ts instead.)
export default defineConfig({
  root: 'src/renderer',
  publicDir: 'public',
  envDir: projectDir,
  base: '/',
  server: {
    host: true, // expose on the LAN so you can open the dev app on your phone
    port: 5173
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true
  },
  plugins: [
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
})

import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { supabaseEnvCheck } from './src/shared/supabaseEnv'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    // The installer carries .env too: the same check as the web build.
    plugins: [supabaseEnvCheck(), react()]
  }
})

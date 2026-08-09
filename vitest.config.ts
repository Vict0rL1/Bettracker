import { defineConfig } from 'vitest/config'

// Kept separate from vite.config.ts: that one sets `root: src/renderer` for the
// app build, which would hide the tests and the project-root paths below.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/renderer/src/test-setup.ts']
  }
})

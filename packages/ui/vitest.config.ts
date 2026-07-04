import { defineConfig } from 'vitest/config'

// Component tests (*.test.tsx) render React, so they need a DOM environment; jsdom serves them and the pure
// view-model/helper tests alike.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts']
  }
})

import { defineConfig } from 'vitest/config'

// Two environments in one package: the main process + shared/dev code is pure Node (no DOM), while the
// renderer's chrome components render React and need jsdom. Split as vitest projects so each test file runs
// under the right environment from one `vitest run`.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts', 'src/dev/**/*.test.ts']
        }
      },
      {
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'dom',
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/renderer/**/*.test.{ts,tsx}']
        }
      }
    ]
  }
})

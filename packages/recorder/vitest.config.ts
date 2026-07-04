import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'src/detect/**/*.test.ts']
        }
      },
      {
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}']
        }
      }
    ]
  }
})

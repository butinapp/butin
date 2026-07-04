import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

// Workspace packages ship raw TS (no build step), so they must be bundled into the output rather than
// externalized like real node_modules deps — an externalized `@butinapp/*` resolves to a raw `.ts` file Node
// can't load at runtime.
const bundledWorkspace = ['@butinapp/engine', '@butinapp/sdk', '@butinapp/ui']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspace })],
    build: { sourcemap: true, rollupOptions: { input: { index: 'src/main/index.ts' } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspace })],
    build: {
      sourcemap: 'inline',
      rollupOptions: {
        input: {
          index: 'src/preload/index.ts'
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: { '@': resolve(import.meta.dirname, 'src/renderer') } },
    plugins: [react(), tailwindcss()],
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})

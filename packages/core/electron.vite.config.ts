import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

// Workspace packages ship raw TS (no build step), so they must be bundled into the output rather than
// externalized like real node_modules deps — an externalized `@butinapp/*` resolves to a raw `.ts` file Node
// can't load at runtime. They're excluded from externalization in BOTH main AND preload: the preload pulls in
// shared/ipc.ts (which references @butinapp/* types), so a stray value/side-effect import there must bundle,
// not externalize. Plugins aren't listed: plugins.ts imports them by relative path, never externalized.
const bundledWorkspace = ['@butinapp/engine', '@butinapp/sdk', '@butinapp/shapes', '@butinapp/ui']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspace })],
    // sourcemap so a thrown error in a bundled plugin/collector resolves to its real .ts:line in the stack,
    // not an opaque out/main/index.js:23336 offset.
    build: { sourcemap: true, rollupOptions: { input: { index: 'src/main/index.ts' } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspace })],
    build: { sourcemap: 'inline', rollupOptions: { input: { index: 'src/preload/index.ts' } } }
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: { '@': resolve(import.meta.dirname, 'src/renderer') } },
    plugins: [react(), tailwindcss()],
    build: { sourcemap: true, rollupOptions: { input: { index: 'src/renderer/index.html' } } }
  }
})

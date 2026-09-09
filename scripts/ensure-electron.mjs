#!/usr/bin/env node
// Electron ships its platform binary through the package's own postinstall download, and pnpm can treat that build as
// already satisfied — a store carried over from another checkout is enough — linking the package with no `dist/`. The
// gap only surfaces much later, as electron-vite's opaque "Error: Electron uninstall" on `pnpm dev` / `pnpm record`,
// so `prepare` runs the installer after every install: it exits immediately when the binary is already there, and
// re-extracts from the local @electron/get cache when it is not. Set ELECTRON_SKIP_BINARY_DOWNLOAD=1 for an install
// that only needs to lint, typecheck, or test.

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  process.exit(0)
}

let electronDir

try {
  const requireFromCore = createRequire(new URL('../packages/core/package.json', import.meta.url))

  electronDir = dirname(requireFromCore.resolve('electron/package.json'))
} catch {
  process.exit(0) // electron is not linked here — nothing to verify
}

try {
  execFileSync(process.execPath, ['install.js'], { cwd: electronDir, stdio: 'inherit' })
} catch {
  console.error(
    'butin: the electron binary is unavailable — `pnpm dev` and `pnpm record` would fail with "Electron uninstall".'
  )
  console.error(
    'butin: re-run `pnpm rebuild electron` with network access, or set ELECTRON_SKIP_BINARY_DOWNLOAD=1 to install without it.'
  )
  process.exit(1)
}

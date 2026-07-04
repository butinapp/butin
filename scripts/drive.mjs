// Launch the BUILT Electron app under Playwright, walk a few hash routes, and write a screenshot per route
// to a temp folder — an autonomous "did the UI render right" check that needs no logged-in session and no
// downloaded browser (it drives the project's own Electron, not a Playwright browser).
//
// Prereqs:
//   pnpm build            # produces packages/core/out/main/index.js
//   (no other Butin instance running — the single-instance lock would reject this launch)
//
// Usage:
//   node scripts/drive.mjs                      # default routes: Overview + Management
//   node scripts/drive.mjs '#/management' '#/service/serper'
//
// Env:
//   BUTIN_HOME=/path       Butin's whole store (config + data + profiles). Default: a throwaway temp dir, so
//                          the run is a clean room that never reads or mutates your real ~/butin. For real
//                          logged-in data, prefer the live-app CDP route (the `butin-app` MCP server).
//   BUTIN_USERDATA=/path   Electron user-data dir (cookie partition). Default: a throwaway temp dir.

import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const coreDir = resolve(here, '../packages/core')
const mainEntry = join(coreDir, 'out/main/index.js')

if (!existsSync(mainEntry)) {
  console.error(`Missing ${mainEntry}\nBuild the app first:  pnpm build`)
  process.exit(1)
}

const routes = process.argv.slice(2)
const targets = routes.length > 0 ? routes : ['#/', '#/management']

const butinHome = process.env.BUTIN_HOME ?? (await mkdtemp(join(tmpdir(), 'butin-home-')))
const userDataDir = process.env.BUTIN_USERDATA ?? (await mkdtemp(join(tmpdir(), 'butin-drive-')))
const shotsDir = await mkdtemp(join(tmpdir(), 'butin-shots-'))

const app = await electron.launch({
  args: [coreDir, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, BUTIN_HOME: butinHome }
})

try {
  const win = await app.firstWindow()

  await win.waitForLoadState('domcontentloaded')
  // Playwright emulates prefers-color-scheme: light on the pages it drives, which flips a `system`-themed app
  // to light. Pin dark so screenshots match Butin's dark-first default instead of the harness's emulation.
  await win.emulateMedia({ colorScheme: 'dark' })

  for (const hash of targets) {
    await win.evaluate((h) => {
      location.hash = h
    }, hash)
    await win.waitForTimeout(700) // let the route settle + any cached report read finish
    const file = join(shotsDir, `${hash.replace(/[^a-z0-9]+/gi, '_') || 'root'}.png`)

    await win.screenshot({ path: file })
    console.log(`✓ ${hash} → ${file}`)
  }

  console.log(`\nScreenshots: ${shotsDir}`)
} finally {
  await app.close()
}

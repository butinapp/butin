// Boot the BUILT Electron app against a SEEDED store and assert the data reached the screen — the layer above
// smoke.mjs. Smoke boots an empty home and proves the app comes up at all; this seeds a home first, so what it
// proves is the round trip: main reads the store, the preload bridge carries it, the renderer draws it.
//
// That round trip is precisely what the component tests cannot reach. They render against a stubbed
// `window.butin`, so a break anywhere between the store on disk and the IPC boundary renders green there and
// blank here.
//
// Prereqs:
//   pnpm build            # produces packages/core/out/{main,preload,renderer}
//   (no other Butin instance running — the single-instance lock would reject this launch)
//
// Usage:
//   pnpm e2e
//
// Env:
//   BUTIN_HOME=/path       Reuse an already-seeded store instead of seeding a fresh one. Default: a throwaway
//                          temp dir this script seeds itself, so the run never touches your real ~/butin.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const coreDir = resolve(repoRoot, 'packages/core')
const mainEntry = join(coreDir, 'out/main/index.js')

if (!existsSync(mainEntry)) {
  console.error(`Missing ${mainEntry}\nBuild the app first:  pnpm build`)
  process.exit(1)
}

const seeded = process.env.BUTIN_HOME
const butinHome = seeded ?? (await mkdtemp(join(tmpdir(), 'butin-e2e-home-')))
const userDataDir = await mkdtemp(join(tmpdir(), 'butin-e2e-ud-'))

if (!seeded) {
  console.log('[e2e] seeding a demo store…')
  // The seed is deterministic, so an assertion below that holds once holds on every later run.
  //
  // Run the seeder's own entry under this Node rather than through `pnpm seed-demo`. On Windows `pnpm` is a .cmd
  // shim, which Node declines to spawn without a shell, and a shell concatenates its arguments instead of
  // escaping them — so a home path containing a space would arrive split in two.
  const tsxPkg = createRequire(import.meta.url).resolve('tsx/package.json')
  const tsxCli = resolve(dirname(tsxPkg), JSON.parse(readFileSync(tsxPkg, 'utf8')).bin)

  execFileSync(process.execPath, [tsxCli, 'scripts/seed-demo.ts', '--home', butinHome], {
    cwd: repoRoot,
    stdio: 'inherit'
  })
}

const app = await electron.launch({
  // Chromium's setuid sandbox wants a root-owned helper binary that an unpacked Electron on a CI runner does not
  // have, and the launch dies before any window exists. Off only under CI — this app drives the real web locally.
  args: [coreDir, `--user-data-dir=${userDataDir}`, ...(process.env.CI ? ['--no-sandbox'] : [])],
  env: { ...process.env, BUTIN_HOME: butinHome }
})

const failures = []
const passed = []

const check = (name, ok, detail) => (ok ? passed.push(name) : failures.push(`${name} — ${detail}`))

app.process().stderr?.on('data', (d) => process.stderr.write(`[main:err] ${d}`))

try {
  const win = await app.firstWindow()

  win.on('pageerror', (e) => failures.push(`pageerror: ${e.stack || e.message}`))

  await win.waitForLoadState('domcontentloaded')

  // The seeded plugins have to survive the trip out of the store and into the sidebar. Nothing renders here
  // unless main enumerated the profile's plugins and the bridge delivered them.
  const services = win.locator('[data-testid="sidebar-service"]')
  const serviceCount = await services
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => services.count())
    .catch(() => 0)

  check('sidebar lists seeded services', serviceCount > 0, 'no service rows rendered from the seeded store')

  // Overview is assembled in main from the cached reports, so a number here means the ledger was read, rolled
  // up, and handed across. An empty store still renders the cards — hence the digit, not just the element.
  const statsText = await win
    .locator('[data-testid="overview-stats"]')
    .textContent({ timeout: 15_000 })
    .catch(() => '')

  check('overview renders a spend figure', /\d/.test(statsText ?? ''), `stat cards held no number: "${statsText}"`)

  // A service page reads that plugin's stored report on its own path, one capability at a time.
  if (serviceCount > 0) {
    await services.first().click()

    const tabs = await win
      .locator('[data-testid="capability-tabs"]')
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false)

    check('service page renders capability tabs', tabs, 'no capability tabs after opening a service')

    const dashboard = await win
      .locator('[data-testid="dashboard"]')
      .first()
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false)

    check('capability renders its dataset', dashboard, 'the capability drew no dashboard')
  }
} catch (e) {
  failures.push(`launch/eval threw: ${e.stack || e}`)
} finally {
  await app.close()
}

for (const p of passed) {
  console.log(`  ✓ ${p}`)
}

if (failures.length > 0) {
  console.error(`\n✗ e2e FAILED (${failures.length}):`)

  for (const f of failures) {
    console.error(`  • ${f}`)
  }

  process.exit(1)
}

console.log('\n✓ e2e: seeded data reached the screen')

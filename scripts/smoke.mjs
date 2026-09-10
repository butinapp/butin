// Boot the BUILT Electron app under Playwright in a clean room and assert it actually renders — a headless
// "does the app come up" check that catches the class of failure unit tests and typecheck can't see: a
// preload that fails to load (so `window.butin` is undefined), a renderer that throws before React mounts,
// a main-process boot crash. Exits non-zero on any of those, so it's CI-able.
//
// This is the companion to `drive.mjs`: drive walks routes and screenshots them (visual), smoke asserts the
// app boots clean (health). Run smoke first — a red smoke means drive's screenshots would be the splash too.
//
// Prereqs:
//   pnpm build            # produces packages/core/out/{main,preload,renderer}
//   (no other Butin instance running — the single-instance lock would reject this launch)
//
// Usage:
//   pnpm smoke            # or: node scripts/smoke.mjs
//
// Env:
//   BUTIN_HOME=/path       Butin's whole store. Default: a throwaway temp dir (clean room — never touches ~/butin).
//   BUTIN_USERDATA=/path   Electron user-data dir. Default: a throwaway temp dir.

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

const butinHome = process.env.BUTIN_HOME ?? (await mkdtemp(join(tmpdir(), 'butin-smoke-home-')))
const userDataDir = process.env.BUTIN_USERDATA ?? (await mkdtemp(join(tmpdir(), 'butin-smoke-ud-')))

const app = await electron.launch({
  args: [coreDir, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, BUTIN_HOME: butinHome }
})

// Failures exit the run non-zero: an uncaught renderer exception (the preload / pre-mount-throw class) or a
// failed assertion below. Console errors are NOT failures — CSP font/style noise lands there in dev — so they
// print as warnings for visibility without flapping the gate.
const failures = []
const warnings = []

app.process().stderr?.on('data', (d) => process.stderr.write(`[main:err] ${d}`))

try {
  const win = await app.firstWindow()

  win.on('console', (m) => m.type() === 'error' && warnings.push(m.text()))
  win.on('pageerror', (e) => failures.push(`pageerror: ${e.stack || e.message}`))

  // The preload must have exposed the IPC bridge — its absence is the exact symptom the preload crash
  // produced (undefined `window.butin` → renderer throws on first access → stuck on the splash).
  //
  // Polled rather than read once: firstWindow() resolves as soon as the BrowserWindow exists, which can be
  // before main has navigated it to the app. A load state awaited at that moment is satisfied by the initial
  // empty document, and the navigation then destroys that context under a one-shot evaluate. waitForFunction
  // re-runs in whichever context is current, so it outlives the navigation while asserting the same thing.
  const hasBridge = await win
    .waitForFunction(() => typeof window.butin === 'object' && window.butin !== null, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false)

  if (!hasBridge) {
    failures.push('window.butin is not exposed — preload failed to load')
  }

  // Wait for React to replace the static splash with real chrome (the sidebar nav lands once the app mounts).
  // A condition wait, not a fixed sleep: a clean boot satisfies it in a few hundred ms, a broken one times out.
  const rendered = await win
    .waitForFunction(() => (document.getElementById('root')?.textContent?.length ?? 0) > 20, { timeout: 8000 })
    .then(() => true)
    .catch(() => false)

  if (!rendered) {
    const head = await win.evaluate(() => document.getElementById('root')?.innerHTML?.slice(0, 300) ?? '(no #root)')

    failures.push(`shell never rendered — #root stayed empty. head: ${head}`)
  }
} catch (e) {
  failures.push(`launch/eval threw: ${e.stack || e}`)
} finally {
  await app.close()
}

if (warnings.length > 0) {
  console.warn(`\n⚠ ${warnings.length} console error(s) (not a failure — CSP/dev noise):`)

  for (const w of warnings) {
    console.warn(`  • ${w.slice(0, 160)}`)
  }
}

if (failures.length > 0) {
  console.error(`\n✗ smoke FAILED (${failures.length}):`)

  for (const f of failures) {
    console.error(`  • ${f}`)
  }

  process.exit(1)
}

console.log('\n✓ smoke: app boots clean — preload bridge exposed, shell rendered')

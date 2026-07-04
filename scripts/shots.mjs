// One-off: capture landing-page product screenshots from the SEEDED demo home. Not part of the app or CI —
// a helper to refresh packages/website/public/shots/*.png. Run after `pnpm seed-demo --home ./.demo-home`
// and `pnpm build`:
//   node scripts/shots.mjs
// Drives the project's own Electron under Playwright at a fixed window size, dark theme, over the seeded
// BUTIN_HOME (synthetic data, no real accounts).

import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const coreDir = resolve(here, '../packages/core')
const outDir = resolve(here, '../packages/website/public/shots')
const home = resolve(here, '../.demo-home')

const W = 1440
const H = 900

const targets = [
  ['#/', 'overview'],
  ['#/service/claude', 'service-claude'],
  ['#/service/videotron', 'service-videotron'],
  ['#/people', 'people'],
  ['#/management', 'management']
]

await mkdir(outDir, { recursive: true })
const userDataDir = await mkdtemp(join(tmpdir(), 'butin-shots-'))

const app = await electron.launch({
  args: [coreDir, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, BUTIN_HOME: home }
})

try {
  const win = await app.firstWindow()

  await win.waitForLoadState('domcontentloaded')
  await win.emulateMedia({ colorScheme: 'dark' })
  await app.evaluate(({ BrowserWindow }, { w, h }) => BrowserWindow.getAllWindows()[0]?.setContentSize(w, h), {
    w: W,
    h: H
  })
  await win.waitForTimeout(400)

  for (const [hash, name] of targets) {
    await win.evaluate((h) => {
      location.hash = h
    }, hash)
    await win.waitForTimeout(1100) // route settle + cached report read + chart paint
    const file = join(outDir, `${name}.png`)

    await win.screenshot({ path: file })
    console.log(`✓ ${hash} → ${file}`)
  }
} finally {
  await app.close()
}

// One-off: launch the BUILT recorder under Playwright and dump renderer console + page errors, so a
// white-page (renderer throw) is visible. Build first: pnpm --filter @butinapp/recorder build
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const recorderDir = resolve(here, '../packages/recorder')
const butinHome = await mkdtemp(join(tmpdir(), 'butin-rec-home-'))
const userDataDir = await mkdtemp(join(tmpdir(), 'butin-rec-ud-'))

const app = await electron.launch({
  args: [recorderDir, `--user-data-dir=${userDataDir}`],
  cwd: recorderDir,
  env: { ...process.env, BUTIN_HOME: butinHome }
})

const win = await app.firstWindow()

win.on('console', (m) => console.log(`[console:${m.type()}] ${m.text()}`))
win.on('pageerror', (e) => console.log(`[pageerror] ${e.stack ?? e.message}`))

await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(2500)

const rootHtml = await win.evaluate(() => document.getElementById('root')?.innerHTML?.slice(0, 300) ?? 'NO #root')

console.log(`\n[#root innerHTML first 300] ${rootHtml}`)

await app.close()

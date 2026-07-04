import { app, shell } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { log } from '../log.js'
import { readBytes } from '../store/secure-fs.js'
import { dataRootDir } from '../store/store.js'
import { isSealed } from '../vault/vault.js'

// Opening an encrypted document means handing a PLAINTEXT copy to an external OS app. That app holds the file
// open — often for as long as the user keeps it on screen — and Windows refuses to delete an open file. So
// prompt mid-session deletion can only ever be best-effort; the real guarantees are the two SWEEPS of this
// dedicated directory: one on boot (clears whatever a prior session left behind, by which point the external
// viewer is almost certainly closed) and one on quit. Isolating every decrypted copy in one dir is what makes
// a clean sweep possible.
const openTempDir = (): string => join(app.getPath('temp'), 'butin-open')

// Remove the whole decrypted-document scratch dir. Boot calls it to clear a prior session's leftovers; quit
// calls it to clear this session's. Files still held open by a viewer survive (force ignores ENOENT but a
// locked file rejects) — the next boot sweep collects them once the viewer has let go.
export const sweepOpenTempDir = async (): Promise<void> => {
  await rm(openTempDir(), { recursive: true, force: true }).catch(() => {})
}

// 1m → 5m → 15m. Each attempt deletes the temp if the viewer has released it; a still-open file rejects and
// reschedules. After the last attempt we stop and rely on the boot/quit sweep — a bounded set of timers, none
// of which keep the process alive (unref).
const CLEANUP_DELAYS_MS = [60_000, 300_000, 900_000]

const scheduleCleanup = (tempPath: string, attempt = 0): void => {
  if (attempt >= CLEANUP_DELAYS_MS.length) {
    return
  }

  setTimeout(() => {
    void rm(tempPath, { force: true }).then(
      () => undefined,
      () => scheduleCleanup(tempPath, attempt + 1)
    )
  }, CLEANUP_DELAYS_MS[attempt]).unref()
}

// Open a downloaded document in its OS default app. A plaintext file (OFF profile, or a custom external
// documents dir) opens in place. A sealed file is decrypted to an isolated temp copy, opened, and cleaned by
// the retrying best-effort pass + the boot/quit sweeps. Never throws across IPC.
export const openDocumentFile = async (path: string): Promise<void> => {
  try {
    const raw = await readFile(path).catch(() => null)

    if (!raw || !isSealed(raw)) {
      await shell.openPath(path)

      return
    }

    const plaintext = await readBytes(dataRootDir(), path)

    if (!plaintext) {
      return // locked / unreadable — nothing to open
    }

    const dir = openTempDir()

    await mkdir(dir, { recursive: true })

    const tempPath = join(dir, `${Date.now()}-${basename(path)}`)

    await writeFile(tempPath, plaintext)
    await shell.openPath(tempPath)
    scheduleCleanup(tempPath)
  } catch (err) {
    log.error('documents', `failed to open ${path}`, err)
  }
}

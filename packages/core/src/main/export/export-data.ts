import type { ExportBundle } from '@butinapp/shapes/bundle'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { isUnlocked, sealForDir, vaultExists } from '../vault/vault.js'

// A filesystem-safe export filename from the active profile name + the second-trimmed ISO time, so default
// names sort chronologically and a same-second rerun lands beside the OS save dialog's auto-suffix.
export const exportFileName = (profileName: string, now: Date): string => {
  const stamp = now
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\.\d+Z$/, '')

  return `butin-${profileName.replace(/[^a-z0-9-_]+/gi, '-')}-${stamp}.json`
}

// Write a viewer bundle to `destPath`. Plaintext by default so the file is viewer-readable; `encrypt`
// (honoured only on an unlocked encrypted profile, keyed by `root`) vault-seals the bytes and suffixes
// `.btnv` — that file reopens only inside this profile, NOT in the viewer. Electron-free: the caller resolves
// the bundle + the Downloads-relative default path.
export const writeExportFile = async (opts: {
  bundle: ExportBundle
  root: string
  destPath: string
  encrypt: boolean
}): Promise<{ path: string }> => {
  const json = Buffer.from(JSON.stringify(opts.bundle, null, 2), 'utf8')
  const encrypting = opts.encrypt && vaultExists(opts.root) && isUnlocked(opts.root)
  const path = encrypting && !opts.destPath.endsWith('.btnv') ? `${opts.destPath}.btnv` : opts.destPath

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, encrypting ? sealForDir(opts.root, json) : json)

  return { path }
}

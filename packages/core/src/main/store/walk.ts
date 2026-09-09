import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

// One file found under a walked root: its absolute path, its path relative to that root (always with forward
// slashes, so it reads the same on every platform), and its size.
export type WalkedFile = { abs: string; rel: string; size: number }

// Every file under `dir`, recursively. A missing directory yields nothing, and a file that vanishes between
// the readdir and the stat is skipped: both walk a tree the OS is free to change underneath us (a documents
// folder being written to, a service folder erased mid-scan), and neither is a reason to fail the caller.
export const walkFiles = async (dir: string): Promise<WalkedFile[]> => {
  const out: WalkedFile[] = []

  const walk = async (at: string): Promise<void> => {
    let entries

    try {
      entries = await readdir(at, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const abs = join(at, entry.name)

      if (entry.isDirectory()) {
        await walk(abs)

        continue
      }

      if (!entry.isFile()) {
        continue
      }

      try {
        out.push({ abs, rel: relative(dir, abs).split(/[\\/]/).join('/'), size: (await stat(abs)).size })
      } catch {
        // vanished between readdir and stat
      }
    }
  }

  await walk(dir)

  return out
}

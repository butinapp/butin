import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// Walk up from a starting dir to the workspace root (the dir holding pnpm-workspace.yaml). The recorder is a
// dev-only tool always launched from within the butin checkout, so cwd is inside the repo; this finds the root
// whether pnpm ran us from the repo root or the package dir. BUTIN_REPO_ROOT overrides (tests / unusual launches).
export const resolveRepoRoot = (start: string = process.cwd()): string => {
  if (process.env.BUTIN_REPO_ROOT) {
    return resolve(process.env.BUTIN_REPO_ROOT)
  }

  let dir = resolve(start)

  for (;;) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      return dir
    }

    const parent = dirname(dir)

    if (parent === dir) {
      throw new Error(`repo root (pnpm-workspace.yaml) not found walking up from ${start}`)
    }

    dir = parent
  }
}

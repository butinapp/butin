#!/usr/bin/env node
// Wires the committed .githooks/ dir as git's hooks path so the pre-commit guard runs for everyone on
// `pnpm install` (via the package.json "prepare" script). No husky/lefthook dependency.
// Silently no-ops outside a git checkout (e.g. a tarball install).

import { execFileSync } from 'node:child_process'

try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' })
} catch {
  process.exit(0) // not a git checkout — nothing to wire up
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'])
  console.log('butin: git hooks installed (core.hooksPath=.githooks)')
} catch (err) {
  console.error(`butin: could not set core.hooksPath (${err.message}) — install hooks manually if needed`)
}

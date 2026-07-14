// Bump the published library graph — @butinapp/sdk, @butinapp/shapes, @butinapp/ui — in LOCKSTEP.
//
// publish-npm.yml anchors the release on @butinapp/sdk's version and publishes all three together, so they
// MUST share one version: bumping shapes/ui without sdk leaves the anchor unchanged, the check job sees that
// version already on npm, and the whole publish silently skips. Run this instead of hand-editing the files.
//
//   pnpm bump-libs 0.2.0     # set an explicit version on all three
//   pnpm bump-libs patch     # bump the shared version (0.1.2 → 0.1.3)
//   pnpm bump-libs minor     # 0.1.2 → 0.2.0
//   pnpm bump-libs major     # 0.1.2 → 1.0.0
//
// Writes the version field on each package.json (nothing else), then prints the next step. Commit + push to
// master to trigger the release.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIBS = ['sdk', 'shapes', 'ui']
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = (name) => resolve(root, 'packages', name, 'package.json')
const versionOf = (name) => JSON.parse(readFileSync(pkgPath(name), 'utf8')).version

const usage = 'usage: pnpm bump-libs <version|patch|minor|major>'

const bump = (version, kind) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)

  if (!match) {
    throw new Error(`can't ${kind}-bump non-semver version "${version}" — pass an explicit x.y.z`)
  }

  let [major, minor, patch] = match.slice(1).map(Number)

  if (kind === 'major') {
    ;[major, minor, patch] = [major + 1, 0, 0]
  } else if (kind === 'minor') {
    ;[minor, patch] = [minor + 1, 0]
  } else {
    patch += 1
  }

  return `${major}.${minor}.${patch}`
}

const arg = process.argv[2]

if (!arg) {
  console.error(usage)
  process.exit(1)
}

const current = LIBS.map(versionOf)

if (new Set(current).size > 1) {
  console.warn(`libs are out of lockstep (${LIBS.map((n, i) => `${n}=${current[i]}`).join(', ')}) — realigning them`)
}

let next

if (/^\d+\.\d+\.\d+$/.test(arg)) {
  next = arg
} else if (['patch', 'minor', 'major'].includes(arg)) {
  // Bump from the highest current version, so a realignment can't step backwards.
  const from = [...current].sort((a, b) => (a < b ? 1 : -1))[0]

  next = bump(from, arg)
} else {
  console.error(`invalid argument "${arg}"\n${usage}`)
  process.exit(1)
}

for (const name of LIBS) {
  const path = pkgPath(name)
  const src = readFileSync(path, 'utf8')
  const updated = src.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`)

  if (updated === src) {
    throw new Error(`no version field found in packages/${name}/package.json`)
  }

  writeFileSync(path, updated)
}

console.log(`@butinapp/{${LIBS.join(',')}} → ${next}`)
console.log('next: commit the three package.json changes and push to master — publish-npm.yml releases them.')

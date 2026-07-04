import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

// A plugin declares its `reportingCurrency` once; core stamps it onto every money value that didn't declare
// its own (plugin-host runCapability → resolveCurrencies). So a Column/Summary that hardcodes `currency:` equal
// to its plugin's reportingCurrency is pure restatement — a second source of the same truth that silently wins
// (and diverges) the moment reportingCurrency changes, and that hides a real bug when a non-USD plugin copies a
// `currency: 'USD'` column. Keep `currency:` ONLY as a genuine per-value override (a value in a DIFFERENT
// currency than the plugin reports). This guard scans plugin source for the redundant case across every plugin.
const PLUGINS_DIR = join(import.meta.dirname, '../../../../../plugins')

// Source files that build descriptors. `*.test.ts` (assertions) and `sample.ts` (raw API payloads, where a
// `currency` field is real response data, not a descriptor) are excluded.
const isDescriptorSource = (file: string): boolean =>
  file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'sample.ts'

// A plugin is a `plugins/` subdir with a `src/main.ts`; the package's own files (node_modules, .turbo,
// package.json, …) are not plugins.
const pluginDirs = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(PLUGINS_DIR, e.name, 'src', 'main.ts')))
  .map((e) => e.name)

test('no plugin restates its own reportingCurrency on a Column/Summary', () => {
  const offenders: string[] = []

  for (const id of pluginDirs) {
    const srcDir = join(PLUGINS_DIR, id, 'src')
    const main = readFileSync(join(srcDir, 'main.ts'), 'utf8')
    const rc = main.match(/reportingCurrency:\s*'([A-Z]{3})'/)?.[1]

    if (!rc) {
      continue
    }

    const redundant = new RegExp(`currency:\\s*'${rc}'`)

    for (const file of readdirSync(srcDir).filter(isDescriptorSource)) {
      const matches = readFileSync(join(srcDir, file), 'utf8').match(new RegExp(redundant, 'g'))

      if (matches) {
        offenders.push(`${id}/src/${file}: ${matches.length}× currency: '${rc}' (== reportingCurrency)`)
      }
    }
  }

  expect(
    offenders,
    `Drop the redundant currency literal (reportingCurrency already stamps it):\n${offenders.join('\n')}`
  ).toEqual([])
})

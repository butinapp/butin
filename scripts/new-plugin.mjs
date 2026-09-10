#!/usr/bin/env node
// Scaffold a new Butin plugin so adding a service is `pnpm new-plugin <id>` + write the collect() bodies.
//
// Stamps plugins/<id>/ with the 2 files a plugin needs (main.ts · main.test.ts). Plugins are folders in
// the single @butinapp/plugins package — no per-plugin package.json or tsconfig — so there's no workspace
// member to register and NO `pnpm install` step. Registration is automatic: core's plugins.ts auto-discovers
// plugins/*/main.ts via import.meta.glob. Just write the collect() bodies and run the gate.
//
// Zero dependencies (Node built-ins only).
//
// Usage:
//   pnpm new-plugin <id> [--name "Display Name"] [--vendor "Vendor"]
//   node scripts/new-plugin.mjs <id> [options]
//
//   <id>            kebab-case plugin id (folder name + meta.id), e.g. `stripe`, `github-enterprise`
//   --name <str>    display name (meta.name); default = Title Case of the id
//   --vendor <str>  vendor label (meta.vendor); default = the display name
//   --force         overwrite an existing plugins/<id>/ (refuses by default)

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)

  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined
}
const has = (name) => args.includes(`--${name}`)

const id = args.find((a) => !a.startsWith('--'))

if (!id) {
  console.error('Usage: pnpm new-plugin <id> [--name "Display Name"] [--vendor "Vendor"] [--force]')
  process.exit(1)
}

if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
  console.error(`Invalid id '${id}': use kebab-case (lowercase letters, digits, single hyphens).`)
  process.exit(1)
}

// Surface-always convention guard: an id names a SURFACE, never a bare vendor once that vendor ships 2+
// surfaces. Read the sibling plugin folders (plugins/ also holds a stray assets.d.ts — directories only) to
// catch the land-grab at authoring time, before a PR exists.
const pluginsDir = resolve(repoRoot, 'plugins')
const existingIds = existsSync(pluginsDir)
  ? readdirSync(pluginsDir).filter((f) => existsSync(resolve(pluginsDir, f, 'main.ts')))
  : []

// An existing `<id>-<surface>` means the requested bare id would grab a multi-surface vendor's namespace.
const qualifiedSurfaces = existingIds.filter((e) => e.startsWith(`${id}-`))

if (qualifiedSurfaces.length > 0 && !has('force')) {
  console.error(
    `id '${id}' collides with existing surface(s): ${qualifiedSurfaces.join(', ')}. This vendor already has ` +
      `multiple surfaces — name your surface, e.g. '${id}-<surface>'. (--force to override.)`
  )
  process.exit(1)
}

// Requested `<vendor>-<surface>` while a BARE `<vendor>` plugin still exists → per the convention that
// bare-vendor plugin should be renamed to a qualified surface id. Warn (not fatal — the new id is correct).
const vendorSegment = id.includes('-') ? id.slice(0, id.indexOf('-')) : null

if (vendorSegment && existingIds.includes(vendorSegment)) {
  console.warn(
    `note: a bare-vendor plugin '${vendorSegment}' exists; per the surface-always convention it should likely ` +
      `be renamed to a qualified surface id (e.g. '${vendorSegment}-<surface>').`
  )
}

const titleCase = (s) =>
  s.replace(/(^|-)([a-z0-9])/g, (_, _sep, c) => (s[0] === c ? c.toUpperCase() : ` ${c.toUpperCase()}`)).trim()
const title = titleCase(id)
const camel = id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
const pascal = camel.charAt(0).toUpperCase() + camel.slice(1)
const exportName = `${camel}Plugin`
const i18nConst = `${id.replace(/-/g, '_').toUpperCase()}_EN`
const name = flag('name') ?? title
const vendor = flag('vendor') ?? name

const dir = resolve(repoRoot, 'plugins', id)

if (existsSync(dir) && !has('force')) {
  console.error(`plugins/${id}/ already exists. Pass --force to overwrite.`)
  process.exit(1)
}

// A minimal, valid, auto-discoverable descriptor: one capability returning a minimal CapabilityResult so it
// typechecks and renders before any real collector exists. The section banners are the CANONICAL layout — keep
// things in this order as the plugin grows; everything stays in this one file (split a capability out only when
// it gets genuinely large). See CLAUDE.md "The engine taxonomy" + plugins/serper/main.ts for the pattern.
const main = `import { type CollectContext, definePlugin } from '@butinapp/sdk'
import { type CapabilityResult, capabilityResult, record } from '@butinapp/sdk/data'

// No icon to ship — Butin renders a brand-colored letter monogram from meta.name + meta.color. Just set a
// good meta.color below. (meta.icon is an optional escape hatch for a plugin's OWN mark only — no logos.)

// ── constants ───────────────────────────────────────────────────────────────────────
// Endpoints, origins, magic numbers. Do NOT hand-pin a User-Agent / sec-ch-ua — core injects the canonical
// browser identity (browser/identity.ts) into both sign-in AND replay so they always agree; set
// transport.userAgent only when a service needs a genuinely different UA than the canonical one.

// ── types ─────────────────────────────────────────────────────────────────────────
// ALL types together (the data dictionary): the Raw* wire shapes the service returns AND the normalized
// domain types, e.g. interface RawThing { ... }. Keeping them here lets the code below read declaration-free.

// ── domain logic (grouped by capability, in capabilities[] order) ───────────────────
// Per capability: an exported build*() (the fixture test target — raw → CapabilityResult) then its collect()
// (a thin fetch via ctx.client that calls the build*()). Prefer the SDK presets (billing.summary/usage.result/
// keys.result/members.result from @butinapp/sdk/presets) + edge utils (@butinapp/sdk/util) — check the SDK
// subpaths before writing any helper.
// TODO: reverse-engineer ${name}'s authed requests, then replace this stub with real capabilities (prefer the
// SDK presets — billing.result/usage.result/keys.result/members.result — over hand-building a CapabilityResult).
const collect${pascal}Status = async (_ctx: CollectContext): Promise<CapabilityResult> =>
  capabilityResult({
    sections: [
      record({
        id: 'status',
        fields: [{ key: 'status', label: 'Status', role: 'text' }],
        value: { status: 'not implemented' }
      }).keyvalue()
    ]
  })

// ── descriptor ──────────────────────────────────────────────────────────────────────
export const ${exportName} = definePlugin({
  // ISO-4217 currency every money value this plugin emits is in (core stamps it onto unlabeled money).
  reportingCurrency: 'USD',
  meta: {
    id: '${id}',
    name: '${name}',
    vendor: '${vendor}'
    // category: 'devtools', color: '#000000', icon,
  },
  // Magic Login capture — see packages/sdk/src/session.ts. Omit entirely for auth.kind 'external'.
  session: {
    loginUrl: 'https://TODO.example.com/login',
    dashboardMarkers: ['/dashboard'],
    cookieDomains: ['TODO.example.com']
  },
  // Auth taxonomy — see packages/sdk/src/auth.ts. 'cookie' replays the stored jar verbatim (no resolve()).
  auth: { kind: 'cookie' },
  // transport: { engine: 'node' }, // 'electron' + requiresBrowserEngine: true for sites that need the browser engine
  capabilities: [{ id: 'status', label: 'Status', collect: collect${pascal}Status }],
  // Connection test — ONE cheap authed request that throws on a dead session. Required.
  probe: async (ctx) => {
    // TODO: point this at the cheapest authed endpoint (e.g. an account/me call) that proves the session is live.
    await ctx.client.get('https://TODO.example.com/')
  }
})

// ── i18n (optional; split to ./i18n.ts when large) ───────────────────────────────────
// const ${i18nConst}: Record<string, string> = { ... } → feed meta.messages.en for label translation.
`

const test = `import { expect, test } from 'vitest'

import { ${exportName} } from './main.js'

test('${id} plugin is well-formed', () => {
  expect(${exportName}.meta.id).toBe('${id}')
  expect(${exportName}.capabilities.length).toBeGreaterThan(0)
})

// PRIMARY coverage pattern (add this once you replace the stub): export a PURE build*() that maps a redacted
// wire fixture → CapabilityResult, then assert its normalized shape here. This — not calling collect() with a
// fake context — is where the real coverage lives (see plugins/serper/main.test.ts).
// A validator returns [] when the result satisfies the contract; it's a cheap guard against typo'd dataset refs
// / mismatched column roles, which are otherwise only caught at runtime in the app. Bind it to the plugin's
// reportingCurrency once, and assert every capability's demo sample with validateSamples.
//
//   import { resultValidator, validateSamples } from '@butinapp/sdk/testing'
//   import { build${pascal}Billing } from './main.js'
//
//   const validate = resultValidator('USD')
//
//   test('billing normalizes', () => {
//     const result = build${pascal}Billing(FIXTURE)
//     expect(validate(result)).toEqual([])
//     expect(result.summaries?.[0]?.value).toBe(123.45)
//   })
//
//   test('every capability declares a sample that is contract-valid', () => {
//     expect(validateSamples(${camel}Plugin)).toEqual([])
//   })
`

mkdirSync(dir, { recursive: true })
writeFileSync(resolve(dir, 'main.ts'), main)
writeFileSync(resolve(dir, 'main.test.ts'), test)

console.log(`Scaffolded plugins/${id}/ (export: ${exportName})

Next:
  1. write the real session/auth/capabilities in plugins/${id}/main.ts (set a good meta.color — the
     icon is an auto-generated letter monogram, nothing to fetch)
  2. pnpm fix && pnpm --filter @butinapp/plugins test

It's already registered (auto-discovered by core's plugins.ts) — no pnpm install, no other files to edit.`)

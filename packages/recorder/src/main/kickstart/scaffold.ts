import type { KickstartInput, PlannedCapability } from './types.js'

const pascal = (s: string): string =>
  s
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')

// Representative authed paths from the navigation log: drop the login/auth hops + the bare root, dedupe,
// cap at 3. These seed session.dashboardMarkers (the post-login URLs that prove a session is live).
const dashboardMarkers = (input: KickstartInput): string[] => {
  const skip = /log[-_]?in|sign[-_]?in|sign_in|auth|oauth|sso|callback|mfa|otp|2fa|verify/i
  const seen = new Set<string>()
  const markers: string[] = []

  for (const run of input.runs) {
    for (const nav of run.navigation) {
      let path: string

      try {
        path = new URL(nav.url).pathname
      } catch {
        continue
      }

      if (path === '/' || skip.test(path) || seen.has(path)) {
        continue
      }

      seen.add(path)
      markers.push(path)

      if (markers.length >= 3) {
        return markers
      }
    }
  }

  return markers
}

// The session block — omitted entirely for auth.kind 'external' (no Magic Login capture). loginUrl + the
// dashboard markers are guesses tagged for verification; cookieDomains defaults to the surface host.
const sessionBlock = (input: KickstartInput): string => {
  if (input.profile.auth.value === 'external') {
    return ''
  }

  const markers = dashboardMarkers(input)
  const markerList = (markers.length > 0 ? markers : ['/dashboard']).map((m) => `'${m}'`).join(', ')

  // Transient auth/session cookies the detector flagged (an IdP session or a rotating OAuth-state cookie): a
  // stale one wedges the next sign-in, so drop it before capture. Emitted only when something was flagged, and
  // tagged TODO — it's a reviewed suggestion, not a certainty (see the "Clear cookies" row in the overview).
  const clear = input.profile.clearBeforeCapture.value
  const cookieBlock =
    clear.length > 0
      ? `    cookieDomains: ['${input.surface}'], // TODO verify the cookie host(s); add requiredCookie if there's one durable cookie
    // TODO verify — flagged transient auth cookies; a stale one wedges re-auth (drop the false positives).
    clearCookiesBeforeCapture: [${clear.map((c) => `'${c}'`).join(', ')}]`
      : `    cookieDomains: ['${input.surface}'] // TODO verify the cookie host(s); add requiredCookie if there's one durable cookie`

  return `  // Magic Login capture — see packages/sdk/src/session.ts.
  session: {
    loginUrl: 'https://${input.surface}/login', // TODO verify the real sign-in URL
    dashboardMarkers: [${markerList}], // TODO verify — observed post-login paths
${cookieBlock}
  },
`
}

// transport is only emitted when it differs from the default (node, no browser engine). A browser-engine
// requirement pins the Electron net.request transport; a non-node engine is named explicitly.
const transportBlock = (input: KickstartInput): string => {
  const t = input.profile.transport.value

  if (t.requiresBrowserEngine) {
    return `  // Detected a browser-engine signal — this edge only accepts a real browser, so replay on Electron net.request (real browser TLS identity).
  transport: { engine: 'electron', requiresBrowserEngine: true },
`
  }

  if (t.engine && t.engine !== 'node') {
    return `  transport: { engine: '${t.engine}' },
`
  }

  return ''
}

// A capability stub: a comment header carrying the detected endpoint + evidence + target preset, then a
// minimal valid CapabilityResult so the file compiles + renders before any real collector exists. Kept a
// placeholder (not a half-written preset call) on purpose — the implementer replaces the body using the
// preset named in the header.
const capabilityStub = (cap: PlannedCapability): string => {
  const fn = `collect${pascal(cap.capId)}`
  const header: string[] = [
    `// ── ${cap.capId}${cap.category ? ` (${cap.category})` : ''} ─────────────────────────────`
  ]

  if (cap.endpointUrl) {
    header.push(`// Detected endpoint: ${cap.endpointMethod ?? 'GET'} ${cap.endpointUrl}`)
  }

  if (cap.evidence.length > 0) {
    header.push('// Evidence — open these for the real response shape:')

    for (const e of cap.evidence) {
      header.push(`//   ${e.path}  (${e.method}${e.status ? ` ${e.status}` : ''})`)
    }
  }

  if (cap.preset) {
    header.push(
      `// TODO: define Raw* from the evidence, map it in a pure exported build${pascal(cap.capId)}(), and return`,
      `//   ${cap.preset}(...) from '@butinapp/sdk/presets'. Fetch in collect() via ctx.client. Replace this stub.`
    )
  } else {
    header.push('// TODO: explore the recording (see PLUGIN-BRIEF.md) for the authed JSON calls worth surfacing,')
    header.push('//   then replace this stub with real capabilities (prefer the SDK presets).')
  }

  return `${header.join('\n')}
const ${fn} = async (_ctx: CollectContext): Promise<CapabilityResult> =>
  capabilityResult({
    sections: [
      record({
        id: '${cap.capId}',
        fields: [{ key: 'status', label: 'Status', role: 'text' }],
        value: { status: 'not implemented' }
      }).keyvalue()
    ]
  })`
}

// Generate the pre-filled plugins/<id>/main.ts. meta/session/auth/transport are filled from the detected
// profile; capabilities are evidence-annotated stubs. Guaranteed to compile + lint green as written.
export const generateMainTs = (input: KickstartInput, capabilities: PlannedCapability[]): string => {
  const exportName = `${input.id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}Plugin`
  const altLine =
    input.profile.authAlternatives.length > 0
      ? `  // Also seen across runs: ${input.profile.authAlternatives.join(', ')} (a dual web+API auth scheme?).\n`
      : ''
  const stubs = capabilities.map(capabilityStub).join('\n\n')
  const capEntries = capabilities
    .map((c) => `    { id: '${c.capId}', label: '${c.label}', collect: collect${pascal(c.capId)} }`)
    .join(',\n')
  const probeUrl = capabilities.find((c) => c.endpointUrl)?.endpointUrl ?? `https://${input.surface}/`

  return `import { type CollectContext, definePlugin } from '@butinapp/sdk'
import { type CapabilityResult, capabilityResult, record } from '@butinapp/sdk/data'

// Scaffolded by the Butin recorder from a recording of ${input.surface}. The profile (auth/session/transport)
// below is pre-filled from the detected traffic; the capabilities are stubs — see PLUGIN-BRIEF.md in the run
// folder for the endpoint evidence and the implementation brief. No icon to ship — set a good meta.color and
// Butin renders a brand-colored letter monogram. (meta.icon is an escape hatch for a plugin's OWN mark only.)

// ── domain logic (grouped by capability, in capabilities[] order) ───────────────────
${stubs}

// ── descriptor ──────────────────────────────────────────────────────────────────────
export const ${exportName} = definePlugin({
  // ISO-4217 currency every money value this plugin emits is in (undetectable — confirm against the service).
  reportingCurrency: 'USD', // TODO verify
  meta: {
    id: '${input.id}',
    name: '${input.name}',
    vendor: '${input.vendor}',
    homepage: 'https://${input.surface}'
    // category: 'devtools', color: '#000000', description: '…'
  },
${sessionBlock(input)}  // Auth taxonomy — see packages/sdk/src/auth.ts. Detected from the recorded requests.
${altLine}  auth: { kind: '${input.profile.auth.value}' },
${transportBlock(input)}  capabilities: [
${capEntries}
  ],
  // Connection test — ONE cheap authed request that throws on a dead session. Required.
  probe: async (ctx) => {
    // TODO: point this at the cheapest authed endpoint (e.g. an account/me call) that proves the session is live.
    await ctx.client.get('${probeUrl}')
  }
})
`
}

// Generate plugins/<id>/main.test.ts. Asserts the descriptor is well-formed; the per-capability
// build*()+fixture coverage is left as a commented skeleton (added once the stubs are implemented).
export const generateTestTs = (input: KickstartInput, capabilities: PlannedCapability[]): string => {
  const exportName = `${input.id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}Plugin`
  const realCaps = capabilities.filter((c) => c.preset)
  const buildExample =
    realCaps.length > 0
      ? `//   import { build${pascal(realCaps[0].capId)} } from './main.js'\n//   import { validateCapabilityResult } from '@butinapp/sdk/data'\n//\n//   test('${realCaps[0].capId} normalizes', () => {\n//     const result = build${pascal(realCaps[0].capId)}(FIXTURE)\n//     expect(validateCapabilityResult(result)).toEqual([])\n//   })`
      : '//   (add a build*() per capability, then assert validateCapabilityResult(result) === [])'

  return `import { expect, test } from 'vitest'

import { ${exportName} } from './main.js'

test('${input.id} plugin is well-formed', () => {
  expect(${exportName}.meta.id).toBe('${input.id}')
  expect(${exportName}.capabilities.length).toBeGreaterThan(0)
})

// PRIMARY coverage pattern (add once you replace the stubs): export a PURE build*() mapping a redacted wire
// fixture → CapabilityResult, then assert its normalized shape. validateCapabilityResult returns [] when the
// result satisfies the contract — a cheap guard against typo'd dataset refs / mismatched column roles.
${buildExample}
`
}

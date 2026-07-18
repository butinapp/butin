import { join } from 'node:path'

import type { KickstartInput, PlannedCapability } from './types.js'

interface Paths {
  briefPath: string
  pluginPath: string
}

const renderProfile = (input: KickstartInput): string => {
  const p = input.profile
  const lines = [
    `- **Auth:** \`${p.auth.value}\` (${p.auth.confidence}) — ${p.auth.evidence.join('; ') || 'no evidence captured'}`
  ]

  if (p.authAlternatives.length > 0) {
    lines.push(
      `- **Also seen:** ${p.authAlternatives.join(', ')} (a service may web-auth by cookie and API-auth by token)`
    )
  }

  const t = p.transport.value

  lines.push(
    `- **Transport:** \`${t.engine}\`${t.requiresBrowserEngine ? ' (requires browser engine)' : ''} (${p.transport.confidence})`
  )
  lines.push(`- **Login:** ${p.login.value} (${p.login.confidence})`)

  if (p.clearBeforeCapture.value.length > 0) {
    lines.push(
      `- **Clear before capture:** ${p.clearBeforeCapture.value.map((c) => `\`${c}\``).join(', ')} (${p.clearBeforeCapture.confidence}) — transient auth cookies pre-filled into \`session.clearCookiesBeforeCapture\`; verify each is not the durable session you replay, then drop any false positive`
    )
  }

  if (p.render.length > 0) {
    lines.push(`- **Render:** ${p.render.map((r) => `${r.host} — ${r.shape}`).join(', ')}`)
  }

  if (p.downloads.length > 0) {
    const mechanisms = [...new Set(p.downloads.map((d) => d.mechanism))].join(', ')

    lines.push(
      `- **Downloads:** ${p.downloads.length} document(s) — mechanism: ${mechanisms} — reproduce with a \`files\` table / \`fetchFile\` (\`native-navigation\` ⇒ \`ctx.browser\`). See each run's \`downloads.json\`.`
    )
  }

  return lines.join('\n')
}

const renderCapability = (cap: PlannedCapability): string => {
  if (!cap.preset) {
    return `No data endpoints were detected. Explore the recording (below) to find the authed JSON calls worth surfacing, then add capabilities.`
  }

  const lines = [`### ${cap.label} — \`${cap.capId}\`  (preset: \`${cap.preset}\`)`]

  if (cap.endpointUrl) {
    lines.push(`- Endpoint: \`${cap.endpointMethod ?? 'GET'} ${cap.endpointUrl}\``)
  }

  if (cap.evidence.length > 0) {
    lines.push('- Evidence (open for the real response shape):')

    for (const e of cap.evidence) {
      lines.push(`  - \`${e.path}\` (${e.method}${e.status ? ` ${e.status}` : ''})`)
    }
  } else {
    lines.push('- No matching request file found in the recording — capture the endpoint and re-record if needed.')
  }

  lines.push(
    `- Define \`Raw*\` from the evidence, map in a pure exported \`build*()\`, fetch in \`collect()\` via \`ctx.client\`, return \`${cap.preset}(...)\`.`
  )

  return lines.join('\n')
}

// The PLUGIN-BRIEF.md body — the hand-off a fresh Claude session reads to implement the scaffolded plugin.
export const generateBrief = (input: KickstartInput, capabilities: PlannedCapability[], paths: Paths): string => {
  const runDirs = input.runs.map((r) => `\`${join(input.runsRoot, r.manifest.runId)}\``).join('\n  - ')
  const briefDir = paths.briefPath.replace(/[/\\]PLUGIN-BRIEF\.md$/, '')

  return `# Implement the ${input.name} Butin plugin

Scaffolded: \`plugins/${input.id}/main.ts\` (+ \`main.test.ts\`). The descriptor's auth/session/transport are
pre-filled from this recording; the capabilities are stubs. Your job: write each capability's pure
\`build*()\` + its \`collect()\`. When done: \`pnpm fix && pnpm --filter @butinapp/plugins test\`.

Plugin file: \`${paths.pluginPath}\`

## Detected profile

${renderProfile(input)}

## Capabilities to implement

${capabilities.map(renderCapability).join('\n\n')}

## SDK contract

- \`definePlugin\` / \`defineCapability\` — \`@butinapp/sdk\`
- \`CapabilityResult\`, \`record\`, \`table\`, \`capabilityResult\` — \`@butinapp/sdk/data\`
- Presets: \`billing.result\` / \`billing.summary\`, \`usage.result\`, \`keys.result\`, \`members.result\` — \`@butinapp/sdk/presets\`
- Edge utils (money / date / fx) — \`@butinapp/sdk/util\`
- Reference plugin: \`plugins/serper/main.ts\` — the \`build*()\`+fixture-test pattern.
- See CLAUDE.md → "The engine taxonomy".

## Recording

- Run folder: \`${briefDir}\` — **read \`AGENTS.md\` there first.**
- All runs for this surface:
  - ${runDirs}
- \`cookies.json\` + \`storage.json\` hold the captured session (what auth replays).

## Guardrails

- Synthetic fixtures only; redact tokens / PII. Never commit a real secret or cookie.
- Named exports, arrow functions, 150-col wrap; comments only where the WHY is non-obvious.
`
}

// The short clipboard kickoff — self-contained enough to paste into Claude and start; it points at the full
// brief for the detail.
export const generatePrompt = (input: KickstartInput, paths: Paths): string =>
  `Implement the new \`${input.id}\` Butin plugin (scaffolded at plugins/${input.id}/main.ts). ` +
  `Full brief: ${paths.briefPath} — read it, open the referenced recording files, write each capability's ` +
  `build*()+collect() with a fixture test, then run pnpm fix && pnpm --filter @butinapp/plugins test.`

import { join } from 'node:path'

import { generateBrief, generatePrompt } from './brief.js'
import { planCapabilities } from './capabilities.js'
import { resolveEvidence } from './evidence.js'
import { generateMainTs, generateTestTs } from './scaffold.js'
import type { KickstartInput, KickstartResult } from './types.js'

// The surface's newest run by startedAt — its dir is where PLUGIN-BRIEF.md lands.
const newestRunId = (input: KickstartInput): string => {
  const sorted = [...input.runs].sort((a, b) => (a.manifest.startedAt ?? '').localeCompare(b.manifest.startedAt ?? ''))

  return sorted.at(-1)?.manifest.runId ?? input.runs[0]?.manifest.runId ?? ''
}

// Pure orchestrator: recording + detected profile → the three artifacts (pre-filled main.ts, its test, the
// brief) + the clipboard prompt. Returns strings only; the IPC layer does all disk/clipboard writes.
export const kickstart = (input: KickstartInput): KickstartResult => {
  const capabilities = resolveEvidence(planCapabilities(input.profile), input.runs, input.runsRoot)
  const briefRunId = newestRunId(input)
  const briefPath = join(input.runsRoot, briefRunId, 'PLUGIN-BRIEF.md')
  const pluginPath = join(input.repoRoot, 'plugins', input.id, 'main.ts')
  const paths = { briefPath, pluginPath }

  return {
    mainTs: generateMainTs(input, capabilities),
    testTs: generateTestTs(input, capabilities),
    brief: generateBrief(input, capabilities, paths),
    prompt: generatePrompt(input, paths),
    capabilities,
    briefRunId
  }
}

export { planCapabilities } from './capabilities.js'
export { resolveEvidence } from './evidence.js'
export { suggestIdentity } from './id.js'
export type { KickstartInput, KickstartResult, PlannedCapability } from './types.js'

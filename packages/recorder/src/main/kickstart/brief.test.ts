import { expect, test } from 'vitest'

import type { DomainProfile, EndpointHint, RunData } from '../../detect/types.js'

import { generateBrief, generatePrompt } from './brief.js'
import { planCapabilities } from './capabilities.js'
import { resolveEvidence } from './evidence.js'
import type { KickstartInput } from './types.js'

const run: RunData = {
  manifest: {
    runId: '2026-06-23_17h59_acme',
    label: '',
    startUrl: 'https://acme.com',
    partition: '',
    captureAll: false,
    startedAt: '2026-06-23T17:59:00.000Z',
    endedAt: '',
    requestCount: 1,
    navigationCount: 0
  },
  navigation: [],
  requests: [
    {
      index: 1,
      timestamp: '',
      type: 'XHR',
      request: { url: 'https://acme.com/invoices', method: 'GET', headers: {}, body: null },
      response: { status: 200, headers: {}, body: '', base64Encoded: false, mimeType: 'application/json' },
      timing: { requestSentMs: 0, responseReceivedMs: 1 }
    }
  ]
}

const hint = (category: EndpointHint['category'], url: string): EndpointHint => ({
  category,
  method: 'GET',
  url,
  host: new URL(url).host
})

const profile: DomainProfile = {
  surface: 'acme.com',
  runCount: 1,
  auth: { value: 'cookie', confidence: 'high', evidence: ['session cookie alone'] },
  authAlternatives: ['bearer-token'],
  transport: { value: { engine: 'node', requiresBrowserEngine: false }, confidence: 'high', evidence: [] },
  render: [{ host: 'acme.com', shape: 'json', sampleUrls: [] }],
  login: { value: 'password', confidence: 'medium', evidence: [] },
  endpoints: [hint('invoices', 'https://acme.com/invoices')],
  clearBeforeCapture: { value: [], confidence: 'low', evidence: [] },
  conflicts: []
}

const input: KickstartInput = {
  surface: 'acme.com',
  id: 'acme',
  name: 'Acme',
  vendor: 'Acme',
  profile,
  runs: [run],
  repoRoot: '/repo',
  runsRoot: '/runs'
}

const paths = { briefPath: '/runs/2026-06-23_17h59_acme/PLUGIN-BRIEF.md', pluginPath: '/repo/plugins/acme/main.ts' }

test('brief lists capabilities, evidence, profile, recording, and guardrails', () => {
  const caps = resolveEvidence(planCapabilities(profile), [run], '/runs')
  const brief = generateBrief(input, caps, paths)

  expect(brief).toContain('# Implement the Acme Butin plugin')
  expect(brief).toContain('Billing — `billing`')
  expect(brief).toMatch(/Evidence \(open for the real response shape\):/)
  expect(brief).toContain('Also seen:')
  expect(brief).toContain('bearer-token')
  expect(brief).toContain('read `AGENTS.md`')
  expect(brief).toContain('Synthetic fixtures only')
})

test('prompt points at the brief and the gate command', () => {
  const prompt = generatePrompt(input, paths)

  expect(prompt).toContain('plugins/acme/main.ts')
  expect(prompt).toContain('/runs/2026-06-23_17h59_acme/PLUGIN-BRIEF.md')
  expect(prompt).toContain('pnpm --filter @butinapp/plugins test')
})

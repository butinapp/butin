import type { AuthKind } from '@butinapp/sdk'
import { expect, test } from 'vitest'

import type { DomainProfile, EndpointHint, RunData } from '../../detect/types.js'

import { planCapabilities } from './capabilities.js'
import { resolveEvidence } from './evidence.js'
import { generateMainTs, generateTestTs } from './scaffold.js'
import type { KickstartInput } from './types.js'

const baseProfile = (over: Partial<DomainProfile> = {}): DomainProfile => ({
  surface: 'acme.com',
  runCount: 1,
  auth: { value: 'cookie', confidence: 'high', evidence: ['session cookie alone'] },
  authAlternatives: [],
  transport: { value: { engine: 'node', requiresBrowserEngine: false }, confidence: 'high', evidence: [] },
  render: [],
  login: { value: 'password', confidence: 'low', evidence: [] },
  endpoints: [],
  clearBeforeCapture: { value: [], confidence: 'low', evidence: [] },
  conflicts: [],
  ...over
})

const input = (profile: DomainProfile, runs: RunData[] = []): KickstartInput => ({
  surface: profile.surface,
  id: 'acme',
  name: 'Acme',
  vendor: 'Acme',
  profile,
  runs,
  repoRoot: '/repo',
  runsRoot: '/runs'
})

const hint = (category: EndpointHint['category'], url: string): EndpointHint => ({
  category,
  method: 'GET',
  url,
  host: new URL(url).host
})

test('fills meta + auth + a cookie session block', () => {
  const p = baseProfile()
  const main = generateMainTs(input(p), planCapabilities(p))

  expect(main).toContain("id: 'acme'")
  expect(main).toContain("auth: { kind: 'cookie' }")
  expect(main).toContain('loginUrl:')
  expect(main).toContain("cookieDomains: ['acme.com']")
  expect(main).toContain('export const acmePlugin')
})

test('injects the flagged transient cookies into clearCookiesBeforeCapture', () => {
  const p = baseProfile({ clearBeforeCapture: { value: ['workos_session'], confidence: 'high', evidence: [] } })
  const main = generateMainTs(input(p), planCapabilities(p))

  expect(main).toContain("clearCookiesBeforeCapture: ['workos_session']")
  // cookieDomains gains a trailing comma before the new field so the block stays valid.
  expect(main).toContain("cookieDomains: ['acme.com'],")
})

test('omits the session block for external auth', () => {
  const p = baseProfile({ auth: { value: 'external' as AuthKind, confidence: 'high', evidence: [] } })
  const main = generateMainTs(input(p), planCapabilities(p))

  expect(main).not.toContain('session:')
  expect(main).toContain("auth: { kind: 'external' }")
})

test('omits transport for the node default, emits it for a browser-engine requirement', () => {
  const nodeMain = generateMainTs(input(baseProfile()), planCapabilities(baseProfile()))

  expect(nodeMain).not.toContain('transport:')

  const browser = baseProfile({
    transport: { value: { engine: 'electron', requiresBrowserEngine: true }, confidence: 'high', evidence: [] }
  })
  const browserMain = generateMainTs(input(browser), planCapabilities(browser))

  expect(browserMain).toContain('requiresBrowserEngine: true')
})

test('emits one stub + evidence comment per planned capability', () => {
  const p = baseProfile({ endpoints: [hint('invoices', 'https://acme.com/invoices')] })
  const run: RunData = {
    manifest: {
      runId: 'r1',
      label: '',
      startUrl: 'https://acme.com',
      partition: '',
      captureAll: false,
      startedAt: '',
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
  const caps = resolveEvidence(planCapabilities(p), [run], '/runs')
  const main = generateMainTs(input(p, [run]), caps)

  expect(main).toContain('const collectBilling')
  expect(main).toContain('Detected endpoint: GET https://acme.com/invoices')
  expect(main).toContain('billing.result(...)')
  expect(main).toMatch(/r1[/\\]requests/)
})

test('test file asserts the descriptor is well-formed', () => {
  const p = baseProfile()
  const testTs = generateTestTs(input(p), planCapabilities(p))

  expect(testTs).toContain("expect(acmePlugin.meta.id).toBe('acme')")
})

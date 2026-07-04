import { expect, test } from 'vitest'

import type { RunData } from '../../detect/types.js'
import type { RecordedRequest } from '../recording/types.js'

import { resolveEvidence } from './evidence.js'
import type { PlannedCapability } from './types.js'

const req = (index: number, url: string, status = 200): RecordedRequest => ({
  index,
  timestamp: '',
  type: 'XHR',
  request: { url, method: 'GET', headers: {}, body: null },
  response: { status, headers: {}, body: '', base64Encoded: false, mimeType: 'application/json' },
  timing: { requestSentMs: 0, responseReceivedMs: 1 }
})

const run = (runId: string, requests: RecordedRequest[]): RunData => ({
  manifest: {
    runId,
    label: '',
    startUrl: 'https://x.com',
    partition: '',
    captureAll: false,
    startedAt: '',
    endedAt: '',
    requestCount: requests.length,
    navigationCount: 0
  },
  navigation: [],
  requests
})

const cap = (endpointUrl: string): PlannedCapability => ({
  capId: 'billing',
  label: 'Billing',
  category: 'invoices',
  preset: 'billing.result',
  endpointUrl,
  endpointMethod: 'GET',
  evidence: []
})

test('matches a request by host+path, ignoring query', () => {
  const [resolved] = resolveEvidence(
    [cap('https://x.com/invoices')],
    [run('r1', [req(1, 'https://x.com/invoices?page=2'), req(2, 'https://x.com/other')])],
    '/runs'
  )

  expect(resolved.evidence).toHaveLength(1)
  expect(resolved.evidence[0].runId).toBe('r1')
  expect(resolved.evidence[0].path).toContain('r1')
  expect(resolved.evidence[0].path).toContain('invoices')
})

test('caps evidence at 3 across runs', () => {
  const many = Array.from({ length: 5 }, (_, i) => req(i + 1, 'https://x.com/invoices'))
  const [resolved] = resolveEvidence([cap('https://x.com/invoices')], [run('r1', many)], '/runs')

  expect(resolved.evidence).toHaveLength(3)
})

test('leaves evidence empty for the status fallback (no endpoint)', () => {
  const [resolved] = resolveEvidence(
    [{ capId: 'status', label: 'Status', evidence: [] }],
    [run('r1', [req(1, 'https://x.com/anything')])],
    '/runs'
  )

  expect(resolved.evidence).toHaveLength(0)
})

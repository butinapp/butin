import { expect, test } from 'vitest'

import type { DomainProfile, EndpointHint } from '../../detect/types.js'

import { planCapabilities } from './capabilities.js'

const profileWith = (endpoints: EndpointHint[]): DomainProfile => ({
  surface: 'x.com',
  runCount: 1,
  auth: { value: 'cookie', confidence: 'high', evidence: [] },
  authAlternatives: [],
  transport: { value: { engine: 'node', requiresBrowserEngine: false }, confidence: 'high', evidence: [] },
  render: [],
  login: { value: 'password', confidence: 'low', evidence: [] },
  endpoints,
  clearBeforeCapture: { value: [], confidence: 'low', evidence: [] },
  conflicts: []
})

const hint = (category: EndpointHint['category'], url: string): EndpointHint => ({
  category,
  method: 'GET',
  url,
  host: new URL(url).host
})

test('maps hints to capabilities in canonical order with presets', () => {
  const plan = planCapabilities(
    profileWith([hint('usage', 'https://x.com/usage'), hint('invoices', 'https://x.com/invoices')])
  )

  expect(plan.map((c) => c.capId)).toEqual(['billing', 'usage'])
  expect(plan[0].preset).toBe('billing.result')
  expect(plan[0].endpointUrl).toBe('https://x.com/invoices')
})

test('dedupes multiple hints of the same category', () => {
  const plan = planCapabilities(profileWith([hint('invoices', 'https://x.com/a'), hint('invoices', 'https://x.com/b')]))

  expect(plan.filter((c) => c.capId === 'billing')).toHaveLength(1)
})

test('falls back to a single status stub when no hints', () => {
  const plan = planCapabilities(profileWith([]))

  expect(plan).toHaveLength(1)
  expect(plan[0].capId).toBe('status')
  expect(plan[0].preset).toBeUndefined()
})

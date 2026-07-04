import { expect, test } from 'vitest'

import { validateCapabilityResult } from '../data/result.js'

import { apiKeysResult } from './apikeys.js'

const sample = apiKeysResult({
  keys: [
    { id: '1', name: 'prod', masked: 'sk-…abcd', createdAt: '2026-01-02T10:00:00Z', revoked: false },
    { id: '2', masked: 'qd-…', createdAt: '2026-03-04', revoked: true }
  ]
})

test('apiKeysResult is a valid CapabilityResult with no summary', () => {
  expect(validateCapabilityResult(sample)).toEqual([])
  expect(sample.summaries).toBeUndefined()
})

test('apiKeysResult emits a single keys table with a derived status column', () => {
  expect(sample.datasets.map((d) => d.id)).toEqual(['keys'])
  const keys = sample.datasets[0]

  if (keys.shape !== 'table') {
    throw new Error('keys should be a table')
  }

  expect(keys.rows[0]).toMatchObject({ name: 'prod', status: 'active', createdAt: '2026-01-02' })
  expect(keys.rows[1]).toMatchObject({ status: 'revoked', createdAt: '2026-03-04' })
})

test('the status column is a role:status with no badges map (active/revoked auto-tone in the renderer)', () => {
  const keys = sample.datasets[0]

  if (keys.shape !== 'table') {
    throw new Error('keys should be a table')
  }

  const status = keys.columns.find((c) => c.key === 'status')

  expect(status?.role).toBe('status')
  expect(status?.badges).toBeUndefined()
})

test('apiKeysResult emits one keys table view and validates', () => {
  const r = apiKeysResult({ keys: [{ id: '1', name: 'CI', masked: '…abcd', revoked: false }] })

  expect(r.datasets.map((d) => d.id)).toEqual(['keys'])
  expect(r.views).toEqual([{ type: 'table', dataset: 'keys', title: 'API keys' }])
  expect(validateCapabilityResult(r)).toEqual([])
})

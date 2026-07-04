import { expect, test } from 'vitest'

import { resolveCurrencies } from '../data/currency.js'
import { validateCapabilityResult } from '../data/result.js'

import { usageResult } from './usage.js'

const sample = usageResult({
  periodStart: '2026-05-01',
  periodEnd: '2026-05-31',
  metrics: [
    { label: 'Errors', value: 1200, limit: 5000, cost: null },
    { label: 'Attachments', value: 3, unit: 'GB', limit: null, cost: 4.2 }
  ]
})

test('usageResult is a valid CapabilityResult', () => {
  expect(validateCapabilityResult(resolveCurrencies(sample, 'USD'))).toEqual([])
})

test('usageResult emits a usage record and a metrics table', () => {
  expect(sample.datasets.map((d) => d.id).sort()).toEqual(['metrics', 'usage'])
  const metrics = sample.datasets.find((d) => d.id === 'metrics')!

  expect(metrics.shape).toBe('table')

  if (metrics.shape !== 'table') {
    return
  }

  expect(metrics.rows).toHaveLength(2)
})

test('usageResult summarizes total on-demand spend when any metric has a cost', () => {
  expect(sample.summaries?.[0]).toMatchObject({ section: 'other', value: 4.2, role: 'money' })
})

test('usageResult omits the summary when no metric has a cost', () => {
  const r = usageResult({ metrics: [{ label: 'Errors', value: 5, cost: null }] })

  expect(r.summaries?.[0]).toBeUndefined()
  expect(validateCapabilityResult(resolveCurrencies(r, 'USD'))).toEqual([])
})

test('usageResult appends a daily timeseries and sparks the summary off it', () => {
  const r = usageResult({
    metrics: [{ label: 'Tokens', value: 100, cost: 9 }],
    daily: [
      { date: '2026-05-01', cost: 4 },
      { date: '2026-05-02', cost: 5 }
    ]
  })

  expect(validateCapabilityResult(resolveCurrencies(r, 'USD'))).toEqual([])
  expect(r.datasets.map((d) => d.id).sort()).toEqual(['daily', 'metrics', 'usage'])
  expect(r.views?.some((v) => v.type === 'timeseries' && v.dataset === 'daily')).toBe(true)
  expect(r.summaries?.[0]?.spark).toEqual({ dataset: 'daily', x: 'date', y: 'cost' })
})

test('usageResult orders sections stat:usage → timeseries:daily → table:metrics and validates', () => {
  const r = usageResult({
    metrics: [{ label: 'Tokens', value: 100, cost: 5 }],
    daily: [{ date: '2026-05-01', cost: 5 }]
  })

  expect(r.views?.map((v) => `${v.type}:${v.dataset}`)).toEqual(['stat:usage', 'timeseries:daily', 'table:metrics'])
  expect(r.summaries?.[0]?.section).toBe('other')
  expect(validateCapabilityResult(resolveCurrencies(r, 'USD'))).toEqual([])
})

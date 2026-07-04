import type { DailyPoint } from '@butinapp/shapes'
import { describe, expect, test } from 'vitest'

import type { AlertConfigDto } from '../../shared/ipc.js'

import { evaluateChangeAlerts } from './change-alerts.js'

const now = new Date(Date.UTC(2026, 5, 16)) // June 16 2026
const rules: AlertConfigDto['change'] = { dod: {}, wow: {}, mom: { spend: 20, usage: 40 } }
const months = (a: number, b: number): DailyPoint[] => [
  { date: '2026-04-15', value: a },
  { date: '2026-05-15', value: b }
]

describe('evaluateChangeAlerts', () => {
  test('fires when the MoM change meets the threshold (both directions), with structured fields', () => {
    const series = [{ pluginId: 'stripe', facet: 'spend' as const, currency: 'USD', daily: months(100, 130) }]
    const out = evaluateChangeAlerts(series, rules, now)

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      id: 'change:stripe:spend:mom:2026-05',
      kind: 'change',
      pluginId: 'stripe',
      facet: 'spend',
      window: 'mom',
      previous: 100,
      current: 130,
      currency: 'USD'
    })
    expect(out[0]!.pct).toBeCloseTo(0.3, 5)
  })

  test('does not fire below threshold', () => {
    const series = [{ pluginId: 'stripe', facet: 'spend' as const, currency: 'USD', daily: months(100, 110) }]

    expect(evaluateChangeAlerts(series, rules, now)).toEqual([])
  })

  test('a facet with no configured threshold is skipped', () => {
    const series = [{ pluginId: 'claude', facet: 'usage' as const, currency: 'USD', daily: months(10, 100) }]
    const onlySpend: AlertConfigDto['change'] = { dod: {}, wow: {}, mom: { spend: 20 } }

    expect(evaluateChangeAlerts(series, onlySpend, now)).toEqual([])
  })

  test('prev=0 & curr>0 emits a "new spend" notice (no pct)', () => {
    const series = [{ pluginId: 'stripe', facet: 'spend' as const, currency: 'USD', daily: months(0, 50) }]
    const out = evaluateChangeAlerts(series, rules, now)

    expect(out[0]).toMatchObject({ current: 50, previous: 0 })
    expect(out[0]!.pct).toBeUndefined()
  })

  test('insufficient history is silent', () => {
    const series = [
      { pluginId: 'stripe', facet: 'spend' as const, currency: 'USD', daily: [{ date: '2026-05-15', value: 5 }] }
    ]

    expect(evaluateChangeAlerts(series, rules, now)).toEqual([])
  })
})

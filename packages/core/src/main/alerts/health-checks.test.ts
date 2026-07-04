import { describe, expect, test } from 'vitest'

import type { OverviewTileDto } from '../../shared/ipc.js'

import { evaluateHealthChecks } from './health-checks.js'

const tile = (over: Partial<OverviewTileDto>): OverviewTileDto => ({
  pluginId: 'claude',
  name: 'Claude',
  state: 'connected',
  currency: 'CAD',
  summaries: [{ section: 'spend', label: 'MTD', value: 100, role: 'money', currency: 'CAD' }],
  ...over
})

describe('evaluateHealthChecks', () => {
  test('flags a connected spend service whose currency has no rate to base', () => {
    const out = evaluateHealthChecks([tile({})], { baseCurrency: 'USD', rates: {} })

    expect(out).toEqual([
      { id: 'health:fx:claude', kind: 'health', severity: 'warning', pluginId: 'claude', currency: 'CAD' }
    ])
  })

  test('silent when a rate exists', () => {
    expect(evaluateHealthChecks([tile({})], { baseCurrency: 'USD', rates: { CAD: 0.73 } })).toEqual([])
  })

  test('silent when the currency is the base', () => {
    expect(evaluateHealthChecks([tile({ currency: 'USD' })], { baseCurrency: 'USD', rates: {} })).toEqual([])
  })

  test('ignores disconnected tiles and tiles with no spend/other money summary', () => {
    const disc = tile({ state: 'disconnected' })
    const activity = tile({
      pluginId: 'x',
      summaries: [{ section: 'other', label: 'n', value: 3, role: 'count' }]
    })

    expect(evaluateHealthChecks([disc, activity], { baseCurrency: 'USD', rates: {} })).toEqual([])
  })
})

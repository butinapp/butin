import { type Summary } from '@butinapp/sdk/data'
import type { FxRates } from '@butinapp/sdk/util'
import { expect, test } from 'vitest'

import { rollup, type RollupTile } from './rollup.js'

const tile = (pluginId: string, summaries: Summary[]): RollupTile => ({
  pluginId,
  pluginName: pluginId,
  summary: summaries[0],
  summaries
})

// CHF intentionally absent, to exercise the missing-rate path.
const rates: FxRates = { CAD: 0.73 }

test('rollup sums only spend summaries across services', () => {
  const { bands } = rollup(
    [
      tile('a', [{ section: 'spend', label: 'x', value: 10, role: 'money', currency: 'USD' }]),
      tile('b', [{ section: 'spend', label: 'y', value: 5, role: 'money', currency: 'USD' }]),
      tile('c', [{ section: 'balance', label: 'bal', value: 999, role: 'money', currency: 'USD' }]),
      tile('d', [{ section: 'other', label: 'repos', value: 7, role: 'count' }])
    ],
    'USD',
    rates
  )

  expect(bands).toHaveLength(1)
  expect(bands[0].section).toBe('spend')
  expect(bands[0].value).toBe(15)
  expect(bands[0].contributors).toBe(2)
})

test('rollup returns no band when no service reports spend', () => {
  const { bands } = rollup(
    [
      tile('a', [{ section: 'balance', label: 'bal', value: 5, role: 'money', currency: 'USD' }]),
      tile('b', [{ section: 'other', label: 'repos', value: 7, role: 'count' }])
    ],
    'USD',
    rates
  )

  expect(bands).toEqual([])
})

test('rollup rounds money totals to cents (no float drift)', () => {
  const { bands } = rollup(
    [
      tile('a', [{ section: 'spend', label: 'x', value: 0.1, role: 'money', currency: 'USD' }]),
      tile('b', [{ section: 'spend', label: 'y', value: 0.2, role: 'money', currency: 'USD' }])
    ],
    'USD',
    rates
  )

  expect(bands[0].value).toBe(0.3)
})

test('rollup skips tiles with no summaries', () => {
  const { bands } = rollup(
    [
      tile('a', [{ section: 'spend', label: 'x', value: 10, role: 'money', currency: 'USD' }]),
      { pluginId: 'b', pluginName: 'B' }
    ],
    'USD',
    rates
  )

  expect(bands).toHaveLength(1)
  expect(bands[0].value).toBe(10)
})

test('rollup converts each contributor to the base currency before summing', () => {
  const { bands } = rollup(
    [
      tile('a', [{ section: 'spend', label: 'MTD', value: 100, role: 'money', currency: 'USD' }]),
      tile('b', [{ section: 'spend', label: 'MTD', value: 100, role: 'money', currency: 'CAD' }])
    ],
    'USD',
    rates
  )

  expect(bands[0].currency).toBe('USD')
  expect(bands[0].value).toBeCloseTo(173) // 100 USD + 100 CAD * 0.73
})

test('rollup keeps the per-currency breakdown + unconverted count', () => {
  const { bands } = rollup(
    [
      tile('a', [{ section: 'spend', label: 'x', value: 10, role: 'money', currency: 'USD' }]),
      tile('b', [{ section: 'spend', label: 'y', value: 20, role: 'money', currency: 'CAD' }]),
      tile('c', [{ section: 'spend', label: 'z', value: 50, role: 'money', currency: 'CHF' }])
    ],
    'USD',
    {} // no CAD/CHF rate
  )

  expect(bands[0].breakdown).toEqual(
    expect.arrayContaining([
      { currency: 'USD', value: 10, contributors: 1 },
      { currency: 'CAD', value: 20, contributors: 1 },
      { currency: 'CHF', value: 50, contributors: 1 }
    ])
  )
  expect(bands[0].unconverted).toBe(2)
  expect(bands[0].value).toBe(10)
})

test('rollup records the set of bases contributing to the spend band', () => {
  const { bands } = rollup(
    [
      tile('a', [{ section: 'spend', label: 'x', value: 10, role: 'money', currency: 'USD', basis: 'accrued' }]),
      tile('b', [{ section: 'spend', label: 'y', value: 20, role: 'money', currency: 'USD', basis: 'flat' }])
    ],
    'USD',
    rates
  )

  expect(bands[0].value).toBe(30)
  expect([...(bands[0].bases ?? [])].sort()).toEqual(['accrued', 'flat'])
})

test('rollup reads the spend summary off a multi-section tile, ignoring its balance/other', () => {
  const { bands } = rollup(
    [
      {
        pluginId: 'billing-service',
        pluginName: 'Billing Service',
        summary: { section: 'spend', label: 'MTD', value: 100, role: 'money', currency: 'USD' },
        summaries: [
          { section: 'spend', label: 'MTD', value: 100, role: 'money', currency: 'USD' },
          { section: 'balance', label: 'Balance', value: 50, role: 'money', currency: 'USD' }
        ]
      }
    ],
    'USD',
    rates
  )

  expect(bands).toHaveLength(1)
  expect(bands[0]).toMatchObject({ section: 'spend', value: 100, contributors: 1 })
})

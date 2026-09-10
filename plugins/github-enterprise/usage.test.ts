import { resultValidator } from '@butinapp/sdk/testing'
import { expect, test } from 'vitest'

import { buildGithubUsage, type ProductNetUsage, type RawUsageTotal } from './usage.js'

const validateCapabilityResult = resultValidator('USD')

// Net-usage shapes (amounts already in dollars). Actions has the biggest gross but runs ~100% enterprise
// discount (net 0); Copilot is billed in full (net = gross).
const perProduct: ProductNetUsage[] = [
  {
    slug: 'actions',
    label: 'Actions',
    raw: {
      usage: [
        {
          grossAmount: 150.24,
          netAmount: 0,
          discountAmount: 150.24,
          sku: 'actions_linux',
          friendlySkuName: 'Actions Linux',
          quantity: 2540,
          unitType: 'Minutes',
          usageAt: '2026-06-01T00:07:15.211Z'
        },
        {
          grossAmount: 3.35,
          netAmount: 0,
          discountAmount: 3.35,
          sku: 'actions_windows',
          friendlySkuName: 'Actions Windows',
          quantity: 335,
          unitType: 'Minutes',
          usageAt: '2026-06-02T14:38:37.962Z'
        }
      ]
    }
  },
  {
    slug: 'copilot',
    label: 'Copilot',
    raw: {
      usage: [
        {
          grossAmount: 19,
          netAmount: 19,
          discountAmount: 0,
          friendlySkuName: 'Copilot Enterprise',
          usageAt: '2026-06-01T10:00:00Z'
        },
        {
          grossAmount: 1,
          netAmount: 1,
          discountAmount: 0,
          friendlySkuName: 'Copilot Enterprise',
          usageAt: '2026-06-02T10:00:00Z'
        }
      ]
    }
  },
  { slug: 'codespaces', label: 'Codespaces', raw: { usage: [] } } // no usage → dropped
]

const tableById = (result: ReturnType<typeof buildGithubUsage>, id: string) => {
  const ds = result.datasets.find((d) => d.id === id)!

  if (ds.shape !== 'table') {
    throw new Error(`${id} should be a table`)
  }

  return ds
}

test('aggregates per product, drops empty products, sorts by gross desc, summarizes SKUs', () => {
  const products = tableById(buildGithubUsage({}, perProduct), 'products')

  expect(products.rows.map((r) => r.product)).toEqual(['Actions', 'Copilot'])
  expect(products.rows[0]).toMatchObject({ product: 'Actions', gross: 153.59, discount: 153.59, net: 0 })
  // SKUs sorted by gross desc, names joined; Copilot's repeated SKU de-duped to one name.
  expect(products.rows[0].skus).toBe('Actions Linux · Actions Windows')
  expect(products.rows[1].skus).toBe('Copilot Enterprise')
  // One row per product, keyed by the product name so it accumulates in the ledger.
  expect(products.key).toBe('product')
})

test('usage record totals gross/discount/net + product count; headlines net as usage.primary', () => {
  const result = buildGithubUsage({}, perProduct)
  const usage = result.datasets.find((d) => d.id === 'usage')!

  if (usage.shape !== 'record') {
    throw new Error('usage should be a record')
  }

  expect(usage.value).toMatchObject({ gross: 173.59, discount: 153.59, net: 20, products: 2 })
  expect(result.summaries?.[0]).toMatchObject({ section: 'other', value: 20, role: 'money' })
  expect(validateCapabilityResult(result)).toEqual([])
})

test('authoritative usage/total gross wins over the summed per-product gross', () => {
  const total: RawUsageTotal = { usage: { totalGrossAmount: 167.758860223 } }
  const usage = buildGithubUsage(total, perProduct).datasets.find((d) => d.id === 'usage')!

  if (usage.shape !== 'record') {
    throw new Error('usage should be a record')
  }

  expect(usage.value.gross).toBe(167.76)
})

test('folds rows into a per-day gross/net/discount trend, sorted ascending', () => {
  const result = buildGithubUsage({}, perProduct)
  const daily = tableById(result, 'daily')

  expect(daily.rows.map((r) => r.date)).toEqual(['2026-06-01', '2026-06-02'])
  // 2026-06-01: Actions 150.24 (net 0) + Copilot 19 (net 19) → gross 169.24, net 19, discount 150.24
  expect(daily.rows[0]).toMatchObject({ date: '2026-06-01', gross: 169.24, net: 19, discount: 150.24 })
  expect(daily.rows[1]).toMatchObject({ date: '2026-06-02', gross: 4.35, net: 1, discount: 3.35 })
  // One row per day, keyed by the ISO day so each day accumulates in the ledger.
  expect(daily.key).toBe('date')
  // A timeseries view binds the daily trend (net over date), declared at daily cadence.
  expect(result.views).toContainEqual({
    type: 'timeseries',
    dataset: 'daily',
    x: 'date',
    y: 'net',
    granularity: 'daily',
    title: 'Daily net usage'
  })
})

test('no usage anywhere → valid result, no summary, no daily views', () => {
  const result = buildGithubUsage({}, [{ slug: 'actions', label: 'Actions', raw: { usage: [] } }])

  expect(result.summaries).toBeUndefined()
  expect(result.views!.some((v) => v.type === 'timeseries')).toBe(false)
  expect(validateCapabilityResult(result)).toEqual([])
})

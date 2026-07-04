import { type Summary } from '@butinapp/sdk/data'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest'

import { countItems, monthlySeriesOf, pickPrimarySummary, summariesFrom } from './overview.js'

// One installed, connected billing plugin for the buildOverview integration test. Hoisted so the vi.mock
// factories (themselves hoisted above imports) can reference it.
const { billingPlugin } = vi.hoisted(() => ({
  billingPlugin: {
    meta: { id: 'fake', name: 'Fake', color: '#123456' },
    reportingCurrency: 'USD',
    auth: { kind: 'cookie' },
    capabilities: [{ id: 'billing', label: 'Billing' }]
  }
}))

vi.mock('../plugin/plugins.js', () => ({ plugins: [billingPlugin] }))
vi.mock('./config-file.js', () => ({ getPluginInstalled: () => true }))
vi.mock('../plugin/connection.js', () => ({ isPluginConnected: () => true }))

const spend: Summary = { section: 'spend', label: 'MTD', value: 42, role: 'money' }
const usage: Summary = { section: 'other', label: 'Usage', value: 9, role: 'money' }

// A `current`-cache `data` payload (the stored data-first shape): datasets + summaries + manifest. The
// manifest carries the summary label/spark, so summariesFrom reattaches them on reconstruction.
const storedData = (summaries: { section: string; value: number; role?: string }[], manifestSummaries = {}) => ({
  datasets: [],
  summaries,
  manifest: { views: [], summaries: manifestSummaries }
})

test('summariesFrom reconstructs the summaries from a stored payload', () => {
  const data = storedData([{ section: 'spend', value: 42, role: 'money' }], { spend: { label: 'MTD' } })

  expect(summariesFrom(data)).toEqual([{ section: 'spend', label: 'MTD', value: 42, role: 'money' }])
})

test('summariesFrom returns [] for non-conforming payloads / no summaries', () => {
  expect(summariesFrom(storedData([]))).toEqual([])
  expect(summariesFrom({ datasets: [] })).toEqual([])
  expect(summariesFrom(null)).toEqual([])
  expect(summariesFrom('nope')).toEqual([])
})

test('pickPrimarySummary prefers spend, then balance, then other', () => {
  const balance: Summary = { section: 'balance', label: 'b', value: 2, role: 'money', currency: 'USD' }

  expect(pickPrimarySummary([{ summary: usage }, { summary: balance }, { summary: spend }])?.section).toBe('spend')
  expect(pickPrimarySummary([{ summary: usage }, { summary: balance }])?.section).toBe('balance')
})

test('pickPrimarySummary falls back to the first summary when there is no spend or balance', () => {
  expect(pickPrimarySummary([{ summary: usage }])).toBe(usage)
})

test('pickPrimarySummary honors an explicit headline override', () => {
  const headlined: Summary = { section: 'other', label: 'o', value: 1, role: 'count', headline: true }

  expect(pickPrimarySummary([{ summary: spend }, { summary: headlined }])?.section).toBe('other')
})

test('pickPrimarySummary returns undefined when nothing has a summary', () => {
  expect(pickPrimarySummary([{ summary: undefined }])).toBeUndefined()
})

describe('monthlySeriesOf', () => {
  const data = {
    datasets: [
      {
        id: 'monthly',
        shape: 'table',
        columns: [
          { key: 'month', label: 'Month', role: 'timestamp' },
          { key: 'amount', label: 'Spend', role: 'money' }
        ],
        rows: [
          { month: '2026-04', amount: 10 },
          { month: '2026-05', amount: 20.5 }
        ]
      }
    ]
  }

  it('extracts the monthly series via the chosen summary spark', () => {
    const summary: Summary = {
      section: 'spend',
      label: 'This month',
      value: 5,
      role: 'money',
      spark: { dataset: 'monthly', x: 'month', y: 'amount' }
    }

    expect(monthlySeriesOf(data, summary)).toEqual([
      { month: '2026-04', amount: 10 },
      { month: '2026-05', amount: 20.5 }
    ])
  })

  it('returns [] with no summary, no spark, or no matching dataset', () => {
    expect(monthlySeriesOf(data, undefined)).toEqual([])
    expect(monthlySeriesOf({ datasets: [] }, undefined)).toEqual([])
    expect(monthlySeriesOf(null, undefined)).toEqual([])
    expect(
      monthlySeriesOf(
        { datasets: [] },
        { section: 'spend', label: 'x', value: 0, role: 'money', spark: { dataset: 'x', x: 'a', y: 'b' } }
      )
    ).toEqual([])
  })
})

describe('countItems', () => {
  it('sums table rows and counts each record dataset as one', () => {
    const data = {
      datasets: [
        { id: 't1', shape: 'table', columns: [], rows: [{}, {}, {}] },
        { id: 'r1', shape: 'record', fields: [], value: {} },
        { id: 't2', shape: 'table', columns: [], rows: [{}] }
      ]
    }

    expect(countItems(data)).toBe(5)
  })

  it('returns 0 for non-conforming payloads', () => {
    expect(countItems(null)).toBe(0)
    expect(countItems({ foo: 'bar' })).toBe(0)
    expect(countItems({ datasets: 'nope' })).toBe(0)
  })
})

// buildOverview: real IO over a temp data root with a mocked plugin registry. Asserts a capability cache with
// two summaries (incl. a spend facet) produces a tile with the primary summary + monthly spark + daily series.
describe('buildOverview', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'butin-overview-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('builds a tile with the primary summary, monthly spark, and daily series from current + ledger', async () => {
    const { setDataRoot, saveCurrent } = await import('./store.js')
    const { accumulate } = await import('./ledger.js')
    const { buildOverview } = await import('./overview.js')

    setDataRoot(dir)

    // Two summaries: usage first (declared) + spend; the spend section must drive the tile's primary metric and
    // its spark points at the `monthly` table.
    await saveCurrent('fake', 'billing', {
      datasets: [
        {
          id: 'monthly',
          shape: 'table',
          columns: [
            { key: 'month', role: 'timestamp' },
            { key: 'amount', role: 'money', currency: 'USD' }
          ],
          rows: [
            { month: '2026-04', amount: 10 },
            { month: '2026-05', amount: 25 }
          ]
        }
      ],
      summaries: [
        { section: 'other', value: 9, role: 'count' },
        { section: 'spend', value: 25, role: 'money', currency: 'USD' }
      ],
      manifest: {
        views: [],
        summaries: { spend: { label: 'MTD', spark: { dataset: 'monthly', x: 'month', y: 'amount' } } }
      }
    })

    // Two days of spend readings → a daily series with one differenced day.
    await accumulate('fake', 'billing', {
      capturedAt: '2026-05-13T00:00:00Z',
      datasets: [],
      summaries: [{ section: 'spend', value: 18, role: 'money', currency: 'USD' }]
    })
    await accumulate('fake', 'billing', {
      capturedAt: '2026-05-14T00:00:00Z',
      datasets: [],
      summaries: [{ section: 'spend', value: 25, role: 'money', currency: 'USD' }]
    })

    const tiles = await buildOverview()

    expect(tiles).toHaveLength(1)
    expect(tiles[0]!.summary?.section).toBe('spend')
    expect(tiles[0]!.monthly).toEqual([
      { month: '2026-04', amount: 10 },
      { month: '2026-05', amount: 25 }
    ])
    expect(tiles[0]!.daily).toEqual([{ date: '2026-05-14', value: 7 }])
  })

  it('reports the tile currency as the primary summary currency, not the static reportingCurrency', async () => {
    const { setDataRoot, saveCurrent } = await import('./store.js')
    const { buildOverview } = await import('./overview.js')

    setDataRoot(dir)

    // The plugin declares reportingCurrency 'USD' but bills in CAD (its spend summary's currency). The tile
    // must carry CAD so the FX pane surfaces a CAD rate row and the Overview converts the value instead of
    // mis-treating it as USD (→ a 0 MTD when there's no CAD rate).
    await saveCurrent('fake', 'billing', {
      datasets: [],
      summaries: [{ section: 'spend', value: 100, role: 'money', currency: 'CAD' }],
      manifest: { views: [], summaries: { spend: { label: 'MTD' } } }
    })

    const tiles = await buildOverview()

    expect(tiles[0]!.currency).toBe('CAD')
  })
})

import { resolveCurrencies } from '@butinapp/sdk/data'
import { validateSamples } from '@butinapp/sdk/testing'
import { describe, expect, test } from 'vitest'

import {
  buildFireworksBillingResult,
  buildFireworksReport,
  buildFireworksSummaryResult,
  extractInvoiceRows,
  fireworksPlugin
} from './main.js'

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(fireworksPlugin)).toEqual([])
})

// A trimmed, SYNTHETIC RSC flight payload in the billing-page shape: the `invoiceRows` array
// is embedded mid-stream with RSC-escaped `$$` dollar amounts and a trailing object/array AFTER the array (so
// the balance-scan must stop at the array's own closing bracket, not run to the end of the stream). All ids,
// amounts, tokens, and dates are invented.
const flight = `1:["$","$L0",null,{}]
9:[null,["$","$L4",null,{"invoiceRows":[{"id":"INV0001sample","amount":"$$13.04","invoiceUrl":"https://invoices.withorb.com/view?token=AAA","status":"Upcoming","targetTimeMs":1782864000000,"type":1},{"id":"INV0002sample","amount":"$$52.98","invoiceUrl":"https://invoices.withorb.com/view?token=BBB","status":"Success","targetTimeMs":1780272000000,"type":1},{"id":"INV0003sample","amount":"$$1,088.95","invoiceUrl":"https://invoices.withorb.com/view?token=CCC","status":"Success","targetTimeMs":1777593600000,"type":1}],"trailingProp":true}]]
10:["done"]`

describe('extractInvoiceRows', () => {
  test('balance-scans the invoiceRows array out of the RSC flight, stopping at the array end', () => {
    const rows = extractInvoiceRows(flight)

    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ id: 'INV0001sample', amount: '$$13.04', status: 'Upcoming' })
    // The trailing object after the array must NOT have been swept in.
    expect(rows.every((r) => typeof r.id === 'string')).toBe(true)
  })

  test('returns [] when the marker is absent', () => {
    expect(extractInvoiceRows('no invoices in this stream')).toEqual([])
  })

  test('returns [] when the array slice is malformed/unparseable', () => {
    // Marker + an opening bracket that closes (balanced) but holds invalid JSON → JSON.parse throws → [].
    expect(extractInvoiceRows('"invoiceRows":[not, valid, json]')).toEqual([])
  })

  test('returns [] on an empty string', () => {
    expect(extractInvoiceRows('')).toEqual([])
  })
})

describe('buildFireworksReport', () => {
  test('normalizes RSC $$ → dollars, parses dates from epoch ms, sorts newest-first', () => {
    const report = buildFireworksReport(extractInvoiceRows(flight))

    expect(report.invoices[0]).toEqual({
      id: 'INV0001sample',
      date: '2026-07-01',
      amount: 13.04,
      status: 'Upcoming',
      hostedUrl: 'https://invoices.withorb.com/view?token=AAA'
    })
    expect(report.invoices.map((i) => i.date)).toEqual(['2026-07-01', '2026-06-01', '2026-05-01'])
    // Comma-grouped amount parsed to a dollar number.
    expect(report.invoices[2].amount).toBeCloseTo(1088.95, 2)
  })

  test('totalBilled sums only non-upcoming invoices; upcoming amount + MTD surfaced separately', () => {
    const report = buildFireworksReport(extractInvoiceRows(flight))

    expect(report.totalBilled).toBeCloseTo(1141.93, 2) // 52.98 + 1088.95 (excludes 13.04 upcoming)
    expect(report.upcomingAmount).toBeCloseTo(13.04, 2)
    expect(report.currentMtd).toBeCloseTo(13.04, 2) // the in-progress (upcoming) invoice = live MTD
  })

  test('tolerates empty / null / undefined input', () => {
    for (const input of [[], null, undefined]) {
      const report = buildFireworksReport(input)

      expect(report.invoices).toEqual([])
      expect(report.totalBilled).toBe(0)
      expect(report.upcomingAmount).toBeNull()
      expect(report.currentMtd).toBeNull()
    }
  })

  test('currentMtd is null when there is no upcoming invoice', () => {
    const report = buildFireworksReport([{ id: 'x', amount: '$$5.00', status: 'Success', targetTimeMs: 1780272000000 }])

    expect(report.currentMtd).toBeNull()
    expect(report.upcomingAmount).toBeNull()
    expect(report.totalBilled).toBeCloseTo(5, 2)
  })
})

describe('buildFireworksSummaryResult', () => {
  test('emits a spend.mtd summary (money, USD) only when there is an upcoming invoice', () => {
    const result = resolveCurrencies(buildFireworksSummaryResult(extractInvoiceRows(flight)), 'USD')

    expect(result.summaries?.[0]?.section).toBe('spend')
    expect(result.summaries?.[0]?.basis).toBe('upcoming')
    expect(result.summaries?.[0]?.role).toBe('money')
    expect(result.summaries?.[0]?.currency).toBe('USD')
    expect(result.summaries?.[0]?.value).toBeCloseTo(13.04, 2)
  })

  test('omits the spend.mtd summary when there is no upcoming (no live MTD)', () => {
    const result = buildFireworksSummaryResult([
      { id: 'x', amount: '$$5.00', status: 'Success', targetTimeMs: 1780272000000 }
    ])

    expect(result.summaries).toBeUndefined()
  })

  test('carries the account record + monthly-spend timeseries (discriminated by shape)', () => {
    const result = buildFireworksSummaryResult(extractInvoiceRows(flight))
    const account = result.datasets.find((d) => d.id === 'account')
    const monthly = result.datasets.find((d) => d.id === 'monthly')

    expect(account?.shape).toBe('record')
    expect(monthly?.shape).toBe('table')
    // Three distinct billing months in the fixture → three monthly buckets.
    expect(monthly?.shape === 'table' && monthly.rows).toHaveLength(3)
  })
})

describe('buildFireworksBillingResult', () => {
  test('builds an invoices table with date/amount/status + a url column to the Orb-hosted invoice', () => {
    const result = buildFireworksBillingResult(extractInvoiceRows(flight))
    const invoices = result.datasets.find((d) => d.id === 'invoices')

    expect(invoices?.shape).toBe('table')

    if (invoices?.shape !== 'table') {
      throw new Error('expected a table dataset')
    }

    const urlCol = invoices.columns.find((c) => c.key === 'invoiceUrl')

    expect(urlCol?.role).toBe('url')
    expect(invoices.rows).toHaveLength(3)
    expect(invoices.rows[0]).toMatchObject({
      date: '2026-07-01',
      amount: 13.04,
      status: 'Upcoming',
      invoiceUrl: 'https://invoices.withorb.com/view?token=AAA'
    })
    // The invoice id rides hidden as the accumulation key (a month can carry several invoices, so date isn't unique).
    expect(invoices.key).toBe('id')
    expect(invoices.rows[0]?.id).toBe('INV0001sample')
  })

  test('the invoices view is downloadable via the invoiceUrl column', () => {
    const result = buildFireworksBillingResult(extractInvoiceRows(flight))
    const view = result.views?.find((v) => v.type === 'table')

    expect(view?.type === 'table' && view.files?.source).toEqual({ url: 'invoiceUrl' })
  })
})

describe('fireworksPlugin descriptor', () => {
  test('is a cookie/node billing plugin with summary + billing tabs and no members', () => {
    expect(fireworksPlugin.meta.id).toBe('fireworks')
    expect(fireworksPlugin.auth.kind).toBe('cookie')
    expect(fireworksPlugin.transport?.engine).toBe('node')
    expect(fireworksPlugin.session?.cookieDomains).toEqual(['fireworks.ai'])

    const ids = fireworksPlugin.capabilities.map((c) => c.id)

    expect(ids).toEqual(['summary', 'billing'])
    expect(ids).not.toContain('members')
  })
})

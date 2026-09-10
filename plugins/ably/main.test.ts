import { resultValidator, validateSamples } from '@butinapp/sdk/testing'
import { describe, expect, it, test } from 'vitest'

import {
  ablyPlugin,
  buildAblyBilling,
  buildAblyBillingResult,
  buildAblySummaryResult,
  buildAblyUsageMetrics,
  buildAblyUsageResult,
  parseInvoiceDate,
  parseInvoices,
  parsePlanName
} from './main.js'

// Two invoice rows trimmed/synthesized to match the /accounts/<slug>/invoices HTML shape.
const invoicesHtml = `
<table class="border-separate">
  <tbody data-controller="invoice-toggle">
    <tr data-testid="invoice-row" id="invoice-68937" data-source="stripe">
      <td><svg></svg></td>
      <td><span class="text-sm">in_1TdLkYDKnBYR0Wvp2K0CDRIJ</span></td>
      <td><span class="text-sm">June 1, 2026</span></td>
      <td class="text-right"><span class="text-sm">$233.30</span></td>
      <td class="text-center"><span>Paid</span></td>
      <td></td>
      <td class="text-right"><a href="/accounts/90001/invoices/68937">View</a></td>
    </tr>
    <tr data-testid="invoice-row" id="invoice-60012" data-source="stripe">
      <td><svg></svg></td>
      <td><span class="text-sm">in_1Ta0000000000000000000</span></td>
      <td><span class="text-sm">May 1, 2026</span></td>
      <td class="text-right"><span class="text-sm">$1,204.55</span></td>
      <td class="text-center"><span>Open</span></td>
      <td></td>
      <td class="text-right"><a href="/accounts/90001/invoices/60012">View</a></td>
    </tr>
  </tbody>
</table>`

const packageHtml = `<div data-turbo-mount-props-value="{&quot;propData&quot;:{&quot;currentPackagePlanId&quot;:&quot;standard&quot;}}"></div>`

const usageHtml = `
<tr class="bold">
  <td data-js-stat="billable_messages_all_count">Messages volume</td>
  <td>1,000,000,000</td>
  <td>71,413,818</td>
  <td>17,135,770</td>
  <td>51,392,979</td>
  <td></td>
</tr>
<tr>
  <td data-js-stat="messages_published"> - Messages published (REST &amp; Realtime)</td>
  <td></td>
  <td>1,608,575</td>
  <td>706,119</td>
  <td>2,117,766</td>
  <td>On average this month each message published was delivered to 2.2 subscribers in realtime.</td>
</tr>
<tr class="bold">
  <td data-js-stat="billable_messages_all_data">Messages volume (data)</td>
  <td></td>
  <td>53 GiB</td>
  <td>12 GiB</td>
  <td>36 GiB</td>
  <td></td>
</tr>`

const validateCapabilityResult = resultValidator('USD')

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(ablyPlugin)).toEqual([])
})

describe('parseInvoiceDate', () => {
  it('converts "Month D, YYYY" to ISO without timezone drift', () => {
    expect(parseInvoiceDate('June 1, 2026')).toBe('2026-06-01')
    expect(parseInvoiceDate('December 31, 2025')).toBe('2025-12-31')
    expect(parseInvoiceDate('garbage')).toBeUndefined()
  })
})

describe('parseInvoices', () => {
  it('scrapes id/number/date/amount/status/hostedUrl from each row', () => {
    const rows = parseInvoices(invoicesHtml)

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: '68937',
      number: 'in_1TdLkYDKnBYR0Wvp2K0CDRIJ',
      date: '2026-06-01',
      amount: 233.3,
      status: 'paid',
      hostedUrl: 'https://ably.com/accounts/90001/invoices/68937'
    })
    expect(rows[1]).toMatchObject({ id: '60012', amount: 1204.55, status: 'open' })
  })
})

describe('parsePlanName', () => {
  it('extracts and capitalizes the current package plan id', () => {
    expect(parsePlanName(packageHtml)).toBe('Standard')
  })

  it('falls back to Unknown when the prop is absent', () => {
    expect(parsePlanName('<div></div>')).toBe('Unknown')
  })
})

describe('buildAblyBilling', () => {
  it('sorts newest-first, keeps dollars, and totals the trailing 12 months', () => {
    const r = buildAblyBilling(invoicesHtml, packageHtml)

    expect(r.planName).toBe('Standard')
    expect(r.invoices.map((i) => i.id)).toEqual(['68937', '60012'])
    expect(r.latestAmount).toBe(233.3)
    expect(r.trailing12moTotal).toBeCloseTo(233.3 + 1204.55, 2)
  })

  it('handles empty input', () => {
    const r = buildAblyBilling('<table></table>', '<div></div>')

    expect(r.invoices).toEqual([])
    expect(r.latestAmount).toBe(0)
    expect(r.trailing12moTotal).toBe(0)
    expect(r.planName).toBe('Unknown')
  })
})

describe('buildAblySummaryResult', () => {
  it('emits a billing result with the monthly chart and plan/latest stats', () => {
    const r = buildAblySummaryResult(buildAblyBilling(invoicesHtml, packageHtml))

    // Any summary it emits is the spend section (present only in a month with an invoice).
    expect(r.summaries == null || r.summaries[0]?.section === 'spend').toBe(true)
    expect(r.datasets.length).toBeGreaterThan(0)
    expect(r.views?.some((v) => v.type === 'timeseries')).toBe(true)
  })
})

describe('buildAblyBillingResult', () => {
  it('renders an invoices table with a url column', () => {
    const r = buildAblyBillingResult(buildAblyBilling(invoicesHtml, packageHtml))
    const invoices = r.datasets.find((d) => d.id === 'invoices')

    expect(invoices?.shape).toBe('table')
    expect(invoices?.shape === 'table' && invoices.columns.some((c) => c.role === 'url')).toBe(true)
  })

  it('keys the invoices table by id so it accumulates history in the ledger', () => {
    const r = buildAblyBillingResult(buildAblyBilling(invoicesHtml, packageHtml))
    const invoices = r.datasets.find((d) => d.id === 'invoices')

    expect(invoices?.shape === 'table' && invoices.key).toBe('id')
  })
})

describe('buildAblyUsageMetrics', () => {
  it('scrapes each stat row with the confirmed column order', () => {
    const metrics = buildAblyUsageMetrics(usageHtml)

    expect(metrics).toHaveLength(3)

    const vol = metrics.find((m) => m.key === 'billable_messages_all_count')!

    expect(vol).toMatchObject({
      label: 'Messages volume',
      isBillable: true,
      limit: '1,000,000,000',
      thisMonth: '17,135,770'
    })
    expect(vol.thisMonthValue).toBe(17135770)
  })

  it('marks rows without a limit as non-billable and parses unit-suffixed values', () => {
    const metrics = buildAblyUsageMetrics(usageHtml)
    const pub = metrics.find((m) => m.key === 'messages_published')!

    expect(pub.isBillable).toBe(false)
    expect(pub.note).toContain('2.2 subscribers')

    const data = metrics.find((m) => m.key === 'billable_messages_all_data')!

    expect(data.thisMonthValue).toBe(12)
  })

  it('handles empty input', () => {
    expect(buildAblyUsageMetrics('<table></table>')).toEqual([])
  })
})

describe('buildAblyUsageResult', () => {
  it('produces usage + detail datasets from scraped metrics', () => {
    const r = buildAblyUsageResult(buildAblyUsageMetrics(usageHtml))

    expect(r.datasets.find((d) => d.id === 'usageDetail')).toBeDefined()
    expect(r.views?.some((v) => v.type === 'table')).toBe(true)
  })

  it('keys the detail + metrics tables so usage accumulates in the ledger', () => {
    const r = buildAblyUsageResult(buildAblyUsageMetrics(usageHtml))
    const detail = r.datasets.find((d) => d.id === 'usageDetail')
    const metrics = r.datasets.find((d) => d.id === 'metrics')

    expect(detail?.shape === 'table' && detail.key).toBe('label')
    expect(metrics?.shape === 'table' && metrics.key).toBe('label')
  })
})

describe('session', () => {
  // Google sign-in is omniauth; the OAuth state rides the Rails `_ably_session` cookie, so a stale one must be
  // cleared before each capture or the callback's state check fails and login never completes.
  it('clears the omniauth state cookie before capture', () => {
    expect(ablyPlugin.session!.clearCookiesBeforeCapture).toContain('_ably_session')
  })
})

import { resultValidator, validateSamples } from '@butinapp/sdk/testing'
import { describe, expect, it, test } from 'vitest'

import {
  buildClickhouseBilling,
  buildClickhouseBillingTab,
  buildClickhouseMembers,
  buildClickhouseSummaryResult,
  buildClickhouseUsage,
  clickhousePlugin,
  pickOrganization,
  type RawAccount,
  type RawBillingDetails,
  type RawOrg,
  type RawUsageReport
} from './main.js'

const validateCapabilityResult = resultValidator('USD')

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(clickhousePlugin)).toEqual([])
})

// ── descriptor ──────────────────────────────────────────────────────────────────────────

test('clickhouse plugin is a zero-config spa-bearer session', () => {
  expect(clickhousePlugin.meta.id).toBe('clickhouse')
  expect(clickhousePlugin.auth.kind).toBe('spa-bearer')
  expect(clickhousePlugin.session?.requiredCookie).toBe('auth0')
  expect(clickhousePlugin.session?.cookieDomains).toContain('clickhouse.cloud')
  // The org is auto-discovered — the only config field is an OPTIONAL override.
  expect(clickhousePlugin.config?.fields.every((f) => f.required !== true)).toBe(true)
  expect(clickhousePlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'usage', 'members'])
})

// ── org resolution ────────────────────────────────────────────────────────────────────

describe('pickOrganization', () => {
  const account: RawAccount = {
    organizations: [
      { id: 'org-trial', name: "YA's Org", tier: 'UNSELECTED', billingStatus: 'PRE_TRIAL' },
      { id: 'org-paid', name: 'Acme', tier: 'SCALE', billingStatus: 'PAID' }
    ]
  }

  it('prefers the PAID org over an UNSELECTED pre-trial placeholder', () => {
    expect(pickOrganization(account)?.id).toBe('org-paid')
  })

  it('honors an explicit override id, falling back to the first when unmatched', () => {
    expect(pickOrganization(account, 'org-trial')?.id).toBe('org-trial')
    expect(pickOrganization(account, 'nope')?.id).toBe('org-trial')
  })

  it('falls back to a selected tier, then the first org', () => {
    expect(
      pickOrganization({
        organizations: [
          { id: 'a', tier: 'UNSELECTED' },
          { id: 'b', tier: 'SCALE' }
        ]
      })?.id
    ).toBe('b')
    expect(pickOrganization({ organizations: [{ id: 'a' }, { id: 'b' }] })?.id).toBe('a')
    expect(pickOrganization(null)).toBeUndefined()
  })
})

// ── billing ─────────────────────────────────────────────────────────────────────────────

// Console billing-details payload (amounts already in USD dollars, dates epoch ms); synthetic ids.
const billing: RawBillingDetails = {
  companyName: 'Acme',
  billingContact: 'billing@acme.test',
  nextInvoiceDate: 1783814400000, // 2026-07-11
  paymentMethod: { brand: 'mastercard', last4: '6457', expMonth: 1, expYear: 2030 },
  invoices: [
    {
      invoiceNumber: 'AC-0002',
      currency: 'USD',
      amount: 1528.81,
      status: 'paid',
      createdDate: 1781310720000, // 2026-06-12
      invoicePdfDownloadLink: 'https://pay.stripe.com/invoice/acct_X/live_Y/pdf?s=ap',
      invoicePaymentLink: 'https://invoice.stripe.com/i/acct_X/live_Y?s=ap'
    },
    { invoiceNumber: 'AC-0001', currency: 'USD', amount: 8.08, status: 'paid', createdDate: 1776039325000 } // 2026-04-13
  ],
  billUsageStatements: [
    { billNetTotal: 433.72, periodStartDate: 1781136000000, periodEndDate: 1783728000000, locked: false }, // 2026-06 open
    { billNetTotal: 1329.69, periodStartDate: 1778457600000, periodEndDate: 1781136000000, locked: true } // 2026-05
  ],
  creditBalances: [{ amountSpent: 0.09, amountRemaining: 50, amountTotal: 300, creditType: 'TRIAL' }]
}

describe('buildClickhouseBilling', () => {
  it('normalizes invoices, the per-period trend, the open-period MTD, card, and credit', () => {
    const r = buildClickhouseBilling(billing)

    expect(r.invoices[0]).toEqual({
      number: 'AC-0002',
      date: '2026-06-13',
      status: 'paid',
      amount: 1528.81,
      pdfUrl: 'https://pay.stripe.com/invoice/acct_X/live_Y/pdf?s=ap',
      hostedUrl: 'https://invoice.stripe.com/i/acct_X/live_Y?s=ap'
    })
    // byMonth ascending; the open (locked:false) period is the live MTD.
    expect(r.byMonth.map((m) => [m.month, m.amount])).toEqual([
      ['2026-05', 1329.69],
      ['2026-06', 433.72]
    ])
    expect(r.currentMtd).toBe(433.72)
    expect(r.nextInvoice).toBe('2026-07-12')
    expect(r.card).toEqual({ brand: 'mastercard', last4: '6457', exp: '1/2030' })
    expect(r.credit).toEqual({ granted: 300, used: 0.09, remaining: 50 })
    expect(r.company).toBe('Acme')
  })

  it('tolerates an empty/nullish payload (no open period → null MTD)', () => {
    const r = buildClickhouseBilling(null)

    expect(r.invoices).toEqual([])
    expect(r.byMonth).toEqual([])
    expect(r.currentMtd).toBeNull()
    expect(r.card).toBeUndefined()
    expect(r.credit).toEqual({ granted: 0, used: 0, remaining: 0 })
  })
})

describe('buildClickhouseSummaryResult', () => {
  it('is a lean overview: spend.mtd (accrued) + monthly spark + stat row, no invoice/account tables', () => {
    const result = buildClickhouseSummaryResult(buildClickhouseBilling(billing))

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.summaries?.[0]?.section).toBe('spend')
    expect(result.summaries?.[0]?.value).toBe(433.72)
    expect(result.summaries?.[0]?.basis).toBe('accrued')
    expect(result.datasets.some((d) => d.id === 'monthly')).toBe(true)
    expect(result.datasets.some((d) => d.id === 'invoices')).toBe(false)
  })

  it('omits spend.mtd when there is no open period', () => {
    const result = buildClickhouseSummaryResult(buildClickhouseBilling(null))

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.summaries).toBeUndefined()
  })
})

describe('buildClickhouseBillingTab', () => {
  it('is the detail: account record + credit + downloadable invoices, no spend.mtd', () => {
    const result = buildClickhouseBillingTab(buildClickhouseBilling(billing))

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.summaries).toBeUndefined()
    expect(result.datasets.some((d) => d.id === 'invoices')).toBe(true)

    const view = result.views?.find((v) => v.type === 'table' && v.dataset === 'invoices') as { files?: unknown }

    // The download targets the real Stripe PDF link, not the hosted page.
    expect(view.files).toMatchObject({ source: { url: 'pdfUrl' }, ext: 'pdf' })

    const invoicesDs = result.datasets.find((d) => d.id === 'invoices')

    expect(invoicesDs?.shape === 'table' && invoicesDs.key).toBe('number')
    const rows = (invoicesDs as unknown as { rows: Record<string, unknown>[] }).rows

    expect(rows[0]).toMatchObject({
      number: 'AC-0002',
      pdfUrl: 'https://pay.stripe.com/invoice/acct_X/live_Y/pdf?s=ap',
      hostedUrl: 'https://invoice.stripe.com/i/acct_X/live_Y?s=ap'
    })
  })

  it('drops the credit + invoice sections on an empty account', () => {
    const result = buildClickhouseBillingTab(buildClickhouseBilling(null))

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.datasets.some((d) => d.id === 'invoices')).toBe(false)
    expect(result.datasets.some((d) => d.id === 'credits')).toBe(false)
  })
})

// ── usage ─────────────────────────────────────────────────────────────────────────────

describe('buildClickhouseUsage', () => {
  const report: RawUsageReport = {
    report: {
      startDate: '2026-06-11',
      totalUsageReport: {
        instanceComputeUnitHours: { metricValue: 1454.4333, cost: 434.09 },
        instancePublicDataTransferGB: { metricValue: 0.0098, cost: 0.0011 },
        datawarehouseStorageTBMonthsTables: { metricValue: 6.7e-8, cost: 1.7e-6 },
        clickpipeComputeUnitHours: { metricValue: 0, cost: 0 } // dropped (zero on both)
      }
    }
  }

  it('maps curated metrics with units + cost, dropping all-zero metrics', () => {
    const metrics = buildClickhouseUsage(report)

    expect(metrics.map((m) => m.label)).toEqual(['Compute', 'Storage — tables', 'Data transfer — public'])
    expect(metrics[0]).toEqual({ label: 'Compute', value: 1454.4333, unit: 'CU·h', cost: 434.09 })
    // sub-cent cost rounds to 0 but the metric is kept (non-zero metricValue).
    expect(metrics.find((m) => m.label === 'Data transfer — public')?.cost).toBe(0)
  })

  it('returns no metrics on an empty report', () => {
    expect(buildClickhouseUsage(null)).toEqual([])
    expect(buildClickhouseUsage({ report: { totalUsageReport: {} } })).toEqual([])
  })
})

// ── members ─────────────────────────────────────────────────────────────────────────────

describe('buildClickhouseMembers', () => {
  const org: RawOrg = {
    id: 'org-1',
    users: {
      Google_1: { userId: 'Google_1', name: 'Ada Lovelace', email: 'ada@acme.test', role: 'ADMIN' },
      Google_2: { userId: 'Google_2', name: 'Bo Diddley', email: 'bo@acme.test', role: 'DEVELOPER' }
    }
  }

  it('maps the keyed user roster to MemberInput', () => {
    expect(buildClickhouseMembers(org).members).toEqual([
      { id: 'Google_1', name: 'Ada Lovelace', email: 'ada@acme.test', role: 'ADMIN' },
      { id: 'Google_2', name: 'Bo Diddley', email: 'bo@acme.test', role: 'DEVELOPER' }
    ])
  })

  it('returns an empty roster on a user-less / nullish org', () => {
    expect(buildClickhouseMembers({ id: 'x' }).members).toEqual([])
    expect(buildClickhouseMembers(null).members).toEqual([])
  })
})

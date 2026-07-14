import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import type { RawStripeInvoiceList } from '@butinapp/sdk/integrations'
import { describe, expect, it, test } from 'vitest'

import {
  buildBillingReport,
  buildPosthogBillingTab,
  buildPosthogMembers,
  buildPosthogSummaryResult,
  buildPosthogUsageResult,
  buildUsageReport,
  normalizeTimeseries,
  posthogPlugin,
  type RawBilling,
  type RawBreakdowns,
  type RawMembersList,
  usd
} from './main.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of posthogPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

// Synthetic fixtures with invented values. `*_usd` fields are USD dollar STRINGS (PostHog's billing
// payload), Stripe-portal invoices are CENTS + unix seconds.
const billing: RawBilling = {
  billing_plan: 'boost',
  subscription_level: 'paid',
  has_active_subscription: true,
  is_annual_plan_customer: false,
  billing_period: {
    current_period_start: '2026-06-10T18:08:21Z',
    current_period_end: '2026-07-10T18:08:21Z',
    interval: 'month'
  },
  current_total_amount_usd: '180.00',
  current_total_amount_usd_after_discount: '180.00',
  projected_total_amount_usd: '2750.50',
  projected_total_amount_usd_after_discount: '2750.50',
  discount_percent: null,
  discount_amount_usd: null,
  products: [
    {
      type: 'product_analytics',
      name: 'Product analytics',
      subscribed: true,
      current_amount_usd: '0.00',
      projected_amount_usd: '2400.00',
      current_usage: 12000,
      usage_limit: null,
      projected_usage: 60000,
      percentage_usage: 0,
      has_exceeded_limit: false,
      unit: 'event'
    },
    {
      type: 'session_replay',
      name: 'Session replay',
      subscribed: true,
      current_amount_usd: '90.00',
      projected_amount_usd: '350.00',
      current_usage: 4000,
      usage_limit: 53000000,
      projected_usage: 0,
      percentage_usage: 0,
      has_exceeded_limit: false,
      unit: 'recording'
    },
    // Unsubscribed, no spend, no usage, no limit — filtered out of BOTH reports.
    {
      type: 'surveys',
      name: 'Surveys',
      subscribed: false,
      current_amount_usd: '0.00',
      current_usage: 0,
      usage_limit: null
    }
  ],
  account_owner: { name: 'Test Owner', email: 'owner+test@example.com' },
  stripe_portal_url: 'https://us.posthog.com/api/billing/portal'
}

const spend: RawBreakdowns = {
  results: [
    { id: 0, label: 'Product analytics', data: [10, 20, 30], dates: ['2026-06-01', '2026-06-02', '2026-06-03'] },
    { id: 1, label: 'Session replay', data: [0, 5, 0], dates: ['2026-06-01', '2026-06-02', '2026-06-03'] },
    // All-zero — dropped.
    { id: 2, label: 'Surveys', data: [0, 0, 0], dates: ['2026-06-01', '2026-06-02', '2026-06-03'] }
  ]
}

const usageBreakdowns: RawBreakdowns = {
  results: [
    { id: 0, label: 'Events', data: [100, 200], dates: ['2026-06-01', '2026-06-02'] },
    { id: 1, label: 'Recordings', data: [0, 0], dates: ['2026-06-01', '2026-06-02'] }
  ]
}

// CENTS + unix seconds.
const stripeInvoices: RawStripeInvoiceList = {
  has_more: true,
  data: [
    { amount_due: 250000, status: 'paid', finalized_at: 1781568000, hosted_invoice_url: 'https://invoice/jun' },
    { amount_due: 180050, status: 'paid', finalized_at: 1778976000, hosted_invoice_url: 'https://invoice/may' },
    { amount_due: 199900, status: 'open', effective_at: 1776297600 }
  ]
}

describe('usd', () => {
  it('parses dollar strings/numbers, 0 on missing/invalid', () => {
    expect(usd('250.00')).toBeCloseTo(250)
    expect(usd(12.5)).toBeCloseTo(12.5)
    expect(usd(null)).toBe(0)
    expect(usd(undefined)).toBe(0)
    expect(usd('not-a-number')).toBe(0)
  })
})

describe('normalizeTimeseries', () => {
  it('uses the first non-empty dates array and drops zero series', () => {
    const ts = normalizeTimeseries({
      results: [
        { label: 'A', data: [0, 0], dates: ['d1', 'd2'] },
        { label: 'B', data: [1, 0], dates: ['d1', 'd2'] }
      ]
    })

    expect(ts.dates).toEqual(['d1', 'd2'])
    expect(ts.series).toEqual([{ label: 'B', data: [1, 0] }])
  })
})

describe('buildBillingReport', () => {
  it('parses USD strings (NOT cents) for plan/period/totals + account owner', () => {
    const r = buildBillingReport(billing, spend)

    expect(r.plan).toBe('boost')
    expect(r.subscriptionLevel).toBe('paid')
    expect(r.hasActiveSubscription).toBe(true)
    expect(r.currentTotal).toBeCloseTo(180)
    expect(r.currentMtd).toBeCloseTo(180)
    expect(r.projectedTotal).toBeCloseTo(2750.5)
    expect(r.period).toEqual({
      start: '2026-06-10T18:08:21Z',
      end: '2026-07-10T18:08:21Z',
      interval: 'month'
    })
    expect(r.accountOwner).toEqual({ name: 'Test Owner', email: 'owner+test@example.com' })
    expect(r.portalUrl).toBe('https://us.posthog.com/api/billing/portal')
  })

  it('keeps only subscribed/spending products, sorted by projected spend desc', () => {
    const r = buildBillingReport(billing, spend)

    expect(r.products.map((p) => p.type)).toEqual(['product_analytics', 'session_replay'])
    expect(r.products[0]!.projectedAmount).toBeCloseTo(2400)
    expect(r.products[1]!.currentAmount).toBeCloseTo(90)
  })

  it('normalizes the spend timeseries, dropping all-zero series', () => {
    const r = buildBillingReport(billing, spend)

    expect(r.spend.dates).toEqual(['2026-06-01', '2026-06-02', '2026-06-03'])
    expect(r.spend.series.map((s) => s.label)).toEqual(['Product analytics', 'Session replay'])
  })

  it('normalizes Stripe-portal invoices as CENTS→$, newest first', () => {
    const r = buildBillingReport(billing, spend, stripeInvoices)

    expect(r.invoices).toHaveLength(3)
    expect(r.invoices[0]!.amount).toBeCloseTo(2500)
    expect(r.invoices[0]!.status).toBe('paid')
    expect(r.invoices[0]!.hostedUrl).toBe('https://invoice/jun')
    expect(r.invoices.map((i) => i.date)).toEqual(['2026-06-16', '2026-05-17', '2026-04-16'])
    expect(r.totalBilled).toBeCloseTo(2500 + 1800.5 + 1999)
  })

  it('handles empty input (incl. no invoice history)', () => {
    const r = buildBillingReport({}, {})

    expect(r.currentTotal).toBe(0)
    expect(r.currentMtd).toBe(0)
    expect(r.products).toEqual([])
    expect(r.spend).toEqual({ dates: [], series: [] })
    expect(r.invoices).toEqual([])
    expect(r.totalBilled).toBe(0)
    expect(r.hasActiveSubscription).toBe(false)
    expect(r.portalUrl).toBeUndefined()
  })
})

describe('buildPosthogSummaryResult', () => {
  it('emits a valid summary CapabilityResult with the MTD account stat + monthly chart + products table', () => {
    const result = buildPosthogSummaryResult(buildBillingReport(billing, spend, stripeInvoices))

    expect(validateCapabilityResult(result)).toEqual([])

    // billingSummaryResult emits spend.mtd only when currentMtd is a number — 180 here.
    expect(result.summaries?.[0]?.section).toBe('spend')
    expect(result.summaries?.[0]?.value).toBeCloseTo(180)

    // Datasets discriminate on `shape`, not kind.
    const account = result.datasets.find((d) => d.id === 'account')

    expect(account?.shape).toBe('record')

    if (account?.shape === 'record') {
      expect(account.value.currentMtd).toBeCloseTo(180)
      expect(account.value.plan).toBe('boost')
      expect(account.value.subscription).toBe('paid')
      expect(account.value.projected).toBeCloseTo(2750.5)
    }

    // The chart buckets by the INCURRED month: each invoice shifts a month back from its effective date (billed
    // in arrears), so issue months 06/05/04 chart as 05/04/03; the detail invoices table keeps the real dates.
    const monthly = result.datasets.find((d) => d.id === 'monthly')

    expect(monthly?.shape).toBe('table')
    expect(monthly?.shape === 'table' && monthly.rows.map((r) => r.month)).toEqual(['2026-03', '2026-04', '2026-05'])

    const products = result.datasets.find((d) => d.id === 'products')

    expect(products?.shape).toBe('table')

    if (products?.shape === 'table') {
      expect(products.rows).toHaveLength(2)
      expect(products.rows[0]!.projectedAmount).toBeCloseTo(2400)
    }
  })

  it('omits the spend.mtd summary spark only when currentMtd is null (structure check)', () => {
    // currentMtd is always a number here (usd() → 0 on empty), so the summary is present with value 0.
    const result = buildPosthogSummaryResult(buildBillingReport({}, {}))

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.summaries?.[0]?.section).toBe('spend')
    expect(result.summaries?.[0]?.basis).toBe('accrued')
    expect(result.summaries?.[0]?.value).toBe(0)
  })
})

describe('buildPosthogBillingTab', () => {
  it('emits the subscription record + a fetch-downloaded invoices table (no chart, no summary)', () => {
    const result = buildPosthogBillingTab(buildBillingReport(billing, spend, stripeInvoices))

    expect(validateCapabilityResult(result)).toEqual([])
    // The detail tab carries no spend.mtd headline + no monthly chart (Summary owns those).
    expect(result.summaries).toBeUndefined()
    expect(result.datasets.some((d) => d.id === 'monthly')).toBe(false)

    const invoices = result.datasets.find((d) => d.id === 'invoices')

    expect(invoices?.shape).toBe('table')

    if (invoices?.shape === 'table') {
      expect(invoices.rows).toHaveLength(3)
      // Newest first; amounts in dollars; the hosted page carried through for the per-row download.
      expect(invoices.rows[0]).toMatchObject({ amount: 2500, status: 'paid', hostedUrl: 'https://invoice/jun' })
    }

    // Invoices download via fetchFile (PostHog exposes only the hosted page, no direct PDF URL).
    const view = result.views?.find((v) => v.type === 'table' && v.dataset === 'invoices') as { files?: unknown }

    expect(view.files).toMatchObject({ source: { fetch: true }, ext: 'pdf' })
  })

  it('drops the invoices table on an account with no invoices', () => {
    const result = buildPosthogBillingTab(buildBillingReport(billing, spend, {}))

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.datasets.some((d) => d.id === 'invoices')).toBe(false)
    expect(result.datasets.some((d) => d.id === 'account')).toBe(true)
  })
})

describe('buildUsageReport', () => {
  it('maps per-product usage vs limit, sorted by current usage desc', () => {
    const r = buildUsageReport(billing, usageBreakdowns)

    expect(r.products.map((p) => p.type)).toEqual(['product_analytics', 'session_replay'])
    const pa = r.products[0]!

    expect(pa.currentUsage).toBe(12000)
    expect(pa.usageLimit).toBeNull()
    expect(pa.unit).toBe('event')
    // session_replay kept because it has usage + a limit.
    expect(r.products[1]!.usageLimit).toBe(53000000)
  })

  it('normalizes the usage timeseries (drops zero series) and reads the period', () => {
    const r = buildUsageReport(billing, usageBreakdowns)

    expect(r.usage.series.map((s) => s.label)).toEqual(['Events'])
    expect(r.period.interval).toBe('month')
  })

  it('handles empty input', () => {
    const r = buildUsageReport({}, {})

    expect(r.products).toEqual([])
    expect(r.usage).toEqual({ dates: [], series: [] })
  })
})

describe('buildPosthogUsageResult', () => {
  it('emits a valid usage CapabilityResult with per-product metrics + a daily stacked chart', () => {
    const result = buildPosthogUsageResult(buildUsageReport(billing, usageBreakdowns))

    expect(validateCapabilityResult(result)).toEqual([])

    const metrics = result.datasets.find((d) => d.id === 'metrics')

    expect(metrics?.shape).toBe('table')

    if (metrics?.shape === 'table') {
      expect(metrics.rows.map((row) => row.label)).toEqual(['Product analytics', 'Session replay'])
      expect(metrics.rows[0]!.value).toBe(12000)
      expect(metrics.rows[0]!.unit).toBe('event')
    }

    // The daily series is built with one column per surviving product series (Events only).
    const daily = result.datasets.find((d) => d.id === 'daily')

    expect(daily?.shape).toBe('table')

    if (daily?.shape === 'table') {
      expect(daily.columns.map((c) => c.key)).toEqual(['date', 'Events'])
      expect(daily.rows).toEqual([
        { date: '2026-06-01', Events: 100 },
        { date: '2026-06-02', Events: 200 }
      ])
    }

    // Usage is counts, not money — no usage.primary money summary.
    expect(result.summaries).toBeUndefined()
  })

  it('renders the metrics table with no chart when the timeseries is empty', () => {
    const result = buildPosthogUsageResult(buildUsageReport(billing, {}))

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.datasets.find((d) => d.id === 'daily')).toBeUndefined()
  })
})

// Synthetic org-members payload — invented uuids/names/emails, real `level` codes (1/8/15).
const membersList: RawMembersList = {
  results: [
    { level: 15, user: { uuid: 'u-owner', first_name: 'Ada', last_name: 'Owner', email: 'ada@example.com' } },
    { level: 8, user: { uuid: 'u-admin', first_name: 'Ben', last_name: 'Admin', email: 'ben@example.com' } },
    { level: 1, user: { uuid: 'u-member', first_name: 'Cleo', email: 'cleo@example.com' } },
    // Unknown level → defaults to 'member'.
    { level: 99, user: { uuid: 'u-unknown', email: 'dot@example.com' } }
  ]
}

describe('buildPosthogMembers', () => {
  it('maps nested user → id/name/email and level → role (1/8/15 → member/admin/owner)', () => {
    const { members } = buildPosthogMembers(membersList)

    expect(members).toHaveLength(4)
    expect(members[0]).toEqual({ id: 'u-owner', name: 'Ada Owner', email: 'ada@example.com', role: 'owner' })
    expect(members[1]).toEqual({ id: 'u-admin', name: 'Ben Admin', email: 'ben@example.com', role: 'admin' })
    // first_name only → name is the first name; level 1 → member.
    expect(members[2]).toEqual({ id: 'u-member', name: 'Cleo', email: 'cleo@example.com', role: 'member' })
    // Unknown level falls back to 'member'; no name → undefined.
    expect(members[3]).toEqual({ id: 'u-unknown', name: undefined, email: 'dot@example.com', role: 'member' })
  })

  it('handles empty input', () => {
    expect(buildPosthogMembers({}).members).toEqual([])
    expect(buildPosthogMembers({ results: [] }).members).toEqual([])
  })

  it('falls back to the index id and leaves role undefined when level is missing', () => {
    const { members } = buildPosthogMembers({ results: [{ user: { email: 'noid@example.com' } }] })

    expect(members[0]).toEqual({ id: '0', name: undefined, email: 'noid@example.com', role: undefined })
  })
})

test('posthog plugin is well-formed', () => {
  expect(posthogPlugin.meta.id).toBe('posthog')
  expect(posthogPlugin.auth.kind).toBe('cookie')
  expect(posthogPlugin.auth.clearOnStatuses).toEqual([401, 403])
  expect(posthogPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'usage', 'members'])
  expect(posthogPlugin.config?.fields[0]?.key).toBe('region')
})

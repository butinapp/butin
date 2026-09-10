import { validateSamples } from '@butinapp/sdk/testing'
import { describe, expect, it, test } from 'vitest'

import {
  buildAppOptions,
  buildIntercomBilling,
  buildIntercomBillingTab,
  buildIntercomSummaryResult,
  buildIntercomMembers,
  buildIntercomUsage,
  buildIntercomUsageResult,
  intercomPlugin,
  normalizeInvoice,
  type RawAppBillingDetails,
  type RawCurrentPeriodCharges,
  type RawInvoice,
  type RawPricingMetric,
  type RawSubscriptionDetails,
  type RawUsage
} from './main.js'

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(intercomPlugin)).toEqual([])
})

// Synthetic fixtures matching the dashboard wire shapes; all ids/values are invented.

const nativeInvoice: RawInvoice = {
  id: 'native-1',
  amount: 200, // already DOLLARS
  balance: 0,
  due_date: 'Oct 31, 2022',
  number: 'INV00000001',
  status: 'posted',
  invoice_date: '2022-10-31'
}

const stripeInvoice: RawInvoice = {
  object: 'invoice',
  id: 'in_synthetic1',
  number: 'AAAA0000-0001',
  total: 42000, // CENTS → $420.00
  amount_due: 42000,
  created: 1753920000, // 2025-07-31 (UTC)
  currency: 'usd',
  status: 'paid',
  hosted_invoice_url: 'https://example.test/i/abc',
  invoice_pdf: 'https://example.test/i/abc/pdf'
}

const sub: RawSubscriptionDetails = {
  next_payment_date: '2026-06-30T00:00:00.000Z',
  current_period_start: '2026-05-31T00:00:00.000Z',
  current_period_end: '2026-06-30T00:00:00.000Z',
  cadence: 'monthly',
  subtotal_amount: 90000, // cents → $900.00
  total_amount: 50000, // cents → $500.00
  total_discount_amount: 40000, // cents → $400.00
  total_discount_percentage: 44,
  customer_type: 'self-serve',
  intercom_account_credit: 0,
  products: [
    {
      type: 'core',
      id: 'essential',
      total_amount: 60000,
      items: [
        {
          product_name: 'Sample Core Plan',
          items: [
            {
              id: 'full_seats',
              quantity: 10,
              total_amount: 60000, // cents → $600.00
              pricing_metric: 'core_seat_count',
              nickname: 'Full seats'
            }
          ]
        }
      ]
    },
    { type: 'usage_based', total_amount: 0, items: [] }
  ]
}

const current: RawCurrentPeriodCharges = {
  invoice_date: '2026-06-30T00:00:00.000Z',
  current_period_start: '2026-05-31T00:00:00.000Z',
  current_period_end: '2026-06-30T00:00:00.000Z',
  subtotal_amount: 90000,
  total_amount: 50000, // cents → $500.00 (the live MTD)
  amount_due: 50000,
  amount_paid: 0,
  total_discount_amount: 40000,
  is_renewal_month: true
}

const app: RawAppBillingDetails = {
  cadence: 'monthly',
  customer_type: 'self-serve',
  in_trial: false,
  seat_based: true
}

// --- normalizeInvoice ---

test('normalizeInvoice keeps native invoice amounts as dollars', () => {
  const n = normalizeInvoice(nativeInvoice)

  expect(n.amount).toBe(200)
  expect(n.date).toBe('2022-10-31')
  expect(n.number).toBe('INV00000001')
  expect(n.status).toBe('posted')
  expect(n.hostedUrl).toBeNull()
})

test('normalizeInvoice converts Stripe cents to dollars and carries links', () => {
  const s = normalizeInvoice(stripeInvoice)

  expect(s.amount).toBeCloseTo(420, 2)
  expect(s.date).toBe('2025-07-31')
  expect(s.status).toBe('paid')
  expect(s.hostedUrl).toBe('https://example.test/i/abc')
  expect(s.pdfUrl).toBe('https://example.test/i/abc/pdf')
})

// --- buildIntercomBilling ---

test('buildIntercomBilling normalizes the finalized invoices newest-first', () => {
  const r = buildIntercomBilling([nativeInvoice, stripeInvoice], sub, current, app)

  // 2025-07 stripe, then 2022-10 native — no synthetic current-period row
  expect(r.invoices).toHaveLength(2)
  expect(r.invoices[0]?.date).toBe('2025-07-31')
  expect(r.invoices[1]?.date).toBe('2022-10-31')
})

test('buildIntercomBilling totals the finalized invoices', () => {
  const r = buildIntercomBilling([nativeInvoice, stripeInvoice], sub, current, app)

  expect(r.totalBilled).toBeCloseTo(200 + 420, 2)
})

test('buildIntercomBilling builds the subscription summary in dollars', () => {
  const r = buildIntercomBilling([], sub, current, app)

  expect(r.subscription.plan).toBe('essential')
  expect(r.subscription.planName).toBe('Sample Core Plan')
  expect(r.subscription.totalUsd).toBeCloseTo(500, 2)
  expect(r.subscription.subtotalUsd).toBeCloseTo(900, 2)
  expect(r.subscription.discountUsd).toBeCloseTo(400, 2)
  expect(r.subscription.seatBased).toBe(true)
  expect(r.subscription.products[0]).toMatchObject({
    name: 'Full seats',
    pricingMetric: 'core_seat_count',
    quantity: 10
  })
  expect(r.subscription.products[0]?.totalUsd).toBeCloseTo(600, 2)
})

test('buildIntercomBilling sets currentMtd to the in-progress period total', () => {
  const r = buildIntercomBilling([], sub, current, app)

  expect(r.currentMtd).toBe(r.currentPeriod.totalUsd)
  expect(r.currentPeriod.amountDueUsd).toBeCloseTo(500, 2)
  expect(r.currentPeriod.isRenewalMonth).toBe(true)
})

test('buildIntercomBilling returns a fully-shaped report on empty input', () => {
  const r = buildIntercomBilling([], {}, {}, {})

  expect(r.invoices).toEqual([])
  expect(r.totalBilled).toBe(0)
  expect(r.subscription.plan).toBe('unknown')
  expect(r.subscription.products).toEqual([])
  expect(r.currentPeriod.totalUsd).toBe(0)
  expect(r.currentMtd).toBe(0)
  expect(r.currency).toBe('usd')
})

// --- buildIntercomSummaryResult (Summary tab — lean overview) ---

test('buildIntercomSummaryResult emits a spend.mtd summary when a period is open', () => {
  const result = buildIntercomSummaryResult(buildIntercomBilling([nativeInvoice, stripeInvoice], sub, current, app))

  expect(result.summaries?.[0]?.section).toBe('spend')
  expect(result.summaries?.[0]?.value).toBeCloseTo(500, 2)
  expect(result.summaries?.[0]?.basis).toBe('accrued')

  // The Summary is an overview: the headline (currentMtd) + the monthly chart only — plan/totals/invoices
  // are the Billing tab's detail, so they must NOT appear here.
  const account = result.datasets.find((d) => d.id === 'account')

  if (account?.shape === 'record') {
    expect(account.value.currentMtd).toBeCloseTo(500, 2)
    expect(account.value.plan).toBeUndefined()
    expect(account.value.totalBilled).toBeUndefined()
    expect(account.value.subscription).toBeUndefined()
  }

  // the monthly-spend dataset feeds both the chart and the Overview spark; no invoices table on Summary
  expect(result.datasets.find((d) => d.id === 'monthly')?.shape).toBe('table')
  expect(result.datasets.find((d) => d.id === 'invoices')).toBeUndefined()
})

test('buildIntercomSummaryResult keeps a 0 spend summary when no period is open, so the service stays in the Overview', () => {
  const result = buildIntercomSummaryResult(buildIntercomBilling([], {}, {}, {}))

  expect(result.summaries?.[0]).toMatchObject({ section: 'spend', value: 0 })
})

// --- buildIntercomBillingTab (Billing tab — account record + line items + invoice list) ---

test('buildIntercomBillingTab carries the subscription account record in dollars', () => {
  const result = buildIntercomBillingTab(buildIntercomBilling([nativeInvoice, stripeInvoice], sub, current, app))
  const account = result.datasets.find((d) => d.id === 'account')

  expect(account?.shape).toBe('record')

  if (account?.shape === 'record') {
    // plan + total billed live HERE (the Billing detail), not on the Summary overview
    expect(account.value).toMatchObject({ plan: 'Sample Core Plan', cadence: 'monthly', customerType: 'self-serve' })
    expect(account.value.subtotal).toBeCloseTo(900, 2)
    expect(account.value.discount).toBeCloseTo(400, 2)
    expect(account.value.total).toBeCloseTo(500, 2)
    expect(account.value.totalBilled).toBeCloseTo(620, 2) // 200 native + 420 stripe
  }
})

test('buildIntercomBillingTab lists the per-product line items', () => {
  const result = buildIntercomBillingTab(buildIntercomBilling([], sub, current, app))
  const products = result.datasets.find((d) => d.id === 'products')

  expect(products?.shape).toBe('table')

  if (products?.shape === 'table') {
    const seats = products.rows.find((r) => r.metric === 'core_seat_count')

    expect(seats).toMatchObject({ name: 'Full seats', quantity: 10, total: 600 })
    // keyed by the line item's unique display name so each line's quantity/total accumulates in the ledger.
    expect(products.key).toBe('name')
  }
})

test('buildIntercomBillingTab renders the invoice list with a download wiring', () => {
  const result = buildIntercomBillingTab(buildIntercomBilling([nativeInvoice, stripeInvoice], sub, current, app))
  const invoices = result.datasets.find((d) => d.id === 'invoices')

  expect(invoices?.shape).toBe('table')

  if (invoices?.shape === 'table') {
    expect(invoices.rows).toHaveLength(2)
    // the Stripe invoice exposes a downloadable PDF
    expect(invoices.rows.find((r) => r.number === 'AAAA0000-0001')?.pdfUrl).toBe('https://example.test/i/abc/pdf')
    // keyed by the stable invoice id (present even when `number` is blank) so status accumulates in the ledger.
    expect(invoices.key).toBe('id')
    expect(invoices.rows.find((r) => r.number === 'AAAA0000-0001')?.id).toBe('in_synthetic1')
  }
})

// --- usage ---

const usage: RawUsage = {
  contract: {
    billing_cycle_end_date: '2026-06-30',
    prepaid_usage: { core_seat_count: 1, resolutions_metered: 0, emails_sent: 0 },
    total_usage: {
      core_seat_count: 10,
      latest_daily_admin_count: 10,
      resolutions_metered: 0,
      emails_sent: 0
    }
  },
  usage_statistics: [
    { created_at: '2026-06-01', core_seat_count: 10, latest_daily_admin_count: 10, resolutions: 0, conversations: 2 },
    { created_at: '2026-05-31', core_seat_count: 10, latest_daily_admin_count: 10, resolutions: 0, conversations: 1 }
  ]
}

const pricingMetrics: RawPricingMetric[] = [
  { metric_key: 'core_seat_count', metric_nickname: 'Full seats' },
  { metric_key: 'resolutions_metered', metric_nickname: 'Resolutions', usage_category: undefined },
  { metric_key: 'emails_sent', metric_nickname: 'Emails sent' },
  { metric_key: 'sms_segments_metered', metric_nickname: 'SMS segments', usage_category: 'sms' }
]

test('buildIntercomUsage joins each billable metric to its current usage and allowance', () => {
  const r = buildIntercomUsage(usage, pricingMetrics)
  const seats = r.metrics.find((m) => m.key === 'core_seat_count')

  expect(seats).toMatchObject({ label: 'Full seats', usage: 10, allowance: 1 })

  const sms = r.metrics.find((m) => m.key.startsWith('sms_'))

  expect(sms).toMatchObject({ label: 'SMS segments', usage: 0, category: 'sms' })
  expect(sms?.allowance).toBeUndefined() // not in prepaid_usage
})

test('buildIntercomUsage sorts the daily series oldest-first and coalesces missing counts', () => {
  const r = buildIntercomUsage(usage, pricingMetrics)

  expect(r.daily.map((d) => d.date)).toEqual(['2026-05-31', '2026-06-01'])
  expect(r.daily[1]).toMatchObject({ coreSeats: 10, conversations: 2, resolutions: 0, messagesSent: 0 })
})

test('buildIntercomUsage surfaces seat + period summary fields', () => {
  const r = buildIntercomUsage(usage, pricingMetrics)

  expect(r.coreSeatCount).toBe(10)
  expect(r.latestAdminCount).toBe(10)
  expect(r.periodStart).toBe('2026-05-31')
  expect(r.periodEnd).toBe('2026-06-30')
})

test('buildIntercomUsage returns a fully-shaped report on empty input', () => {
  const r = buildIntercomUsage({}, [])

  expect(r.metrics).toEqual([])
  expect(r.daily).toEqual([])
  expect(r.coreSeatCount).toBe(0)
  expect(r.latestAdminCount).toBe(0)
  expect(r.periodEnd).toBeUndefined()
})

test('buildIntercomUsageResult maps metrics with allowance as the limit and emits no money summary', () => {
  const result = buildIntercomUsageResult(buildIntercomUsage(usage, pricingMetrics))

  expect(result.summaries).toBeUndefined() // counts only, no cost
  const metrics = result.datasets.find((d) => d.id === 'metrics')

  expect(metrics?.shape).toBe('table')
})

// --- members ---

describe('buildIntercomMembers', () => {
  it('maps the human admins to the roster (name + email, no role)', () => {
    const { members } = buildIntercomMembers({
      admins: [
        { id: 101, email: 'ada@acme.test', name: 'Ada Byron' },
        { id: 102, email: 'grace@acme.test', name: 'Grace Mol' }
      ]
    })

    expect(members.map((m) => m.id)).toEqual(['101', '102'])
    expect(members[0]).toMatchObject({ name: 'Ada Byron', email: 'ada@acme.test' })
    expect(members[0]!.role).toBeUndefined()
  })

  it('filters out teams, bots, the operator, and the seatless "Unassigned" placeholder', () => {
    const { members } = buildIntercomMembers({
      admins: [
        { id: 101, email: 'ada@acme.test', name: 'Ada Byron' },
        { id: 0, name: 'Unassigned' }, // no email → dropped
        { id: 200, email: 'ops@acme.test', name: 'Operator', is_operator: true },
        { id: 201, email: 'team@acme.test', name: 'Support', is_team: true },
        { id: 202, email: 'gh@acme.test', name: 'GitHub', is_github_bot: true }
      ]
    })

    expect(members.map((m) => m.id)).toEqual(['101'])
  })

  it('tolerates empty / absent input', () => {
    expect(buildIntercomMembers({ admins: [] }).members).toEqual([])
    expect(buildIntercomMembers(null).members).toEqual([])
  })
})

// --- appId combobox options ---

describe('buildAppOptions', () => {
  const apps = [
    { id: '2156036', id_code: 'badbuu9i', name: 'Acme [DEV]' },
    { id: '2064471', id_code: 'bjzkw2xf', name: 'Acme' }
  ]

  it('stores the id_code and labels by workspace name, with the id_code as subtext', () => {
    expect(buildAppOptions(apps)).toEqual([
      { value: 'badbuu9i', label: 'Acme [DEV]', description: 'badbuu9i' },
      { value: 'bjzkw2xf', label: 'Acme', description: 'bjzkw2xf' }
    ])
  })

  it('falls back to the id_code as label when unnamed, and drops apps with no id_code', () => {
    expect(buildAppOptions([{ id_code: 'solo' }, { id: '9', name: 'No code' }])).toEqual([
      { value: 'solo', label: 'solo', description: undefined }
    ])
  })

  it('handles empty / absent input', () => {
    expect(buildAppOptions(null)).toEqual([])
  })
})

// --- descriptor ---

test('intercom plugin is well-formed', () => {
  expect(intercomPlugin.meta.id).toBe('intercom')
  expect(intercomPlugin.auth.kind).toBe('cookie')
  expect(intercomPlugin.session?.requiredCookie).toBe('_intercom_session')
  expect(intercomPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'usage', 'members'])
  // appId is a required text config field
  const appIdField = intercomPlugin.config?.fields.find((f) => f.key === 'appId')

  expect(appIdField).toMatchObject({ kind: 'combobox', required: true })
  expect(typeof appIdField?.loadOptions).toBe('function')
})

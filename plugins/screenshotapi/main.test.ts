import { resultValidator, validateSamples } from '@butinapp/sdk/testing'
import { expect, test } from 'vitest'

import {
  buildScreenshotapiBilling,
  buildScreenshotapiBillingTab,
  buildScreenshotapiSummaryResult,
  buildScreenshotapiUsage,
  buildScreenshotapiUsageMetrics,
  buildScreenshotapiUsageResult,
  type RawBillingInfoResponse,
  type RawInvoicesResponse,
  type RawSubscriptionHistory,
  type RawUsageResponse,
  screenshotapiPlugin
} from './main.js'

const validateCapabilityResult = resultValidator('USD')

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(screenshotapiPlugin)).toEqual([])
})

// --- synthetic fixtures (values invented) ---

const invoices: RawInvoicesResponse = {
  success: true,
  invoices: [
    { amount: 99, planName: 'Sample Monthly', hostedUrl: 'https://invoice.example.com/i/may', date: '2026/05/13' },
    { amount: 99, planName: 'Sample Monthly', hostedUrl: 'https://invoice.example.com/i/apr', date: '2026/04/13' },
    { amount: 99, planName: 'Sample Monthly', hostedUrl: 'https://invoice.example.com/i/mar', date: '2026/03/13' }
  ],
  legacy: false
}

const info: RawBillingInfoResponse = {
  billingInfo: {
    subscriptionStatus: 'active',
    cardBrand: 'visa',
    cardLastFour: '4242',
    cardExpMonth: 6,
    cardExpYear: 2028,
    currentPlan: 'price_sample',
    cancelAt: null,
    nextBillDate: '2026-06-13T16:44:03.000Z',
    nextBillingAmount: 99,
    screenshot_amount: 50000,
    nextInvoiceUsage: 4294,
    currentPeriodStart: '2026-05-13T16:44:03.000Z',
    current_billing_period_count: 4429
  }
}

const subHistory: RawSubscriptionHistory = {
  subscriptions: [
    {
      status: 'active',
      currency: 'usd',
      current_period_start: 1778690643,
      current_period_end: 1781369043,
      start_date: 1718297043,
      plan_id: 'price_sample',
      plan_amount: 9900, // CENTS
      interval: 'month',
      interval_count: 1,
      quantity: 1,
      plan_name: 'Sample Monthly'
    }
  ]
}

const usage: RawUsageResponse = {
  success: true,
  usage: {
    days: [
      { day: 'May 13', successful: 180, failed: 3 },
      { day: 'May 15', successful: 369, failed: 9 },
      { day: 'Jun 11', successful: 135, failed: 2 }
    ],
    totalScreenshots: 89852,
    totalFailed: 106
  }
}

// --- auth / transport contract ---

test('screenshotapi captures the Auth0 id_token from localStorage and replays it as a Bearer', () => {
  const { auth } = screenshotapiPlugin

  expect(auth.kind).toBe('bearer-token')

  if (auth.kind === 'bearer-token') {
    expect(auth.tokenField).toBe('accessToken')
  }

  const token = screenshotapiPlugin.session?.localStorageTokens?.[0]

  expect(token).toMatchObject({ key: '@SCREENSHOT-id_token', storeAs: 'accessToken' })
  // node transport (the edge accepts a plain client) — engine left default.
  expect(screenshotapiPlugin.transport?.engine).toBeUndefined()
  expect(screenshotapiPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'usage'])
})

// --- billing ---

test('billing normalizes invoices (dollars) and dates (YYYY/MM/DD → YYYY-MM-DD), newest-first input preserved', () => {
  const r = buildScreenshotapiBilling(invoices, info, subHistory)

  expect(r.invoices).toHaveLength(3)
  expect(r.invoices[0]).toMatchObject({
    date: '2026-05-13',
    status: 'paid',
    amount: 99,
    planName: 'Sample Monthly',
    hostedUrl: 'https://invoice.example.com/i/may'
  })
  expect(r.totalBilled).toBe(297)
  expect(r.currency).toBe('USD')
})

test('billing subscription summary converts plan_amount cents → dollars only as the fallback', () => {
  const r = buildScreenshotapiBilling(invoices, info, subHistory)

  expect(r.subscription).toMatchObject({
    status: 'active',
    planName: 'Sample Monthly',
    monthlyAmount: 99, // from nextBillingAmount (dollars), not plan_amount/100
    interval: 'month',
    currentPeriodStart: '2026-05-13',
    currentPeriodEnd: '2026-06-13',
    nextBillDate: '2026-06-13',
    nextBillingAmount: 99,
    cardBrand: 'visa',
    cardLast4: '4242',
    cardExp: '6/2028',
    quota: 50000,
    usedThisPeriod: 4429
  })

  // nextBillingAmount absent → falls back to plan_amount (9900 cents → $99).
  const fb = buildScreenshotapiBilling(invoices, { billingInfo: {} }, subHistory)

  expect(fb.subscription.monthlyAmount).toBe(99)
  expect(fb.subscription.nextBillingAmount).toBe(0)
})

test('billing currentMtd is the recurring flat fee; null on an empty month', () => {
  expect(buildScreenshotapiBilling(invoices, info, subHistory).currentMtd).toBe(99)

  const empty = buildScreenshotapiBilling({}, {}, {})

  expect(empty.invoices).toEqual([])
  expect(empty.totalBilled).toBe(0)
  expect(empty.currentMtd).toBeNull()
  expect(empty.subscription).toMatchObject({ status: 'unknown', planName: 'unknown', monthlyAmount: 0, quota: 0 })
  expect(empty.subscription.currentPeriodStart).toBeUndefined()
})

test('billing tolerates null/undefined inputs', () => {
  const r = buildScreenshotapiBilling(null, null, null)

  expect(r.currentMtd).toBeNull()
  expect(r.invoices).toEqual([])
  expect(r.currency).toBe('USD')
})

test('summary result is a lean billing summary: spend.mtd + monthly spark + tight stat row, no detail tables', () => {
  const result = buildScreenshotapiSummaryResult(buildScreenshotapiBilling(invoices, info, subHistory))

  expect(validateCapabilityResult(result)).toEqual([])
  // Lean: the headline account stat + the monthly chart only — no invoices/subscription detail dataset.
  expect(result.datasets.map((d) => d.id).sort()).toEqual(['account', 'monthly'])
  expect(result.datasets.some((d) => d.id === 'invoices')).toBe(false)

  const account = result.datasets.find((d) => d.id === 'account') as unknown as { value: Record<string, unknown> }

  expect(account.value).toMatchObject({ currentMtd: 99, status: 'active', quotaUsed: 4429, nextBill: '2026-06-13' })
  expect(account.value.baseFee).toBeUndefined()

  expect(result.summaries?.[0]).toMatchObject({
    section: 'spend',
    value: 99,
    role: 'money',
    basis: 'flat',
    spark: { dataset: 'monthly' }
  })
})

test('summary result on an empty month omits spend.mtd', () => {
  const result = buildScreenshotapiSummaryResult(buildScreenshotapiBilling({}, {}, {}))

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries).toBeUndefined()
})

test('billing tab is the detail: a subscription record + a downloadable invoices table, no spend.mtd', () => {
  const result = buildScreenshotapiBillingTab(buildScreenshotapiBilling(invoices, info, subHistory))

  expect(validateCapabilityResult(result)).toEqual([])
  // Detail datasets present; no Overview rollup (Summary owns spend.mtd) and no monthly chart.
  expect(result.datasets.map((d) => d.id).sort()).toEqual(['account', 'invoices'])
  expect(result.summaries).toBeUndefined()
  expect(result.datasets.some((d) => d.id === 'monthly')).toBe(false)

  const account = result.datasets.find((d) => d.id === 'account') as unknown as { value: Record<string, unknown> }

  expect(account.value).toMatchObject({
    plan: 'Sample Monthly',
    status: 'active',
    period: '2026-05-13 → 2026-06-13',
    nextBill: '2026-06-13',
    card: 'visa •••• 4242 (exp 6/2028)',
    quota: 50000,
    quotaUsed: 4429,
    monthlyFee: 99
  })

  const view = result.views?.find((v) => v.type === 'table' && v.dataset === 'invoices') as { files?: unknown }

  // The PDF has no direct URL — the table downloads through the capability's fetchFile hook.
  expect(view.files).toMatchObject({ name: 'name', source: { fetch: true }, ext: 'pdf', category: 'Invoices' })

  const invoicesDs = result.datasets.find((d) => d.id === 'invoices') as unknown as {
    key: string
    rows: Record<string, unknown>[]
  }

  // Keyed on the invoice date so each monthly invoice accumulates in the ledger past the fetch window.
  expect(invoicesDs.key).toBe('date')
  const rows = invoicesDs.rows

  expect(rows[0]).toMatchObject({
    date: '2026-05-13',
    amount: 99,
    hostedUrl: 'https://invoice.example.com/i/may',
    name: 'Invoice 2026-05-13'
  })
})

test('billing tab on an empty month keeps the subscription record but omits the invoices table', () => {
  const result = buildScreenshotapiBillingTab(buildScreenshotapiBilling({}, {}, {}))

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.datasets.some((d) => d.id === 'account')).toBe(true)
  expect(result.datasets.some((d) => d.id === 'invoices')).toBe(false)
})

// --- usage ---

test('usage maps daily counts and sums successful/failed for the period', () => {
  const r = buildScreenshotapiUsage(usage, info)

  expect(r.days).toHaveLength(3)
  expect(r.days[0]).toEqual({ day: 'May 13', successful: 180, failed: 3 })
  expect(r.totalSuccessfulPeriod).toBe(180 + 369 + 135)
  expect(r.totalFailedPeriod).toBe(3 + 9 + 2)
})

test('usage pulls quota / used / lifetime / period start; falls back to nextInvoiceUsage', () => {
  const r = buildScreenshotapiUsage(usage, info)

  expect(r.quota).toBe(50000)
  expect(r.usedThisPeriod).toBe(4429)
  expect(r.lifetimeScreenshots).toBe(89852)
  expect(r.periodStart).toBe('2026-05-13')

  const fb = buildScreenshotapiUsage(usage, { billingInfo: { nextInvoiceUsage: 4294 } })

  expect(fb.usedThisPeriod).toBe(4294)
})

test('usage returns a fully-shaped report with safe defaults on empty/null input', () => {
  for (const r of [buildScreenshotapiUsage({}, {}), buildScreenshotapiUsage(null, null)]) {
    expect(r.days).toEqual([])
    expect(r.totalSuccessfulPeriod).toBe(0)
    expect(r.totalFailedPeriod).toBe(0)
    expect(r.usedThisPeriod).toBe(0)
    expect(r.quota).toBe(0)
    expect(r.lifetimeScreenshots).toBe(0)
    expect(r.periodStart).toBeUndefined()
  }
})

test('usage metrics are counts (no cost) with quota as the period limit', () => {
  const metrics = buildScreenshotapiUsageMetrics(buildScreenshotapiUsage(usage, info))

  expect(metrics[0]).toEqual({ label: 'Screenshots this period', value: 4429, unit: 'screenshots', limit: 50000 })
  expect(metrics.map((m) => m.label)).toEqual([
    'Screenshots this period',
    'Successful (period)',
    'Failed (period)',
    'All-time screenshots'
  ])
  expect(metrics.every((m) => m.cost === undefined)).toBe(true)
})

test('usage result is valid, emits no money summary (counts), and appends a daily breakdown table when days exist', () => {
  const result = buildScreenshotapiUsageResult(buildScreenshotapiUsage(usage, info))

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries).toBeUndefined()
  expect(result.datasets.some((d) => d.id === 'daily')).toBe(true)
  expect(result.views?.some((v) => v.type === 'table' && v.dataset === 'daily')).toBe(true)

  const noDays = buildScreenshotapiUsageResult(buildScreenshotapiUsage({ usage: { days: [] } }, info))

  expect(validateCapabilityResult(noDays)).toEqual([])
  expect(noDays.datasets.some((d) => d.id === 'daily')).toBe(false)
})

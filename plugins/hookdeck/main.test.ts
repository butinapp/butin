import { resolveCurrencies, validateCapabilityResult } from '@butinapp/sdk/data'
import { currentMonthKey } from '@butinapp/sdk/util'
import { describe, expect, it, test } from 'vitest'

import {
  buildBillingReport,
  buildHookdeckBillingTab,
  buildHookdeckMembers,
  buildHookdeckSummaryResult,
  buildHookdeckUsageResult,
  buildUsageReport,
  hookdeckPlugin,
  type RawHookdeckAddress,
  type RawHookdeckCard,
  type RawHookdeckEmail,
  type RawHookdeckInvoice,
  type RawHookdeckMember,
  type RawHookdeckSubscription,
  type RawHookdeckUsageResponse
} from './main.js'

// SYNTHETIC fixtures (no real account data). Invoice amounts are CENTS (Orb), and Orb can carry float
// noise (6990.000000000001); the subscription's per-price unit_amount fields are Orb dollar strings.
// Dates are recent so the spend.mtd / current-month assertions are derived from STRUCTURE, not pinned days.

const ym = currentMonthKey() // 'YYYY-MM' of the current calendar month
const thisMonthDay = `${ym}-05T12:00:00+00:00`

const invoices: RawHookdeckInvoice[] = [
  {
    id: 'INV-00008',
    is_paid: true,
    amount_due: 6990.000000000001, // → $69.90 after rounding
    issue_date: thisMonthDay,
    pdf_url: 'https://assets.example-orb.test/invoice/8?token=a'
  },
  {
    id: 'INV-00007',
    is_paid: true,
    amount_due: 7050, // → $70.50
    issue_date: '2025-12-13T00:06:13+00:00',
    pdf_url: 'https://assets.example-orb.test/invoice/7?token=b'
  },
  {
    id: 'INV-00005',
    is_paid: true,
    amount_due: 2357, // → $23.57
    issue_date: '2025-10-18T15:56:12+00:00',
    pdf_url: 'https://assets.example-orb.test/invoice/5?token=c'
  }
]

const sub: RawHookdeckSubscription = {
  status: 'active',
  name: 'Team',
  current_billing_period_start_date: `${ym}-01T00:00:00+00:00`,
  current_billing_period_end_date: `${ym}-28T00:00:00+00:00`,
  billing_cycle_day: 1,
  customer: {
    name: 'Sample Org Inc',
    email: 'billing@example.test',
    currency: 'USD',
    portal_url: 'https://portal.example-orb.test/view?token=xyz'
  },
  plan: { name: 'Team', external_plan_id: 'starter' },
  price_intervals: [
    // ended interval for the Plan item — must be ignored.
    { end_date: '2025-01-28T14:49:55+00:00', price: { item: { name: 'Plan' }, unit_config: { unit_amount: '0.00' } } },
    // active Plan price → $39.00 base fee.
    { end_date: null, price: { item: { name: 'Plan' }, unit_config: { unit_amount: '39.00' } } },
    // active usage price (no unit_config) — must not be picked as the base fee.
    { end_date: null, price: { item: { name: 'Events' }, unit_config: null } }
  ]
}

const card: RawHookdeckCard = {
  brand: 'visa',
  display_brand: 'visa',
  last4: '4242',
  exp_month: 4,
  exp_year: 2030,
  funding: 'credit',
  country: 'CA'
}

const email: RawHookdeckEmail = { email: 'receipts@example.test' }
const address: RawHookdeckAddress = { billing_address: { name: 'Sample Org Inc' }, tax_id: null }

describe('hookdeck buildBillingReport', () => {
  it('normalizes invoices from cents to dollars (shedding float noise) and sorts newest-first', () => {
    const r = buildBillingReport(invoices, sub, card, email, address)

    expect(r.invoices.map((i) => i.id)).toEqual(['INV-00008', 'INV-00007', 'INV-00005'])
    expect(r.invoices[0]).toMatchObject({ id: 'INV-00008', status: 'paid', amount: 69.9 })
    // 6990.000000000001 / 100 rounded to cents → 69.9, not 69.90000000001.
    expect(r.invoices[0].amount).toBe(69.9)
    expect(r.invoices[0].pdfUrl).toBe('https://assets.example-orb.test/invoice/8?token=a')
    expect(r.totalBilled).toBe(69.9 + 70.5 + 23.57)
  })

  it('computes currentMtd from the current calendar month only', () => {
    const r = buildBillingReport(invoices, sub, card, email, address)

    // Only INV-00008 (this month) → $69.90; the older invoices are excluded.
    expect(r.currentMtd).toBe(69.9)
  })

  it('exposes plan / period / base-fee summary', () => {
    const r = buildBillingReport(invoices, sub, card, email, address)

    expect(r.plan).toBe('Team')
    expect(r.planExternalId).toBe('starter')
    expect(r.subscriptionStatus).toBe('active')
    expect(r.billingCycleDay).toBe(1)
    expect(r.monthlyPlanCost).toBe(39) // dollar string '39.00', not cents; the ended '0.00' interval ignored
    expect(r.currency).toBe('USD')
    expect(r.portalUrl).toBe('https://portal.example-orb.test/view?token=xyz')
  })

  it('derives payment method, contact, and last invoice', () => {
    const r = buildBillingReport(invoices, sub, card, email, address)

    expect(r.paymentMethod).toMatchObject({ brand: 'visa', last4: '4242', expMonth: 4, expYear: 2030 })
    expect(r.billingContact).toEqual({ name: 'Sample Org Inc', email: 'receipts@example.test' })
    expect(r.lastInvoice).toMatchObject({ amount: 69.9, status: 'paid' })
  })

  it('marks unpaid invoices open and converts cents', () => {
    const r = buildBillingReport(
      [{ id: 'X', is_paid: false, amount_due: 100, issue_date: '2025-08-01T00:00:00+00:00' }],
      sub,
      card,
      email,
      address
    )

    expect(r.invoices[0].status).toBe('open')
    expect(r.invoices[0].amount).toBe(1)
  })

  it('degrades safely on empty / missing inputs', () => {
    const r = buildBillingReport([], null, null, null, null)

    expect(r.invoices).toEqual([])
    expect(r.totalBilled).toBe(0)
    expect(r.currentMtd).toBe(0)
    expect(r.lastInvoice).toBeUndefined()
    expect(r.plan).toBeUndefined()
    expect(r.monthlyPlanCost).toBeUndefined()
    expect(r.paymentMethod).toBeNull()
    expect(r.billingContact).toBeNull()
  })
})

describe('hookdeck buildHookdeckSummaryResult', () => {
  it('is a LEAN overview: spend.mtd + monthly chart, no detail tables', () => {
    const result = buildHookdeckSummaryResult(buildBillingReport(invoices, sub, card, email, address))

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.summaries?.[0]?.section).toBe('spend')
    expect(result.summaries?.[0]?.value).toBe(69.9)
    expect(result.summaries?.[0]?.basis).toBe('invoiced')
    // monthly-spend chart dataset is present (the Overview spark target).
    expect(result.datasets.some((d) => d.id === 'monthly')).toBe(true)
    // the Billing-tab-only detail records (payment method, contact) are NOT here.
    expect(result.datasets.some((d) => d.id === 'paymentMethod')).toBe(false)
    expect(result.datasets.some((d) => d.id === 'contact')).toBe(false)
  })

  it('keeps a 0 spend summary when no invoice falls in the current month, so the service stays in the Overview', () => {
    const report = buildBillingReport(
      [{ id: 'OLD', is_paid: true, amount_due: 5000, issue_date: '2025-01-10T00:00:00+00:00' }],
      sub,
      card,
      email,
      address
    )
    const result = buildHookdeckSummaryResult(report)

    expect(report.currentMtd).toBe(0)
    expect(result.summaries?.[0]).toMatchObject({ section: 'spend', value: 0 })
  })
})

describe('hookdeck buildHookdeckBillingTab', () => {
  it('is the DETAIL: account/payment/contact records + downloadable invoices, no spend.mtd', () => {
    const result = buildHookdeckBillingTab(buildBillingReport(invoices, sub, card, email, address))

    expect(validateCapabilityResult(result)).toEqual([])
    // no Overview rollup or monthly chart on the detail tab.
    expect(result.summaries).toBeUndefined()
    expect(result.datasets.some((d) => d.id === 'monthly')).toBe(false)

    const account = result.datasets.find((d) => d.id === 'account')

    expect(account?.shape).toBe('record')

    if (account?.shape === 'record') {
      expect(account.value.plan).toBe('Team')
      expect(account.value.baseFee).toBe(39)
      expect(account.value.totalBilled).toBe(69.9 + 70.5 + 23.57)
      expect(account.value.portalUrl).toBe('https://portal.example-orb.test/view?token=xyz')
    }

    const payment = result.datasets.find((d) => d.id === 'paymentMethod')

    if (payment?.shape === 'record') {
      expect(payment.value.last4).toBe('4242')
      expect(payment.value.expiry).toBe('04/2030')
    }

    // contact record present, and invoices are a downloadable (pdf) file table.
    expect(result.datasets.some((d) => d.id === 'contact')).toBe(true)
    const invoiceView = result.views?.find((v) => v.type === 'table' && v.dataset === 'invoices')

    expect(invoiceView?.type === 'table' && invoiceView.files?.ext).toBe('pdf')
  })

  it('keys the invoices table on the Orb invoice id so two same-date invoices both survive the ledger', () => {
    // A plan charge and a usage charge can issue the same day → identical date (and the derived name); only the
    // Orb invoice id is unique, so keying on name/date would drop one row from the ledger projection.
    const sameDay = `${ym}-13T00:00:00+00:00`
    const twoOnOneDay: RawHookdeckInvoice[] = [
      { id: 'INV-A', is_paid: true, amount_due: 0, issue_date: sameDay },
      { id: 'INV-B', is_paid: true, amount_due: 6960, issue_date: sameDay }
    ]
    const result = buildHookdeckBillingTab(buildBillingReport(twoOnOneDay, sub, card, email, address))
    const invoices = result.datasets.find((d) => d.id === 'invoices')

    expect(invoices?.shape).toBe('table')

    if (invoices?.shape === 'table') {
      expect(invoices.key).toBe('id')
      expect(invoices.rows.map((r) => r.id)).toEqual(['INV-A', 'INV-B'])
    }
  })

  it('drops the payment-method and contact records when nothing is on file', () => {
    // No card, no contact email/address, and a subscription with no customer contact → both records drop.
    const bareSub: RawHookdeckSubscription = { status: 'active', name: 'Team', plan: { name: 'Team' } }
    const result = buildHookdeckBillingTab(buildBillingReport(invoices, bareSub, null, null, null))

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.datasets.some((d) => d.id === 'paymentMethod')).toBe(false)
    expect(result.datasets.some((d) => d.id === 'contact')).toBe(false)
    // the account record + invoice table still render.
    expect(result.datasets.some((d) => d.id === 'account')).toBe(true)
    expect(result.datasets.some((d) => d.id === 'invoices')).toBe(true)
  })
})

// ── usage ───────────────────────────────────────────────────────────────────────────────

const usageRaw: RawHookdeckUsageResponse = {
  data: [
    {
      billable_metric: { id: 'metric_events', name: 'Events' },
      usage: [
        { quantity: 1743, timeframe_start: '2026-05-12T00:00:00+00:00', timeframe_end: '2026-05-13T00:00:00+00:00' },
        { quantity: 1616, timeframe_start: '2026-05-13T00:00:00+00:00', timeframe_end: '2026-05-14T00:00:00+00:00' },
        { quantity: 0, timeframe_start: '2026-05-14T00:00:00+00:00', timeframe_end: '2026-05-15T00:00:00+00:00' }
      ],
      view_mode: 'periodic'
    },
    {
      billable_metric: { id: 'metric_discarded', name: 'Discarded Requests' },
      usage: [
        { quantity: 0, timeframe_start: '2026-05-12T00:00:00+00:00', timeframe_end: '2026-05-13T00:00:00+00:00' },
        { quantity: 5, timeframe_start: '2026-05-13T00:00:00+00:00', timeframe_end: '2026-05-14T00:00:00+00:00' }
      ],
      view_mode: 'periodic'
    }
  ]
}

describe('hookdeck buildUsageReport', () => {
  it('sums each metric and slices daily timestamps to dates', () => {
    const r = buildUsageReport(usageRaw, '2026-05-12', '2026-06-12')

    expect(r.metrics).toHaveLength(2)
    const events = r.metrics.find((m) => m.name === 'Events')

    expect(events?.total).toBe(1743 + 1616)
    expect(events?.daily[0]).toEqual({ date: '2026-05-12', quantity: 1743 })
    expect(r.metrics.find((m) => m.name === 'Discarded Requests')?.total).toBe(5)
  })

  it('reports the Events total, the merged day axis, and passes through the period', () => {
    const r = buildUsageReport(usageRaw, '2026-05-12', '2026-06-12')

    expect(r.totalEvents).toBe(3359)
    expect(r.days).toEqual(['2026-05-12', '2026-05-13', '2026-05-14'])
    expect(r.periodStart).toBe('2026-05-12')
    expect(r.periodEnd).toBe('2026-06-12')
  })

  it('degrades safely on empty / nullish input', () => {
    expect(buildUsageReport({}).metrics).toEqual([])
    expect(buildUsageReport(null).totalEvents).toBe(0)
    expect(buildUsageReport(undefined).days).toEqual([])
    expect(buildUsageReport({}).periodStart).toBeUndefined()
  })
})

describe('hookdeck buildHookdeckUsageResult', () => {
  it('renders one count metric per billable metric + a per-metric daily timeseries', () => {
    const result = buildHookdeckUsageResult(buildUsageReport(usageRaw, '2026-05-12', '2026-06-12'))

    // usage rows are plain counts (no money summary).
    expect(result.summaries).toBeUndefined()
    const metrics = result.datasets.find((d) => d.id === 'metrics')

    expect(metrics?.shape).toBe('table')

    if (metrics?.shape === 'table') {
      expect(metrics.rows.map((row) => row.label)).toEqual(['Events', 'Discarded Requests'])
      expect(metrics.rows[0].value).toBe(3359)
    }

    // one daily timeseries dataset per metric, keyed by date so it accumulates in the ledger.
    expect(result.datasets.some((d) => d.id === 'daily-metric_events')).toBe(true)
    expect(result.datasets.some((d) => d.id === 'daily-metric_discarded')).toBe(true)
    const daily = result.datasets.find((d) => d.id === 'daily-metric_events')

    expect(daily?.shape === 'table' && daily.key).toBe('date')
  })
})

// ── members ─────────────────────────────────────────────────────────────────────────────

// SYNTHETIC roster (no real account data). The endpoint returns a bare array; the person's name/email
// arrive under user_* keys, and the membership id is an omem_… string.
const membersRaw: RawHookdeckMember[] = [
  { id: 'omem_0001', user_id: 'usr_0001', role: 'owner', user_name: 'Sample Owner', user_email: 'owner@example.test' },
  { id: 'omem_0002', user_id: 'usr_0002', role: 'admin', user_name: 'Sample Admin', user_email: 'admin@example.test' },
  // No name — common for invitees who haven't set a profile; still a real seat (has an email).
  { id: 'omem_0003', user_id: 'usr_0003', role: 'member', user_email: 'member@example.test' },
  // No email — a half-provisioned row; must be dropped.
  { id: 'omem_0004', user_id: 'usr_0004', role: 'viewer', user_name: 'No Email' }
]

describe('hookdeck buildHookdeckMembers', () => {
  it('maps roster rows to id / name / email / role, dropping rows without an email', () => {
    const { members } = buildHookdeckMembers(membersRaw)

    expect(members).toHaveLength(3)
    expect(members[0]).toEqual({ id: 'omem_0001', name: 'Sample Owner', email: 'owner@example.test', role: 'owner' })
    expect(members[1]).toEqual({ id: 'omem_0002', name: 'Sample Admin', email: 'admin@example.test', role: 'admin' })
    // name omitted when user_name is absent.
    expect(members[2]).toEqual({ id: 'omem_0003', name: undefined, email: 'member@example.test', role: 'member' })
    expect(members.map((m) => m.role)).toEqual(['owner', 'admin', 'member'])
  })

  it('accepts the { data: [...] } envelope shape too', () => {
    const { members } = buildHookdeckMembers({ data: membersRaw })

    expect(members.map((m) => m.email)).toEqual(['owner@example.test', 'admin@example.test', 'member@example.test'])
  })

  it('falls back to user_id then the index when the membership id is missing', () => {
    const { members } = buildHookdeckMembers([
      { user_id: 'usr_fallback', role: 'member', user_email: 'a@example.test' },
      { role: 'viewer', user_email: 'b@example.test' }
    ])

    expect(members[0].id).toBe('usr_fallback')
    expect(members[1].id).toBe('1') // index fallback (the second row's position)
  })

  it('degrades safely on empty / nullish input', () => {
    expect(buildHookdeckMembers([]).members).toEqual([])
    expect(buildHookdeckMembers(null).members).toEqual([])
    expect(buildHookdeckMembers(undefined).members).toEqual([])
    expect(buildHookdeckMembers({}).members).toEqual([])
  })
})

// ── samples (demo seed) ─────────────────────────────────────────────────────────────────

// Each capability's `sample` runs through the SAME `build` the live collector uses; resolve the plugin's
// reporting currency first (core stamps it before persisting) so the contract validator sees money values.
const validateSample = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  validateCapabilityResult(resolveCurrencies(r, 'USD'))

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of hookdeckPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateSample(cap.sample!()), cap.id).toEqual([])
  }
})

describe('hookdeck plugin descriptor', () => {
  test('is well-formed with a teamId config field and summary+billing+usage+members tabs', () => {
    expect(hookdeckPlugin.meta.id).toBe('hookdeck')
    expect(hookdeckPlugin.auth.kind).toBe('cookie')
    expect(hookdeckPlugin.transport?.requiresBrowserEngine).toBeUndefined() // plain node, doesn't need the browser engine
    expect(hookdeckPlugin.transport?.defaultHeaders?.Origin).toBe('https://dashboard.hookdeck.com')
    expect(hookdeckPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'usage', 'members'])
  })

  // The team id is in no URL — it's auto-captured from the SPA's x-team-id request header, so the config
  // field is an optional override.
  test('auto-captures the team id from the x-team-id request header', () => {
    expect(hookdeckPlugin.session?.captureFromHeader).toContainEqual({
      header: 'x-team-id',
      storeAs: 'teamId',
      on: 'request'
    })
    expect(hookdeckPlugin.config?.fields.find((f) => f.key === 'teamId')?.required).toBeFalsy()
  })
})

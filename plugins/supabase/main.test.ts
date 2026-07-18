import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { expect, test } from 'vitest'

import {
  buildSupabaseBilling,
  buildSupabaseBillingTab,
  buildSupabaseMembers,
  buildSupabaseSummaryResult,
  buildSupabaseUsage,
  buildSupabaseUsageMetrics,
  buildSupabaseUsageResult,
  type RawInvoice,
  type RawMember,
  type RawOrg,
  type RawProjectList,
  type RawUpcomingInvoice,
  type RawUsage,
  supabasePlugin
} from './main.js'

// Resolve reporting currency (USD) onto every money value before validating — matches what core does before
// persisting, so the contract check sees the same shape the renderer draws.
const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of supabasePlugin.capabilities.filter((c) => c.sample)) {
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

// Synthetic fixtures matching the platform-API wire shapes (trimmed, fake org/refs/tokens). The
// invoice LIST is in CENTS; the upcoming invoice + per-metric cost are in DOLLARS.
const org: RawOrg = {
  slug: 'acmeorg',
  name: 'Acme',
  plan: { id: 'team', name: 'Team' },
  tier: 'tier_team',
  usage_billing_enabled: true
}

const invoices: RawInvoice[] = [
  {
    id: 'inv_0001',
    number: 'AAAA-00019',
    subtotal: 455408,
    amount_due: 455408,
    period_end: 1776211200, // 2026-04-15
    status: 'paid',
    invoice_pdf: 'https://assets.example.com/invoice/x/y?token=z',
    payment_is_processing: false
  },
  {
    id: 'inv_0002',
    number: 'AAAA-00020',
    subtotal: 453250,
    amount_due: 453250,
    period_end: 1778803200, // 2026-05-15
    status: 'paid',
    invoice_pdf: 'https://assets.example.com/invoice/a/b?token=c',
    payment_is_processing: false
  }
]

const upcoming: RawUpcomingInvoice = {
  amount_total: 4149.45,
  amount_projected: 4680.76,
  billing_cycle_start: '2026-05-15T00:00:00.000Z',
  billing_cycle_end: '2026-06-15T00:00:00.000Z',
  customer_balance: 0,
  currency: 'usd',
  lines: [
    { item_name: 'Team Plan', description: 'Team Plan', amount: 599, quantity: 1, usage_based: false },
    {
      item_name: 'Disk',
      description: 'Disk Size GP3 GB-Hrs',
      amount: 373.57,
      quantity: 2184615,
      unit_price_desc: '$0.000171 per unit',
      usage_based: true,
      usage_metric: 'DISK_SIZE_GB_HOURS_GP3'
    }
  ]
}

// ── billing ─────────────────────────────────────────────────────────────────────────

test('billing converts the invoice list from cents to dollars and sorts newest-first', () => {
  const r = buildSupabaseBilling(org, invoices, upcoming)

  expect(r.invoices.map((i) => i.number)).toEqual(['AAAA-00020', 'AAAA-00019'])
  expect(r.invoices[0]!.amount).toBe(4532.5)
  expect(r.invoices[0]!.amountDue).toBe(4532.5)
  expect(r.latestAmount).toBe(4532.5)
})

test('billing maps period_end (unix seconds) to YYYY-MM-DD and keeps the PDF link', () => {
  const r = buildSupabaseBilling(org, invoices, upcoming)
  const inv = r.invoices.find((i) => i.number === 'AAAA-00019')!

  expect(inv.date).toBe('2026-04-15')
  expect(inv.pdfUrl).toBe('https://assets.example.com/invoice/x/y?token=z')
})

test('billing keeps the upcoming invoice in dollars (no /100) and accrued total is the MTD', () => {
  const r = buildSupabaseBilling(org, invoices, upcoming)

  expect(r.upcoming!.amountTotal).toBe(4149.45)
  expect(r.currentMtd).toBe(4149.45)
  expect(r.upcoming!.amountProjected).toBe(4680.76)
  expect(r.upcoming!.cycleStart).toBe('2026-05-15')
  expect(r.upcoming!.cycleEnd).toBe('2026-06-15')
  expect(r.currency).toBe('USD')
  expect(r.upcoming!.lines).toHaveLength(2)
  expect(r.upcoming!.lines[0]).toMatchObject({ itemName: 'Team Plan', amount: 599, usageBased: false })
  expect(r.upcoming!.lines[1]).toMatchObject({ usageBased: true, usageMetric: 'DISK_SIZE_GB_HOURS_GP3' })
})

test('billing reads the plan summary from the matching org', () => {
  const r = buildSupabaseBilling(org, invoices, upcoming)

  expect(r.planName).toBe('Team')
  expect(r.tier).toBe('tier_team')
  expect(r.usageBillingEnabled).toBe(true)
})

test('billing flags an in-flight payment as processing', () => {
  const r = buildSupabaseBilling(org, [{ id: 'x', subtotal: 100, amount_due: 100, payment_is_processing: true }])

  expect(r.invoices[0]!.status).toBe('processing')
})

test('billing handles empty input', () => {
  const r = buildSupabaseBilling(undefined, [])

  expect(r.invoices).toEqual([])
  expect(r.latestAmount).toBe(0)
  expect(r.upcoming).toBeUndefined()
  expect(r.currentMtd).toBeNull()
  expect(r.planName).toBe('Unknown')
  expect(r.usageBillingEnabled).toBe(false)
})

test('summary is lean: spend.mtd + monthly spark, no detail tables', () => {
  const withMtd = buildSupabaseSummaryResult(buildSupabaseBilling(org, invoices, upcoming))

  expect(validateCapabilityResult(withMtd)).toEqual([])
  expect(withMtd.summaries?.[0]?.section).toBe('spend')
  expect(withMtd.summaries?.[0]?.basis).toBe('upcoming')
  expect(withMtd.summaries?.[0]?.value).toBe(4149.45)
  // The preset emits the monthly-spend spark from the invoice history.
  expect(withMtd.datasets.some((d) => d.id === 'monthly')).toBe(true)
  // No detail tables on Summary — those live on Billing.
  expect(withMtd.datasets.some((d) => d.id === 'invoices')).toBe(false)
  expect(withMtd.datasets.some((d) => d.id === 'upcoming')).toBe(false)

  // No upcoming invoice → currentMtd null → no money summary.
  const noMtd = buildSupabaseSummaryResult(buildSupabaseBilling(org, invoices))

  expect(noMtd.summaries).toBeUndefined()
})

test('billing tab is the detail: account record + line items + invoice file table, no spend.mtd', () => {
  const r = buildSupabaseBillingTab(buildSupabaseBilling(org, invoices, upcoming))

  expect(validateCapabilityResult(r)).toEqual([])
  // The subscription record, the in-progress line items, and the past-invoice receipts all surface.
  expect(r.datasets.some((d) => d.id === 'account' && d.shape === 'record')).toBe(true)
  expect(r.datasets.some((d) => d.id === 'upcoming' && d.shape === 'table')).toBe(true)
  expect(r.datasets.some((d) => d.id === 'invoices' && d.shape === 'table')).toBe(true)
  // Invoices accumulate on the raw Stripe id (threaded hidden); the in-progress line items don't (no key).
  expect((r.datasets.find((d) => d.id === 'invoices') as { key?: string }).key).toBe('id')
  expect((r.datasets.find((d) => d.id === 'upcoming') as { key?: string }).key).toBeUndefined()
  // Billing is the detail — it does NOT emit the Overview rollup.
  expect(r.summaries).toBeUndefined()

  // No upcoming invoice → no current-cycle line-items table (the account record still shows).
  const noUpcoming = buildSupabaseBillingTab(buildSupabaseBilling(org, invoices))

  expect(validateCapabilityResult(noUpcoming)).toEqual([])
  expect(noUpcoming.datasets.some((d) => d.id === 'upcoming')).toBe(false)
  expect(noUpcoming.datasets.some((d) => d.id === 'account')).toBe(true)
})

// ── usage ─────────────────────────────────────────────────────────────────────────

const usage: RawUsage = {
  usage_billing_enabled: true,
  usages: [
    {
      metric: 'COMPUTE_HOURS_8XL',
      usage: 720,
      cost: 1655.05,
      unit_price_desc: '$2.299 per hour',
      available_in_plan: true,
      capped: false,
      project_allocations: [{ name: 'tables-prod', ref: 'x', usage: 720 }]
    },
    {
      metric: 'FUNCTION_INVOCATIONS',
      usage: 38,
      cost: 0,
      unit_price_desc: '2 Million included, then $2 per Million invocations',
      available_in_plan: true,
      capped: false,
      project_allocations: []
    }
  ]
}

const projects: RawProjectList = {
  projects: [
    {
      name: 'documents-prod',
      ref: 'jveerogfzubknptlbwjg',
      region: 'us-east-1',
      status: 'ACTIVE_HEALTHY',
      cloud_provider: 'AWS',
      infra_compute_size: 'xlarge',
      disk_volume_size_gb: 8
    }
  ]
}

test('usage normalizes metrics, keeping cost in dollars and counting project allocations', () => {
  const r = buildSupabaseUsage(usage, projects)

  expect(r.usageBillingEnabled).toBe(true)
  const compute = r.metrics.find((m) => m.metric === 'COMPUTE_HOURS_8XL')!

  expect(compute).toMatchObject({ usage: 720, cost: 1655.05, availableInPlan: true, projectCount: 1 })
  expect(r.metrics.find((m) => m.metric === 'FUNCTION_INVOCATIONS')!.projectCount).toBe(0)
})

test('usage sums total cost across metrics (dollars)', () => {
  expect(buildSupabaseUsage(usage, projects).totalCost).toBe(1655.05)
})

test('usage maps the project inventory', () => {
  const r = buildSupabaseUsage(usage, projects)

  expect(r.projects).toHaveLength(1)
  expect(r.projects[0]).toMatchObject({
    name: 'documents-prod',
    region: 'us-east-1',
    status: 'ACTIVE_HEALTHY',
    computeSize: 'xlarge',
    diskGb: 8
  })
})

test('usage handles empty input', () => {
  const r = buildSupabaseUsage({}, {})

  expect(r.metrics).toEqual([])
  expect(r.projects).toEqual([])
  expect(r.totalCost).toBe(0)
  expect(r.usageBillingEnabled).toBe(false)
})

test('usage metrics carry cost only when nonzero (on-demand spend rolls up)', () => {
  const metrics = buildSupabaseUsageMetrics(buildSupabaseUsage(usage, projects))

  expect(metrics.find((m) => m.label === 'COMPUTE_HOURS_8XL')!.cost).toBe(1655.05)
  expect(metrics.find((m) => m.label === 'FUNCTION_INVOCATIONS')!.cost).toBeNull()

  const result = buildSupabaseUsageResult(buildSupabaseUsage(usage, projects))

  expect(result.summaries?.[0]?.section).toBe('other')
  expect(result.summaries?.[0]?.value).toBe(1655.05)
  expect(result.datasets.some((d) => d.id === 'projects' && d.shape === 'table')).toBe(true)
  // Projects accumulate on their immutable ref (threaded hidden) so a rename doesn't orphan history.
  expect((result.datasets.find((d) => d.id === 'projects') as { key?: string }).key).toBe('ref')
})

// ── members ─────────────────────────────────────────────────────────────────────────
// Synthetic roster — the `/platform/organizations/<slug>/members` shape (fake ids/names/emails).

const members: RawMember[] = [
  {
    user_id: 'usr_0001',
    gotrue_id: 'gt_0001',
    user_name: 'Ada Example',
    email: 'ada@example.com',
    role_name: 'owner'
  },
  {
    user_id: 'usr_0002',
    gotrue_id: 'gt_0002',
    user_name: 'Bo Example',
    email: 'bo@example.com',
    role_name: 'member'
  }
]

test('members maps name/email/role and prefers gotrue_id for the stable id', () => {
  const r = buildSupabaseMembers(members)

  expect(r.members).toHaveLength(2)
  expect(r.members[0]).toEqual({ id: 'gt_0001', name: 'Ada Example', email: 'ada@example.com', role: 'owner' })
  expect(r.members[1]).toMatchObject({ id: 'gt_0002', role: 'member' })
})

test('members falls back to user_id then index when gotrue_id is absent', () => {
  const r = buildSupabaseMembers([{ user_id: 'usr_x', email: 'x@example.com' }, { email: 'y@example.com' }])

  expect(r.members[0]!.id).toBe('usr_x')
  expect(r.members[1]!.id).toBe('1')
})

test('members handles empty input', () => {
  expect(buildSupabaseMembers([]).members).toEqual([])
  expect(buildSupabaseMembers(undefined).members).toEqual([])
})

// ── descriptor ──────────────────────────────────────────────────────────────────────

test('supabase plugin is well-formed (spa-bearer + node summary/billing/usage/members)', () => {
  expect(supabasePlugin.meta.id).toBe('supabase')
  const { auth } = supabasePlugin

  expect(auth.kind).toBe('spa-bearer')

  if (auth.kind === 'spa-bearer') {
    expect(auth.authCaptureUrlPatterns).toContain('https://api.supabase.com/*')
  }

  expect(supabasePlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'usage', 'members'])
})

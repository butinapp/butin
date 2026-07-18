import type { CollectContext } from '@butinapp/sdk'
import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { expect, test } from 'vitest'

import {
  buildGreptileBilling,
  buildGreptileBillingTab,
  buildGreptileKeys,
  buildGreptileMembers,
  buildGreptileMembersResult,
  buildGreptileOrgOptions,
  buildGreptileSummaryResult,
  buildGreptileUsage,
  buildGreptileUsageResult,
  fetchGreptileBilling,
  fetchGreptileOrgs,
  greptilePlugin,
  parseStripeHostedInvoice,
  type GreptileConfig,
  type PeriodWithInvoice,
  type RawBillingPeriod
} from './main.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of greptilePlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

// All fixtures below are SYNTHETIC — invented periods, amounts, author logins, and a placeholder tenant
// UUID. No real org ids, emails, or names. Money is asserted in DOLLARS (the source reports cents).

// ── descriptor ──────────────────────────────────────────────────────────────────────

test('greptile is a plain cookie session over node transport (Vercel edge, not Cloudflare)', () => {
  expect(greptilePlugin.auth.kind).toBe('cookie')
  expect(greptilePlugin.transport?.requiresBrowserEngine).toBeUndefined()
  expect(greptilePlugin.transport?.engine).toBeUndefined() // defaults to node
  expect(greptilePlugin.session?.cookieDomains).toContain('greptile.com')
  expect(greptilePlugin.session?.requiredCookie).toBe('__Secure-authjs.session-token.0')
})

test('tenantExternalId is a required org-picker combobox with a loadOptions fetcher', () => {
  const field = greptilePlugin.config?.fields.find((f) => f.key === 'tenantExternalId')

  expect(field).toMatchObject({ kind: 'combobox', required: true })
  expect(typeof field?.loadOptions).toBe('function')
})

test('greptile ships summary, billing, usage, apiKeys, and members (summary + billing lead)', () => {
  expect(greptilePlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'usage', 'apiKeys', 'members'])
})

// ── org picker ────────────────────────────────────────────────────────────────────────

test('buildGreptileOrgOptions maps session orgs to picker options, recommends the first only with a choice', () => {
  const single = buildGreptileOrgOptions([{ tenantExternalId: 'tnt-1', name: 'Acme', slug: 'acme' }])

  expect(single).toEqual([{ value: 'tnt-1', label: 'Acme', description: 'acme', recommended: false }])

  const many = buildGreptileOrgOptions([
    { tenantExternalId: 'tnt-1', name: 'Acme', slug: 'acme' },
    { tenantExternalId: 'tnt-2', name: '  ', slug: 'umbrella' }, // blank name → falls back to slug label
    { name: 'No Tenant' } // no tenantExternalId → dropped
  ])

  expect(many).toEqual([
    { value: 'tnt-1', label: 'Acme', description: 'acme', recommended: true },
    { value: 'tnt-2', label: 'umbrella', description: 'umbrella', recommended: false }
  ])
})

// A getter typed like the authed `client.get` (generic <T>) — needed so the fixed-shape mocks satisfy it.
const getterReturning = (value: unknown) => (async () => value) as <T>(url: string) => Promise<T>

test('fetchGreptileOrgs reads user.organizations and degrades to [] on missing payload / error', async () => {
  const orgs = await fetchGreptileOrgs(getterReturning({ user: { organizations: [{ tenantExternalId: 'tnt-1' }] } }))

  expect(orgs).toEqual([{ tenantExternalId: 'tnt-1' }])

  expect(await fetchGreptileOrgs(getterReturning({}))).toEqual([])
  expect(
    await fetchGreptileOrgs((async () => {
      throw new Error('401')
    }) as <T>(url: string) => Promise<T>)
  ).toEqual([])
})

// ── billing ───────────────────────────────────────────────────────────────────────────

const SYNTH_PERIODS: PeriodWithInvoice[] = [
  {
    id: 'open',
    startTime: '2026-05-05T00:00:00Z',
    period: { startTime: '2026-05-05T00:00:00Z', endTime: '2026-06-05T00:00:00Z', label: 'May–Jun', invoiceId: null },
    invoice: null
  },
  {
    id: 'in_001',
    startTime: '2026-04-05T00:00:00Z',
    period: {
      startTime: '2026-04-05T00:00:00Z',
      endTime: '2026-05-05T00:00:00Z',
      label: 'Apr–May',
      invoiceId: 'in_001'
    },
    invoice: {
      periodStart: '2026-04-05T00:00:00Z',
      total: 12_345, // cents → $123.45
      currency: 'usd',
      status: 'paid',
      hostedInvoiceUrl: 'https://invoice.stripe.com/i/acct_test/inv_test',
      lines: [{ description: 'Seats', amount: 10_000 }]
    }
  }
]

const SYNTH_SUB = {
  codeReview: {
    model: 'metered',
    status: 'active',
    seatPriceCents: 3000,
    overagePriceCents: 50,
    includedReviewsPerDev: 100,
    periodStart: '2026-05-05T00:00:00Z',
    periodEnd: '2026-06-05T00:00:00Z'
  }
}

const SYNTH_COSTS = {
  codeReview: { totalCents: 9000, seatCostCents: 6000, overageCostCents: 3000, activeDevs: 2, overageCount: 60 },
  api: { totalCents: 500 }
}

const SYNTH_FLEX = {
  creditBalanceCents: 2500,
  currentPeriodStart: '2026-05-05T00:00:00Z',
  currentPeriodEnd: '2026-06-05T00:00:00Z',
  flexUsageReviewCount: 60,
  projectedNetFlexUsageChargeCents: 3000
}

test('billing normalizes cents→dollars, synthesizes the open-period projection, sorts newest-first', () => {
  const b = buildGreptileBilling(SYNTH_PERIODS, SYNTH_SUB, SYNTH_COSTS, SYNTH_FLEX)

  // subscription money in dollars
  expect(b.subscription.seatPriceUsd).toBe(30)
  expect(b.subscription.seatCostUsd).toBe(60)
  expect(b.subscription.overageCostUsd).toBe(30)
  expect(b.subscription.apiCostUsd).toBe(5)
  // currentTotal = codeReview.total ($90) + api.total ($5)
  expect(b.subscription.currentTotalUsd).toBe(95)
  expect(b.subscription.creditBalanceUsd).toBe(25)

  // newest-first: open projection (May–Jun) then the finalized April invoice
  expect(b.invoices[0]).toMatchObject({ projected: true, status: 'upcoming', amount: 95, date: '2026-05-05' })
  expect(b.invoices[1]).toMatchObject({ projected: false, status: 'paid', amount: 123.45, date: '2026-04-05' })
  expect(b.invoices[1].hostedUrl).toBe('https://invoice.stripe.com/i/acct_test/inv_test')

  // totalBilled excludes the projection
  expect(b.totalBilled).toBe(123.45)
})

test('billing tolerates fully-empty input with safe defaults', () => {
  const b = buildGreptileBilling(null, null, null, null)

  expect(b.invoices).toEqual([])
  expect(b.totalBilled).toBe(0)
  expect(b.subscription.currentTotalUsd).toBe(0)
})

test('Summary is LEAN: spend.mtd + monthly spark, headline stats, NO detail tables/records', () => {
  const withSpend = buildGreptileSummaryResult(buildGreptileBilling(SYNTH_PERIODS, SYNTH_SUB, SYNTH_COSTS, SYNTH_FLEX))

  expect(validateCapabilityResult(withSpend)).toEqual([])
  expect(withSpend.summaries?.[0]).toMatchObject({
    section: 'spend',
    value: 95,
    basis: 'accrued',
    spark: { dataset: 'monthly' }
  })
  // no Billing-detail records/tables bleed into the Summary (the preset's own headline stat dataset stays)
  const summaryIds = withSpend.datasets.map((d) => d.id)

  expect(summaryIds).not.toContain('paymentMethod')
  expect(summaryIds).not.toContain('billingContact')
  expect(summaryIds).not.toContain('invoices')

  // spend.mtd stays present (value 0) even with no open period, so the service isn't dropped from the Overview
  const noSpend = buildGreptileSummaryResult(buildGreptileBilling(null, null, null, null))

  expect(validateCapabilityResult(noSpend)).toEqual([])
  expect(noSpend.summaries?.[0]).toMatchObject({ section: 'spend', value: 0 })
})

test('Billing detail: subscription record + url-column invoice table, NO spend.mtd, optional pm/contact', () => {
  const billing = buildGreptileBilling(SYNTH_PERIODS, SYNTH_SUB, SYNTH_COSTS, SYNTH_FLEX)
  const result = buildGreptileBillingTab(billing, {
    paymentMethod: { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2029, funding: 'credit' },
    contact: { name: 'Test Person', email: 'test@example.com' }
  })

  expect(validateCapabilityResult(result)).toEqual([])
  // Billing owns the detail, never the rollup
  expect(result.summaries).toBeUndefined()
  expect(result.datasets.some((d) => d.id === 'account')).toBe(true)
  expect(result.datasets.some((d) => d.id === 'paymentMethod')).toBe(true)
  expect(result.datasets.some((d) => d.id === 'billingContact')).toBe(true)
  expect(result.datasets.some((d) => d.id === 'invoices')).toBe(true)

  // the invoice list is a plain table with a `url` column (hostedInvoiceUrl only, no PDF byte source)
  const invoices = result.datasets.find((d) => d.id === 'invoices') as unknown as {
    key?: string
    rows: { id: string; hostedUrl: string | null }[]
    columns: { key: string; role: string }[]
  }

  expect(invoices.columns.find((c) => c.key === 'hostedUrl')?.role).toBe('url')
  // keyed by the Stripe invoice id (present on every finalized period) so it accumulates in the ledger
  expect(invoices.key).toBe('id')
  // only the finalized April invoice — the open projection is dropped from the detail list
  expect(invoices.rows).toHaveLength(1)
  expect(invoices.rows[0].id).toBe('in_001')
  expect(invoices.rows[0].hostedUrl).toBe('https://invoice.stripe.com/i/acct_test/inv_test')

  const pm = result.datasets.find((d) => d.id === 'paymentMethod') as unknown as { value: Record<string, unknown> }

  expect(pm.value).toMatchObject({ brand: 'visa', last4: '4242', expiry: '08/2029', funding: 'credit' })

  // no payment → the account record + invoices stand alone, no pm/contact records
  const bare = buildGreptileBillingTab(billing, null)

  expect(validateCapabilityResult(bare)).toEqual([])
  expect(bare.datasets.some((d) => d.id === 'paymentMethod')).toBe(false)
  expect(bare.datasets.some((d) => d.id === 'billingContact')).toBe(false)
  expect(bare.datasets.some((d) => d.id === 'account')).toBe(true)

  // no invoices at all → the invoice table is dropped
  const empty = buildGreptileBillingTab(buildGreptileBilling(null, null, null, null), null)

  expect(validateCapabilityResult(empty)).toEqual([])
  expect(empty.datasets.some((d) => d.id === 'invoices')).toBe(false)
})

// ── billing: incremental fetch (ctx.since skips re-fetching stored finalized periods) ──

// A minimal `ctx.client.get` that decodes the batched tRPC URL back into `{ proc, json }` and answers by proc
// name, so the test can assert exactly which `invoiceId`s `fetchGreptileBilling` asked `getUpcomingInvoice` for.
const makeGreptileCtx = (
  periods: RawBillingPeriod[],
  since?: string
): { ctx: CollectContext<GreptileConfig>; invoiceCalls: string[] } => {
  const invoiceCalls: string[] = []
  const client = {
    get: async <T>(url: string): Promise<T> => {
      const proc = url.split('/api/trpc/')[1]?.split('?')[0]
      const input = JSON.parse(decodeURIComponent(url.split('input=')[1] ?? '')) as {
        '0': { json: Record<string, unknown> }
      }

      if (proc === 'billing.getCodeReviewBillingPeriods') {
        return [{ result: { data: { json: periods } } }] as unknown as T
      }

      if (proc === 'billing.getUpcomingInvoice') {
        invoiceCalls.push(input['0'].json.invoiceId as string)

        return [{ result: { data: { json: { total: 1000, status: 'paid' } } } }] as unknown as T
      }

      // getSubscriptionInfo / getCurrentPeriodCosts / getFlexUsageStatus — irrelevant to this test
      return [{ result: { data: { json: {} } } }] as unknown as T
    }
  }

  return {
    ctx: { client, since, config: { tenantExternalId: 'tnt-1' } } as unknown as CollectContext<GreptileConfig>,
    invoiceCalls
  }
}

const RAW_PERIODS: RawBillingPeriod[] = [
  { startTime: '2026-06-05T00:00:00Z', endTime: '2026-07-05T00:00:00Z', label: 'Jun–Jul', invoiceId: null }, // open
  { startTime: '2026-05-05T00:00:00Z', endTime: '2026-06-05T00:00:00Z', label: 'May–Jun', invoiceId: 'in_recent' },
  { startTime: '2026-01-05T00:00:00Z', endTime: '2026-02-05T00:00:00Z', label: 'Jan–Feb', invoiceId: 'in_old' }
]

test('fetchGreptileBilling honours ctx.since: skips invoices for stored finalized periods, keeps the open one', async () => {
  const { ctx, invoiceCalls } = makeGreptileCtx(RAW_PERIODS, '2026-04-01')
  const raw = await fetchGreptileBilling(ctx)

  // the old finalized period (Jan–Feb) is never re-fetched — its stored invoice is preserved by the union
  expect(invoiceCalls).toEqual(['in_recent'])
  // omitted from the result entirely (not returned with invoice: null, which would overwrite the stored invoice)
  expect(raw.periods.map((p) => p.id)).toEqual(['open', 'in_recent'])
  expect(raw.periods.every((p) => typeof p.startTime === 'string')).toBe(true)
})

test('control: fetchGreptileBilling with no since fetches and returns every period', async () => {
  const { ctx, invoiceCalls } = makeGreptileCtx(RAW_PERIODS)
  const raw = await fetchGreptileBilling(ctx)

  expect(invoiceCalls.sort()).toEqual(['in_old', 'in_recent'])
  expect(raw.periods.map((p) => p.id)).toEqual(['open', 'in_recent', 'in_old'])
})

// The invoice-less current period's union id must be a CONSTANT ('open'), not `open:<startTime>` — else, when it
// finalizes at month rollover (same startTime, now carrying an invoiceId), the service never re-emits the old
// `open:<startTime>` key, core's union RETAINS it forever, and it renders as a phantom second "Current period" row.
test('the open period unions onto a CONSTANT id so it reuses its slot across a month rollover', async () => {
  const OPEN_START = '2026-06-05T00:00:00Z'
  const NEXT_START = '2026-07-05T00:00:00Z'

  // Before rollover: only the current, invoice-less period exists.
  const { ctx: ctxBefore } = makeGreptileCtx([
    { startTime: OPEN_START, endTime: NEXT_START, label: 'Jun–Jul', invoiceId: null }
  ])
  const before = await fetchGreptileBilling(ctxBefore)

  expect(before.periods.map((p) => p.id)).toEqual(['open'])

  // After rollover: that same period now carries an invoiceId (finalized), and a NEW invoice-less period opens.
  const { ctx: ctxAfter } = makeGreptileCtx([
    { startTime: NEXT_START, endTime: '2026-08-05T00:00:00Z', label: 'Jul–Aug', invoiceId: null },
    { startTime: OPEN_START, endTime: NEXT_START, label: 'Jun–Jul', invoiceId: 'in_jun' }
  ])
  const after = await fetchGreptileBilling(ctxAfter)

  expect(after.periods.map((p) => p.id)).toEqual(['open', 'in_jun'])

  // Merging the two fetches by id (as core's raw union does) must settle at exactly 2 rows: the finalized period
  // under its own invoiceId, and the NEW current period reusing the 'open' slot — no orphaned stale 'open' row.
  const union = new Map(before.periods.map((p) => [p.id, p] as const))

  for (const p of after.periods) {
    union.set(p.id, p)
  }

  expect(union.size).toBe(2)
  expect(union.get('open')?.startTime).toBe(NEXT_START)
  expect(union.get('in_jun')?.startTime).toBe(OPEN_START)
})

test('billing capability declares incremental fetch keyed on the top-level periods list', () => {
  const cap = greptilePlugin.capabilities.find((c) => c.id === 'billing')

  expect(cap?.incremental).toMatchObject({ listKey: 'periods', id: 'id', timestamp: 'startTime' })
  expect(greptilePlugin.capabilities.find((c) => c.id === 'summary')?.incremental).toBeUndefined()
})

// ── billing: Stripe payment-method parse (live-only walk; pure parse fixture-tested) ───

test('parseStripeHostedInvoice reads the card + contact from the payment intent', () => {
  const parsed = parseStripeHostedInvoice({
    customer_name: 'Test Person',
    customer_email: 'test@example.com',
    payment_intent: {
      payment_method: {
        type: 'card',
        card: { brand: 'mastercard', last4: '4444', exp_month: 1, exp_year: 2030, funding: 'debit' }
      }
    }
  })

  expect(parsed.paymentMethod).toMatchObject({
    brand: 'mastercard',
    last4: '4444',
    expMonth: 1,
    expYear: 2030,
    funding: 'debit'
  })
  expect(parsed.contact).toEqual({ name: 'Test Person', email: 'test@example.com' })
})

test('parseStripeHostedInvoice falls back to the payments array and degrades to null', () => {
  const fromArray = parseStripeHostedInvoice({
    payments_array: [
      { payment_intent_client: { payment_method: { type: 'card', card: { display_brand: 'amex', last4: '0005' } } } }
    ]
  })

  expect(fromArray.paymentMethod).toMatchObject({ brand: 'amex', last4: '0005' })
  expect(fromArray.contact).toBeNull()

  expect(parseStripeHostedInvoice(null)).toEqual({ paymentMethod: null, contact: null })
  expect(parseStripeHostedInvoice({}).paymentMethod).toBeNull()
})

// ── usage ───────────────────────────────────────────────────────────────────────────

const SYNTH_DAILY = {
  daily: [
    { date: '2026-05-07T00:00:00Z', codeReview: 5, cliReview: 2 },
    { date: '2026-05-06T00:00:00Z', codeReview: 3, cliReview: 1 },
    { codeReview: 9, cliReview: 9 } // undated → dropped
  ],
  authors: [
    {
      authorLogin: 'reviewer-a',
      webReviewCount: 6,
      webFlexCount: 1,
      cliReviewCount: 2,
      cliFlexCount: 0,
      seatPeriods: 1
    },
    { webReviewCount: 1, cliReviewCount: 1 } // no login → '(unknown)'
  ]
}

test('usage maps daily points (drops undated, sorts oldest→newest) + per-author totals', () => {
  const u = buildGreptileUsage(SYNTH_DAILY, SYNTH_FLEX)

  expect(u.daily.map((d) => d.date)).toEqual(['2026-05-06', '2026-05-07'])
  expect(u.totalCodeReviews).toBe(8) // 3 + 5
  expect(u.totalCliReviews).toBe(3) // 1 + 2

  expect(u.authors[0]).toMatchObject({ login: 'reviewer-a', totalReviews: 8, totalFlex: 1, seats: 1 })
  expect(u.authors[1].login).toBe('(unknown)')

  // projected overage charge: 3000 cents → $30
  expect(u.projectedFlexChargeUsd).toBe(30)
  expect(u.flexUsageReviewCount).toBe(60)
  expect(u.periodStart).toBe('2026-05-05')
})

test('usage tolerates empty input', () => {
  const u = buildGreptileUsage(null, null)

  expect(u.daily).toEqual([])
  expect(u.authors).toEqual([])
  expect(u.totalCodeReviews).toBe(0)
  expect(u.projectedFlexChargeUsd).toBe(0)
})

test('usageResult is valid, appends a daily timeseries + author table, emits usage.primary from the flex cost', () => {
  const result = buildGreptileUsageResult(buildGreptileUsage(SYNTH_DAILY, SYNTH_FLEX))

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.datasets.some((d) => d.id === 'daily')).toBe(true)
  expect(result.datasets.some((d) => d.id === 'authors')).toBe(true)
  // daily accumulates keyed by day, authors keyed by login
  const daily = result.datasets.find((d) => d.id === 'daily')
  const authors = result.datasets.find((d) => d.id === 'authors')

  expect(daily?.shape === 'table' && daily.key).toBe('date')
  expect(authors?.shape === 'table' && authors.key).toBe('login')
  expect(result.views?.some((v) => v.type === 'timeseries' && v.dataset === 'daily')).toBe(true)
  expect(result.views?.some((v) => v.type === 'table' && v.dataset === 'authors')).toBe(true)
  // the projected flex charge gives the usage a money summary
  expect(result.summaries?.[0]).toMatchObject({ section: 'other', value: 30 })

  // empty usage: still valid, no daily/author datasets
  const empty = buildGreptileUsageResult(buildGreptileUsage(null, null))

  expect(validateCapabilityResult(empty)).toEqual([])
  expect(empty.datasets.some((d) => d.id === 'daily')).toBe(false)
  expect(empty.datasets.some((d) => d.id === 'authors')).toBe(false)
})

// ── apiKeys ───────────────────────────────────────────────────────────────────────────

test('apiKeys lists name / id / created with no secret material, defaults unnamed', () => {
  const r = buildGreptileKeys({
    items: [
      { id: 'key_1', name: 'ci', createdAt: '2026-01-02T00:00:00Z' },
      { id: 'key_2', createdAt: '2026-02-01T00:00:00Z' }
    ],
    total: 2
  })

  expect(r.keys[0]).toMatchObject({ id: 'key_1', name: 'ci', createdAt: '2026-01-02T00:00:00Z' })
  expect(r.keys[1].name).toBe('(unnamed)')
  // no masked secret field — the listing exposes none
  expect(r.keys[0].masked).toBeUndefined()
  expect(buildGreptileKeys(null).keys).toEqual([])
})

// ── members ───────────────────────────────────────────────────────────────────────────

test('members derives active/pending status from type, sorts members before invites, drops emailless rows', () => {
  const m = buildGreptileMembers({
    items: [
      { type: 'invite', email: 'invited@example.com', role: 'Member' }, // pending
      { type: 'member', email: 'reviewer@example.com', role: 'Admin' },
      { type: 'member', email: 'aaa@example.com', role: 'Member' },
      { type: 'member' } // no email → dropped
    ]
  })

  // members (alphabetical) first, then the pending invite
  expect(m.map((x) => x.email)).toEqual(['aaa@example.com', 'reviewer@example.com', 'invited@example.com'])
  expect(m[0]).toMatchObject({ role: 'Member', status: 'active' })
  expect(m[1]).toMatchObject({ role: 'Admin', status: 'active' })
  expect(m[2]).toMatchObject({ role: 'Member', status: 'pending' })

  expect(buildGreptileMembers(null)).toEqual([])
})

test('membersResult is a valid keyed email/role/status table with no summary', () => {
  const result = buildGreptileMembersResult(
    buildGreptileMembers({ items: [{ type: 'member', email: 'a@example.com', role: 'Admin' }] })
  )

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries).toBeUndefined()

  const ds = result.datasets.find((d) => d.id === 'members') as unknown as { key?: string; columns: { key: string }[] }

  expect(ds.key).toBe('email')
  expect(ds.columns.map((c) => c.key)).toEqual(['email', 'role', 'status'])
})

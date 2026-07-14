import { resolveCurrencies, validateCapabilityResult } from '@butinapp/sdk/data'
import type { RawStripeInvoiceList } from '@butinapp/sdk/integrations'
import { describe, expect, it, test } from 'vitest'

import {
  buildBillingReport,
  buildDepotBillingTab,
  buildDepotMembers,
  buildDepotSummaryResult,
  buildDepotUsage,
  buildDepotUsageResult,
  depotPlugin,
  extractMembersFromLoader,
  extractUsageFromLoader,
  type RawStripeSubscriptionsList
} from './main.js'

// Every capability's sample, drawn through its build, must satisfy the data-view contract once the plugin's
// USD reporting currency is stamped onto each money value (the demo seed's contract test).
const sampleIsValid = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  validateCapabilityResult(resolveCurrencies(r, 'USD'))

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of depotPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(sampleIsValid(cap.sample!()), cap.id).toEqual([])
  }
})

// ── descriptor ──────────────────────────────────────────────────────────────────────────

test('depot plugin is well-formed', () => {
  expect(depotPlugin.meta.id).toBe('depot')
  expect(depotPlugin.auth.kind).toBe('cookie')
  expect(depotPlugin.session?.requiredCookie).toBe('depot-session')
  expect(depotPlugin.transport?.baseUrl).toBe('https://depot.dev')
  // orgSlug is a required config field — paths key off it; the dashboard URL prefills it best-effort.
  expect(depotPlugin.config?.fields.find((f) => f.key === 'orgSlug')?.required).toBe(true)
  expect(depotPlugin.session?.captureFromUrl).toContainEqual({ pattern: '/orgs/([^/?#]+)', storeAs: 'orgSlug' })
  expect(depotPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'usage', 'members'])
})

// ── usage ─────────────────────────────────────────────────────────────────────────────

describe('buildDepotUsage', () => {
  it('maps minutes/GB and sums totalMinutes', () => {
    expect(
      buildDepotUsage({
        currentCacheUsage: 173,
        currentRemoteCacheSize: 344,
        buildMinutes: 8381,
        jobMinutes: 110766,
        ciMinutes: 0
      })
    ).toEqual({
      buildMinutes: 8381,
      jobMinutes: 110766,
      ciMinutes: 0,
      totalMinutes: 119147,
      layerCacheGb: 173,
      remoteCacheGb: 344
    })
  })

  it('defaults every field to 0 on an empty/nullish payload', () => {
    const zero = { buildMinutes: 0, jobMinutes: 0, ciMinutes: 0, totalMinutes: 0, layerCacheGb: 0, remoteCacheGb: 0 }

    expect(buildDepotUsage({})).toEqual(zero)
    expect(buildDepotUsage(null)).toEqual(zero)
    expect(buildDepotUsage(undefined)).toEqual(zero)
  })
})

describe('buildDepotUsageResult', () => {
  it('emits a metric per lane + cache, no money summary (counts only)', () => {
    const result = buildDepotUsageResult(
      buildDepotUsage({
        buildMinutes: 10,
        jobMinutes: 20,
        ciMinutes: 5,
        currentCacheUsage: 2,
        currentRemoteCacheSize: 3
      })
    )
    const metrics = result.datasets.find((d) => d.id === 'metrics')

    expect(metrics?.shape).toBe('table')

    if (metrics?.shape === 'table') {
      expect(metrics.rows.map((r) => [r.label, r.value, r.unit])).toEqual([
        ['Build minutes', 10, 'min'],
        ['Job minutes', 20, 'min'],
        ['CI minutes', 5, 'min'],
        ['Layer cache', 2, 'GB'],
        ['Remote build cache', 3, 'GB']
      ])
    }

    // No metric carries a cost → no money summary.
    expect(result.summaries).toBeUndefined()
  })
})

// The settings/usage loader as a Remix single-flight turbo-stream (index-encoded), synthetic numbers.
// payload[0] is the root map (`_<n>` keys naming themselves via payload[n]); the `currentUsageData` object
// carries the usage fields by index.
describe('extractUsageFromLoader', () => {
  const flight = JSON.stringify([
    { _1: 2 }, // payload[0]: root map → key payload[1] = 'data', value payload[2]
    'data', // payload[1]
    { _3: 4 }, // payload[2]: { currentUsageData: payload[4] }
    'currentUsageData', // payload[3]
    { _5: 6, _7: 8, _9: 10, _11: 12, _13: 14 }, // payload[4]: the usage object
    'buildMinutes', // 5
    1234, // 6
    'jobMinutes', // 7
    5678, // 8
    'ciMinutes', // 9
    0, // 10
    'currentCacheUsage', // 11
    50, // 12
    'currentRemoteCacheSize', // 13
    99 // 14
  ])

  it('walks the index-encoded tree to the usage object', () => {
    expect(extractUsageFromLoader(flight)).toMatchObject({
      buildMinutes: 1234,
      jobMinutes: 5678,
      ciMinutes: 0,
      currentCacheUsage: 50,
      currentRemoteCacheSize: 99
    })
  })

  it('parses a line-prefixed ("1:[…]") flight body', () => {
    expect(extractUsageFromLoader(`1:${flight}`)).toMatchObject({ buildMinutes: 1234, jobMinutes: 5678 })
  })

  it('returns {} on unparseable or usage-less input', () => {
    expect(extractUsageFromLoader('<html>not flight data</html>')).toEqual({})
    expect(extractUsageFromLoader(JSON.stringify([{ _1: 2 }, 'foo', 'bar']))).toEqual({})
  })

  it('round-trips through buildDepotUsage', () => {
    expect(buildDepotUsage(extractUsageFromLoader(flight))).toEqual({
      buildMinutes: 1234,
      jobMinutes: 5678,
      ciMinutes: 0,
      totalMinutes: 6912,
      layerCacheGb: 50,
      remoteCacheGb: 99
    })
  })
})

// ── members ─────────────────────────────────────────────────────────────────────────────

describe('buildDepotMembers', () => {
  it('merges active users + pending invites, deriving role from owner/admin flags', () => {
    const { members } = buildDepotMembers({
      users: [
        { userID: 'u_1', name: 'Ada Member', email: 'ada@example.test', isOwner: true },
        { userID: 'u_2', name: 'Bo Member', email: 'bo@example.test', isAdmin: true },
        { userID: 'u_3', name: 'Cy Member', email: 'cy@example.test', role: 'member' }
      ],
      invites: [{ id: 'inv_1', email: 'dee@example.test', role: 'admin' }]
    })

    expect(members).toEqual([
      { id: 'u_1', name: 'Ada Member', email: 'ada@example.test', role: 'owner' },
      { id: 'u_2', name: 'Bo Member', email: 'bo@example.test', role: 'admin' },
      { id: 'u_3', name: 'Cy Member', email: 'cy@example.test', role: 'member' },
      { id: 'inv_1', name: undefined, email: 'dee@example.test', role: 'admin (pending)' }
    ])
  })

  it('falls back to email/index ids and defaults a role-less user to member', () => {
    const { members } = buildDepotMembers({
      users: [{ email: 'eve@example.test' }, { name: 'Anon' }]
    })

    expect(members).toEqual([
      { id: 'eve@example.test', name: undefined, email: 'eve@example.test', role: 'member' },
      { id: 'user-1', name: 'Anon', email: undefined, role: 'member' }
    ])
  })

  it('returns an empty roster on empty/nullish input', () => {
    expect(buildDepotMembers({}).members).toEqual([])
    expect(buildDepotMembers(null).members).toEqual([])
    expect(buildDepotMembers(undefined).members).toEqual([])
  })
})

// The settings loader as a Remix single-flight turbo-stream (index-encoded), synthetic members. payload[0]
// is the root map; the `{ users, invites }` node carries the roster by index.
describe('extractMembersFromLoader', () => {
  const flight = JSON.stringify([
    { _1: 2 }, // payload[0]: root map → key payload[1] = 'data', value payload[2]
    'data', // 1
    { _3: 4, _13: 14 }, // 2: { users: payload[4], invites: payload[14] }
    'users', // 3
    [5], // 4: [ payload[5] ]
    { _6: 7, _8: 9, _10: 11, _12: -2 }, // 5: one user
    'userID', // 6
    'u_1', // 7
    'email', // 8
    'ada@example.test', // 9
    'isOwner', // 10
    true, // 11
    'name', // 12 (value -2 → null)
    'invites', // 13
    [] // 14: no invites
  ])

  it('walks the index-encoded tree to the { users, invites } node', () => {
    expect(extractMembersFromLoader(flight)).toMatchObject({
      users: [{ userID: 'u_1', email: 'ada@example.test', isOwner: true }],
      invites: []
    })
  })

  it('returns {} on unparseable or roster-less input', () => {
    expect(extractMembersFromLoader('<html>not flight data</html>')).toEqual({})
    expect(extractMembersFromLoader(JSON.stringify([{ _1: 2 }, 'foo', 'bar']))).toEqual({})
  })

  it('round-trips through buildDepotMembers', () => {
    const { members } = buildDepotMembers(extractMembersFromLoader(flight))

    expect(members).toEqual([{ id: 'u_1', name: undefined, email: 'ada@example.test', role: 'owner' }])
  })
})

// ── billing (Summary + Billing share the report; the live walk degrades to empty on failure — see main.ts) ──

// Stripe invoice-list shape (amounts in CENTS); synthetic ids/numbers.
const list: RawStripeInvoiceList = {
  has_more: true,
  data: [
    {
      id: 'in_TEST1',
      number: 'INV-0003',
      status: 'paid',
      total: 135455,
      amount_due: 135455,
      amount_paid: 135455,
      currency: 'usd',
      effective_at: 1780303024,
      finalized_at: 1780303024,
      hosted_invoice_url: 'https://invoice.stripe.com/i/acct_TEST/live_abc',
      lines: {
        data: [
          { amount: 20000, description: '1 × Startup plan (at $200.00 / month)', short_description: 'Startup plan' },
          { amount: 36052, description: '9013 minute × Build Minutes', short_description: 'Build Minutes' }
        ]
      }
    },
    {
      id: 'in_TEST2',
      status: 'open',
      amount_due: 395539,
      currency: 'usd',
      created: 1777624748,
      lines: { data: [] }
    }
  ]
}

const CURRENT_PERIOD_END = 1782891200 // → 2026-07-01 (UTC)
const subs: RawStripeSubscriptionsList = {
  data: [
    {
      current_period_end: CURRENT_PERIOD_END,
      items: [
        {
          price_details: {
            unit_amount: 20000,
            recurring: { usage_type: 'licensed' },
            product: { name: 'Startup plan' }
          }
        },
        { price_details: { recurring: { usage_type: 'metered' }, product: { name: 'Build Minutes' } } }
      ],
      upcoming_invoice: {
        created: CURRENT_PERIOD_END,
        total: 75222,
        amount_due: 75222,
        lines: {
          data: [
            // next-period licensed base plan ($200) — period ends LATER, excluded from metered MTD
            { amount: 20000, period: { start: CURRENT_PERIOD_END, end: 1785569600 } },
            // current-period metered usage ($552.22 total) — period ends at CURRENT_PERIOD_END
            { amount: 13524, period: { start: 1780299200, end: CURRENT_PERIOD_END } },
            { amount: 5400, period: { start: 1780299200, end: CURRENT_PERIOD_END } },
            { amount: 36298, period: { start: 1780299200, end: CURRENT_PERIOD_END } }
          ]
        }
      }
    }
  ]
}

describe('buildBillingReport', () => {
  it('normalizes invoices (cents → dollars, unix → ISO date) and sums totalBilled', () => {
    const report = buildBillingReport(list)

    expect(report.invoices[0]).toEqual({
      id: 'in_TEST1',
      number: 'INV-0003',
      date: '2026-06-01',
      status: 'paid',
      amount: 1354.55,
      amountPaid: 1354.55,
      currency: 'USD',
      hostedUrl: 'https://invoice.stripe.com/i/acct_TEST/live_abc',
      pdfUrl: undefined,
      lines: [
        { description: '1 × Startup plan (at $200.00 / month)', amount: 200 },
        { description: '9013 minute × Build Minutes', amount: 360.52 }
      ]
    })
    // totalBilled = 1354.55 + 3955.39 (second falls back to amount_due when total absent)
    expect(report.totalBilled).toBeCloseTo(5309.94, 2)
    expect(report.hasMore).toBe(true)
  })

  it('falls back to created date and amount_due when total/effective_at are absent', () => {
    const report = buildBillingReport(list)

    expect(report.invoices[1]).toMatchObject({ date: '2026-05-01', amount: 3955.39, amountPaid: 0, status: 'open' })
  })

  it('tolerates an empty list (the live-degraded path)', () => {
    const report = buildBillingReport({ data: [], has_more: false })

    expect(report.invoices).toEqual([])
    expect(report.totalBilled).toBe(0)
    expect(report.hasMore).toBe(false)
  })

  it('leaves plan/upcoming absent and currentMtd null when no subscriptions are passed', () => {
    const report = buildBillingReport(list)

    expect(report.plan).toBeUndefined()
    expect(report.upcoming).toBeUndefined()
    expect(report.currentMtd).toBeNull()
  })

  it('derives plan, next invoice, and metered + base MTD from the upcoming invoice', () => {
    const report = buildBillingReport({ data: [], has_more: false }, subs)

    expect(report.plan).toEqual({ name: 'Startup plan', baseFee: 200 })
    expect(report.upcoming).toEqual({
      date: '2026-07-01',
      amount: 752.22, // upcoming_invoice.total, 75222¢
      meteredSoFar: 552.22 // current-period metered lines: 13524 + 5400 + 36298
    })
    // MTD = current-period metered ($552.22) + recurring base plan ($200)
    expect(report.currentMtd).toBeCloseTo(752.22, 2)
  })

  it('falls back to upcoming.created when current_period_end is absent', () => {
    const report = buildBillingReport(
      { data: [], has_more: false },
      { data: [{ items: [], upcoming_invoice: { created: CURRENT_PERIOD_END, total: 1000, lines: { data: [] } } }] }
    )

    expect(report.upcoming?.date).toBe('2026-07-01')
    expect(report.upcoming?.amount).toBe(10)
    expect(report.upcoming?.meteredSoFar).toBe(0)
    expect(report.plan).toBeUndefined() // no licensed item
    expect(report.currentMtd).toBe(0)
  })

  it('returns currentMtd null when subscriptions are null or carry no upcoming invoice', () => {
    expect(buildBillingReport({ data: [] }, null).currentMtd).toBeNull()
    expect(buildBillingReport({ data: [] }, { data: [{ items: [] }] }).currentMtd).toBeNull()
  })
})

describe('buildDepotSummaryResult', () => {
  it('is a LEAN overview: valid, spend.mtd + monthly spark, NO invoice/line detail tables', () => {
    const result = buildDepotSummaryResult(buildBillingReport(list, subs))

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.summaries?.[0]?.section).toBe('spend')
    expect(result.summaries?.[0]?.value).toBeCloseTo(752.22, 2)
    expect(result.summaries?.[0]?.basis).toBe('accrued')
    // The monthly-spend trend feeds the spark; the detail tables belong to Billing, not Summary. Bars bucket by
    // the INCURRED month — each invoice shifts a month back from its finalized date (metered billed in arrears),
    // so issue months 06/05 chart as 05/04; the open month is left for the live accrual (backfilled in core).
    const monthly = result.datasets.find((d) => d.id === 'monthly')

    expect(monthly?.shape === 'table' && monthly.rows).toEqual([
      { month: '2026-04', amount: 3955.39 },
      { month: '2026-05', amount: 1354.55 }
    ])
    expect(result.datasets.some((d) => d.id === 'invoices')).toBe(false)
    expect(result.datasets.some((d) => d.id === 'lines')).toBe(false)
  })

  it('emits no spend.mtd summary when currentMtd is null (degraded/no subscriptions)', () => {
    const result = buildDepotSummaryResult(buildBillingReport({ data: [], has_more: false }))

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.summaries).toBeUndefined()
    // The monthly-spend chart dataset is still present (empty), so the tab renders.
    expect(result.datasets.some((d) => d.id === 'monthly')).toBe(true)
  })
})

describe('buildDepotBillingTab', () => {
  it('is the DETAIL: valid, invoice + line-item tables present, NO spend.mtd headline', () => {
    const result = buildDepotBillingTab(buildBillingReport(list, subs))

    expect(validateCapabilityResult(result)).toEqual([])
    // No rollup headline on the detail tab.
    expect(result.summaries).toBeUndefined()

    const invoices = result.datasets.find((d) => d.id === 'invoices')

    expect(invoices?.shape).toBe('table')

    if (invoices?.shape === 'table') {
      // PDF falls back to the hosted invoice page (first row carries only hostedUrl).
      expect(invoices.rows[0]?.pdfUrl).toBe('https://invoice.stripe.com/i/acct_TEST/live_abc')
    }

    const lines = result.datasets.find((d) => d.id === 'lines')

    expect(lines?.shape).toBe('table')

    if (lines?.shape === 'table') {
      // First invoice's two line items are flattened in, tagged by invoice number.
      expect(lines.rows.map((r) => [r.invoice, r.description, r.amount])).toEqual([
        ['INV-0003', '1 × Startup plan (at $200.00 / month)', 200],
        ['INV-0003', '9013 minute × Build Minutes', 360.52]
      ])
    }
  })

  it('drops the empty line-item table but keeps the (empty) invoice download on the degraded path', () => {
    const result = buildDepotBillingTab(buildBillingReport({ data: [], has_more: false }))

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.datasets.some((d) => d.id === 'invoices')).toBe(true)
    expect(result.datasets.some((d) => d.id === 'lines')).toBe(false)
  })
})

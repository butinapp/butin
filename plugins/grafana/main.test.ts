import { createSampleGen, resolveSampleConfig, resultValidator, validateSamples } from '@butinapp/sdk/testing'
import { describe, expect, it, test } from 'vitest'

import {
  buildGrafanaBilling,
  buildGrafanaBillingTab,
  buildGrafanaMembers,
  buildGrafanaSummaryResult,
  buildGrafanaUsage,
  buildGrafanaUsageResult,
  grafanaPlugin,
  parseUsageCost,
  type RawGrafanaInstanceList,
  type RawGrafanaInvoiceList,
  type RawGrafanaMemberList,
  type RawGrafanaOrg,
  type RawGrafanaOrgUsage
} from './main.js'
import { sampleGrafanaMembers } from './sample.js'

const validateSampleResult = resultValidator('USD')

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(grafanaPlugin)).toEqual([])
})

test('grafana member generator pulls the synthetic cast and scales with the users knob', () => {
  const small = sampleGrafanaMembers(createSampleGen('grafana:t'), resolveSampleConfig({ size: 'small' }))
  const large = sampleGrafanaMembers(createSampleGen('grafana:t'), resolveSampleConfig({ size: 'large' }))

  expect(small.items!.length).toBe(3)
  expect(large.items!.length).toBe(40)
  expect(large.items!.every((m) => (m.email ?? '').endsWith('@example.invalid'))).toBe(true)
})

// All fixtures below are SYNTHETIC — invented org slug 'acme', invented amounts/IDs — modeling the portal
// `/api/orgs/<slug>` + `/invoices` + `/api/instances` shapes and a data-plane Prometheus instant-vector for
// `grafanacloud_org_total_overage`. Money is DOLLARS throughout.

// ── billing ───────────────────────────────────────────────────────────────────────────

const org: RawGrafanaOrg = {
  gcloudMonthlyCost: 8,
  contractType: 'self_serve',
  subscriptions: {
    current: {
      product: 'grafana-cloud-pro',
      plan: 'pro-8',
      publicName: 'Pro',
      planBillingCycle: 'monthly',
      isTrial: false,
      startDate: '2022-06-20T19:34:28.000Z'
    }
  }
}

const invoices: RawGrafanaInvoiceList = {
  items: [
    {
      id: 'INV001',
      amount: 7743.81,
      amountUnpaid: 0,
      dateSent: '2026-02-01T00:00:00.000Z',
      datePaid: '2026-02-05T00:00:00.000Z',
      orgSlug: 'acme',
      links: [{ rel: 'self', href: '/orgs/acme/invoices/INV001' }]
    },
    {
      id: 'INV002',
      amount: 11385.69,
      amountUnpaid: 0,
      dateSent: '2026-06-01T00:00:00.000Z',
      datePaid: '2026-06-01T00:00:00.000Z',
      orgSlug: 'acme',
      links: [{ rel: 'self', href: '/orgs/acme/invoices/INV002' }]
    },
    {
      id: 'INV003',
      amount: 100,
      amountUnpaid: 100,
      dateSent: '2026-05-01T00:00:00.000Z',
      datePaid: null,
      orgSlug: 'acme'
    }
  ]
}

describe('buildGrafanaBilling', () => {
  it('normalizes the plan name from the org subscription', () => {
    expect(buildGrafanaBilling(org, invoices, 'acme').planName).toBe('Pro')
  })

  it('sorts invoices newest-first and keeps amounts in dollars (no /100)', () => {
    const r = buildGrafanaBilling(org, invoices, 'acme')

    expect(r.invoices.map((i) => i.id)).toEqual(['INV002', 'INV003', 'INV001'])
    expect(r.invoices[0]!.amount).toBe(11385.69)
    expect(r.latestAmount).toBe(11385.69)
  })

  it('gives an id-less invoice a per-index unique id (not a constant fallback), so the ledger key stays unique', () => {
    const r = buildGrafanaBilling(
      org,
      {
        items: [
          { amount: 10, dateSent: '2026-02-01' },
          { amount: 20, dateSent: '2026-01-01' }
        ]
      },
      'acme'
    )

    expect(r.invoices.map((i) => i.id)).toEqual(['inv-0', 'inv-1'])
  })

  it('derives paid/open status from amountUnpaid and totals the unpaid balance', () => {
    const r = buildGrafanaBilling(org, invoices, 'acme')
    const open = r.invoices.find((i) => i.id === 'INV003')!

    expect(open.status).toBe('open')
    expect(open.datePaid).toBeUndefined()
    expect(r.invoices.find((i) => i.id === 'INV002')!.status).toBe('paid')
    expect(r.unpaidTotal).toBe(100)
    expect(r.openInvoiceCount).toBe(1)
  })

  it('builds a hosted URL from the self link (and a slug fallback when absent)', () => {
    const r = buildGrafanaBilling(org, invoices, 'acme')

    expect(r.invoices.find((i) => i.id === 'INV002')!.hostedUrl).toBe('https://grafana.com/orgs/acme/invoices/INV002')
    // INV003 has no links → fallback uses the passed org slug.
    expect(r.invoices.find((i) => i.id === 'INV003')!.hostedUrl).toBe('https://grafana.com/orgs/acme/invoices/INV003')
  })

  it('sums the trailing 12 months relative to the latest invoice', () => {
    // Latest is 2026-06; cutoff 2025-07. All three sample invoices fall within.
    expect(buildGrafanaBilling(org, invoices, 'acme').trailing12moTotal).toBeCloseTo(7743.81 + 11385.69 + 100, 2)
  })

  it('handles empty input', () => {
    const r = buildGrafanaBilling(null, null, 'acme')

    expect(r.invoices).toEqual([])
    expect(r.latestAmount).toBe(0)
    expect(r.unpaidTotal).toBe(0)
    expect(r.trailing12moTotal).toBe(0)
    expect(r.planName).toBe('Unknown')
  })
})

describe('buildGrafanaSummaryResult', () => {
  it('is a lean, valid summary: plan + monthly spark, no detail tables', () => {
    const result = buildGrafanaSummaryResult(buildGrafanaBilling(org, invoices, 'acme'), 6558.76)

    expect(validateSampleResult(result)).toEqual([])
    // The monthly-spend spark is the only table; the invoice/account detail lives on Billing.
    expect(result.datasets.map((d) => d.id)).toEqual(['account', 'monthly'])
    expect(result.datasets.find((d) => d.id === 'invoices')).toBeUndefined()

    const monthly = result.datasets.find((d) => d.id === 'monthly')!

    expect(monthly.shape).toBe('table')
    // One bucket per INCURRED month, ascending — each invoice is shifted a month back from its issue date
    // (sent in arrears the month after the usage), so issue months 02/05/06 chart as 01/04/05.
    expect(monthly.shape === 'table' && monthly.rows.map((row) => row.month)).toEqual(['2026-01', '2026-04', '2026-05'])
  })

  it('emits the spend.mtd summary only when currentMtd is a number, with the plan headline', () => {
    const billing = buildGrafanaBilling(org, invoices, 'acme')

    expect(buildGrafanaSummaryResult(billing, null).summaries).toBeUndefined()

    const withMtd = buildGrafanaSummaryResult(billing, 6558.76)

    expect(withMtd.summaries?.[0]).toMatchObject({
      section: 'spend',
      role: 'money',
      value: 6558.76,
      basis: 'accrued'
    })

    const account = withMtd.datasets.find((d) => d.id === 'account')!

    expect(account.shape === 'record' && account.value).toMatchObject({ currentMtd: 6558.76, plan: 'Pro' })
    // Lean: no latest/trailing/unpaid stat fields — those are the Billing detail.
    expect(account.shape === 'record' && account.value.unpaid).toBeUndefined()
  })
})

describe('buildGrafanaBillingTab', () => {
  it('is a valid detail result with the subscription record + invoices table, no spend.mtd', () => {
    const result = buildGrafanaBillingTab(buildGrafanaBilling(org, invoices, 'acme'))

    expect(validateSampleResult(result)).toEqual([])
    expect(result.summaries).toBeUndefined()
    expect(result.datasets.map((d) => d.id)).toEqual(['account', 'invoices'])
    // No monthly-spend chart on the detail tab.
    expect(result.datasets.find((d) => d.id === 'monthly')).toBeUndefined()
  })

  it('carries the plan detail on the subscription record (billing cycle, trial, start, base fee)', () => {
    const result = buildGrafanaBillingTab(buildGrafanaBilling(org, invoices, 'acme'))
    const account = result.datasets.find((d) => d.id === 'account')!

    expect(account.shape).toBe('record')
    expect(account.shape === 'record' && account.value).toMatchObject({
      plan: 'Pro',
      product: 'grafana-cloud-pro',
      billingCycle: 'Monthly',
      trial: 'No',
      startDate: '2022-06-20',
      baseFee: 8,
      totalBilled: 7743.81 + 11385.69 + 100
    })
  })

  it('lists invoices newest-first with the hosted portal URL (no PDF)', () => {
    const result = buildGrafanaBillingTab(buildGrafanaBilling(org, invoices, 'acme'))
    const inv = result.datasets.find((d) => d.id === 'invoices')!

    expect(inv.shape).toBe('table')
    expect(inv.shape === 'table' && inv.rows.map((r) => r.status)).toEqual(['paid', 'open', 'paid'])
    expect(inv.shape === 'table' && inv.rows[1]!.hostedUrl).toBe('https://grafana.com/orgs/acme/invoices/INV003')
    // The hosted link is a url column, not a downloadable file table.
    expect(inv.shape === 'table' && inv.columns.find((c) => c.key === 'hostedUrl')?.role).toBe('url')
    // The invoice id rides hidden as the accumulation key so an open invoice's balance accumulates as it's paid.
    expect(inv.shape === 'table' && inv.key).toBe('id')
    expect(inv.shape === 'table' && inv.rows[0]!.id).toBe('INV002')
  })

  it('drops the invoices section when there are no invoices', () => {
    const result = buildGrafanaBillingTab(buildGrafanaBilling(org, null, 'acme'))

    expect(result.datasets.map((d) => d.id)).toEqual(['account'])
  })
})

// ── usage ─────────────────────────────────────────────────────────────────────────────

const usageOrg: RawGrafanaOrgUsage = {
  subscriptions: { current: { publicName: 'Pro', planBillingCycle: 'monthly' } },
  hmUsage: 313881,
  hmCurrentUsage: 286475,
  hlUsage: 7612.9344038130275,
  hlRetentionUsage: 5403.4413551343605,
  htUsage: 70.40402810834348,
  hpUsage: 0,
  smUsage: 106259.75606340033,
  hgUsage: 23,
  hgCurrentActiveUsers: 33
}

const instances: RawGrafanaInstanceList = {
  items: [
    {
      name: 'acme-prod.grafana.net',
      url: 'https://acme-prod.grafana.net',
      status: 'active',
      regionPublicName: 'US Central',
      runningVersion: '13.1.0-27004965129 (commit: a4dd44df, branch: HEAD)',
      planName: 'Grafana Cloud',
      billingActiveUsers: 23,
      currentActiveUsers: 33,
      currentActiveAdminUsers: 17,
      currentActiveEditorUsers: 4,
      currentActiveViewerUsers: 12,
      dashboardCnt: 165,
      alertCnt: 63,
      hmInstancePromBillingUsage: 313801,
      hlInstanceBillingUsage: 7614.535952499494,
      htInstanceBillingUsage: 70.69404148403555,
      hpInstanceBillingUsage: 0
    }
  ]
}

describe('buildGrafanaUsage', () => {
  it('builds the product table with per-product units and rounding', () => {
    const r = buildGrafanaUsage(usageOrg, instances)

    expect(r.planName).toBe('Pro')
    expect(r.billingCycle).toBe('monthly')

    const byKey = Object.fromEntries(r.products.map((p) => [p.key, p]))

    expect(byKey.metrics).toMatchObject({ unit: 'active series', billed: 313881, current: 286475 })
    expect(byKey.logs).toMatchObject({ unit: 'GB', billed: 7612.93 })
    expect(byKey.logsRetention!.billed).toBe(5403.44)
    expect(byKey.traces!.billed).toBe(70.4)
    expect(byKey.synthetics).toMatchObject({ unit: 'checks', billed: 106260 })
    expect(byKey.users).toMatchObject({ unit: 'users', billed: 23, current: 33 })
  })

  it('maps the per-stack breakdown and shortens the version', () => {
    const r = buildGrafanaUsage(usageOrg, instances)

    expect(r.stacks).toHaveLength(1)
    const s = r.stacks[0]!

    expect(s.name).toBe('acme-prod.grafana.net')
    expect(s.region).toBe('US Central')
    expect(s.version).toBe('13.1.0')
    expect(s.billedUsers).toBe(23)
    expect(s.activeUsers).toBe(33)
    expect(s).toMatchObject({ adminUsers: 17, editorUsers: 4, viewerUsers: 12, dashboards: 165, alerts: 63 })
    expect(s.metricsSeries).toBe(313801)
    expect(s.logsGb).toBe(7614.54)
    expect(s.tracesGb).toBe(70.69)
  })

  it('aggregates billed users across stacks and reports current active users', () => {
    const r = buildGrafanaUsage(usageOrg, instances)

    expect(r.activeUsers).toBe(33)
    expect(r.billedUsers).toBe(23)
  })

  it('handles empty input', () => {
    const r = buildGrafanaUsage(null, null)

    expect(r.stacks).toEqual([])
    expect(r.activeUsers).toBe(0)
    expect(r.billedUsers).toBe(0)
    expect(r.planName).toBe('Unknown')
    expect(r.products.find((p) => p.key === 'metrics')!.billed).toBe(0)
  })
})

describe('buildGrafanaUsageResult', () => {
  it('renders per-product usage metrics (no money summary) + a stacks table', () => {
    const result = buildGrafanaUsageResult(buildGrafanaUsage(usageOrg, instances))

    // Consumption only → no usage.primary money summary.
    expect(result.summaries).toBeUndefined()

    const metrics = result.datasets.find((d) => d.id === 'metrics')!

    expect(metrics.shape).toBe('table')
    expect(metrics.shape === 'table' && metrics.rows).toHaveLength(7)

    const stacks = result.datasets.find((d) => d.id === 'stacks')!

    expect(stacks.shape).toBe('table')
    expect(stacks.shape === 'table' && stacks.rows[0]!.name).toBe('acme-prod.grafana.net')
    // Keyed by the stack name so each stack accumulates its usage in the ledger.
    expect(stacks.shape === 'table' && stacks.key).toBe('name')
  })

  it('omits the stacks table when there are no instances', () => {
    const result = buildGrafanaUsageResult(buildGrafanaUsage(usageOrg, { items: [] }))

    expect(result.datasets.find((d) => d.id === 'stacks')).toBeUndefined()
  })
})

// ── members (portal org roster) ─────────────────────────────────────────────────────────

describe('buildGrafanaMembers', () => {
  const list: RawGrafanaMemberList = {
    items: [
      { userId: 7, login: 'ada', name: 'Ada Byron', email: 'ada@acme.test', role: 'Admin' },
      { userId: 8, login: 'grace', name: 'Grace Mol', email: 'grace@acme.test', role: 'Editor' }
    ]
  }

  it('maps an { items } wrapper to the roster, preferring userId for the id', () => {
    const { members } = buildGrafanaMembers(list)

    expect(members.map((m) => m.id)).toEqual(['7', '8'])
    expect(members[0]).toMatchObject({ name: 'Ada Byron', email: 'ada@acme.test', role: 'Admin' })
  })

  it('tolerates a bare array and falls back id → login → index', () => {
    const { members } = buildGrafanaMembers([{ login: 'svc' }, {}])

    expect(members.map((m) => m.id)).toEqual(['svc', '1'])
  })

  it('handles empty / absent input', () => {
    expect(buildGrafanaMembers(null).members).toEqual([])
    expect(buildGrafanaMembers({ items: [] }).members).toEqual([])
  })
})

// ── MTD (data-plane Prometheus instant query) ───────────────────────────────────────────

describe('parseUsageCost', () => {
  // Column-major dataframe: data.values = [[timestamps], [values]]; the value column is index 1.
  const response = {
    results: {
      A: {
        status: 200,
        frames: [
          {
            schema: {
              refId: 'A',
              fields: [
                { name: 'Time', type: 'time' },
                { name: 'Value', type: 'number' }
              ]
            },
            data: { values: [[1781194084615], [6558.759999999999]] }
          }
        ]
      }
    }
  }

  it('extracts the dollar value from the value column (index 1)', () => {
    expect(parseUsageCost(response)).toBeCloseTo(6558.76, 2)
  })

  it('coerces a string-encoded value', () => {
    expect(parseUsageCost({ results: { A: { frames: [{ data: { values: [[1], ['1234.5']] } }] } } })).toBe(1234.5)
  })

  it('returns null for an empty / missing value column', () => {
    expect(parseUsageCost({ results: { A: { frames: [{ data: { values: [[1781194084615], []] } }] } } })).toBeNull()
    expect(parseUsageCost({ results: { A: { frames: [] } } })).toBeNull()
    expect(parseUsageCost({ results: {} })).toBeNull()
  })

  it('returns null for malformed input', () => {
    expect(parseUsageCost(null)).toBeNull()
    expect(parseUsageCost('nope')).toBeNull()
    expect(parseUsageCost({})).toBeNull()
  })
})

// ── descriptor ──────────────────────────────────────────────────────────────────────

describe('grafanaPlugin', () => {
  it('is well-formed: cookie auth, node transport, summary-first capability tabs', () => {
    expect(grafanaPlugin.meta.id).toBe('grafana')
    expect(grafanaPlugin.auth.kind).toBe('cookie')
    expect(grafanaPlugin.transport?.engine).toBe('node')
    expect(grafanaPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'usage', 'members'])
  })

  it('exposes the two-surface config: org slug + the data-plane stack/token fields', () => {
    const keys = grafanaPlugin.config?.fields.map((f) => f.key)

    expect(keys).toEqual(['orgSlug', 'stackSlug', 'dataPlaneToken'])
    expect(grafanaPlugin.config?.fields.find((f) => f.key === 'dataPlaneToken')?.kind).toBe('secret')
  })

  it('prefills the org slug from the dashboard URL', () => {
    expect(grafanaPlugin.session?.captureFromUrl).toContainEqual({ pattern: '/orgs/([^/?#]+)', storeAs: 'orgSlug' })
  })
})

import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { createSampleGen, resolveSampleConfig } from '@butinapp/sdk/testing'
import { expect, test } from 'vitest'

import {
  buildDigitalOceanBillingTab,
  buildDigitalOceanHistory,
  buildDigitalOceanSummary,
  buildDigitalOceanUsage,
  digitaloceanPlugin,
  FACETS,
  invoicesForChart,
  type RawDigitalOceanBilling,
  type RawDigitalOceanUsage
} from './main.js'
import * as queries from './queries.js'
import { SAMPLE_FACETS, sampleDigitalOceanBilling } from './sample.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

// Invented throughout — the shape is DigitalOcean's, every value is fabricated.
const TEAM = {
  uuid: '1112223334445556667778889990001112223334',
  urn: 'do:team:1112223334445556667778889990001112223334',
  name: 'Sample Team',
  role: 'Owner'
}

const HISTORY = [
  {
    description: 'Payment (card ending in 1112)',
    amount: '-250.00',
    date: '2024-03-02T06:30:00.000Z',
    type: 'Payment',
    invoice_uuid: null,
    receipt_id: '123456789',
    account_urn: TEAM.urn
  },
  {
    description: 'Invoice for February 2024',
    amount: '250.00',
    date: '2024-03-01T04:12:00.000Z',
    type: 'Invoice',
    invoice_uuid: '11112222-3333-4444-5555-666677778888',
    receipt_id: null,
    account_urn: TEAM.urn
  },
  {
    description: 'Invoice for January 2024',
    amount: '100.00',
    date: '2024-02-01T04:12:00.000Z',
    type: 'Invoice',
    invoice_uuid: '99998888-7777-6666-5555-444433332222',
    receipt_id: null,
    account_urn: TEAM.urn
  }
]

const BILLING: RawDigitalOceanBilling = {
  team: TEAM,
  summary: {
    payment_due_date: '2024-04-01T00:00:00.000Z',
    total_usage_amount: '80.00',
    past_due_amount: '0.00',
    estimated_due: '80.00'
  },
  insights: { current_mtd_spend: '80.00', projected_month_spend: '240.00', daily_average_spend: '8.00' },
  credits: '15.00',
  history: HISTORY,
  invoice: {
    billing_start: '2024-03-01',
    issue_date: '2024-03-10',
    invoice_generated_at: '2024-03-10T04:08:12Z',
    usage_items: [
      {
        type: 'Droplets',
        description: 'Droplets (2)',
        extra_detail: null,
        amount: '$70.00',
        sub_items: [
          { type: 'Droplets', description: 'web-001', extra_detail: '192 hours', amount: '$40.00', sub_items: null },
          { type: 'Droplets', description: 'web-002', extra_detail: '192 hours', amount: '$30.00', sub_items: null }
        ]
      },
      {
        type: 'Managed Databases',
        description: 'Managed Databases (1)',
        extra_detail: null,
        amount: '$8.00',
        sub_items: [
          {
            type: 'Managed Databases',
            description: 'db-001 (PostgreSQL)',
            extra_detail: null,
            amount: '$8.00',
            sub_items: [
              { type: 'Database Clusters', description: 'Primary node', extra_detail: '192 hours', amount: '$5.00' },
              { type: 'Database Clusters', description: 'Extra storage', extra_detail: '192 hours', amount: '$3.00' }
            ]
          }
        ]
      }
    ],
    subtotal: { type: 'Subtotal', description: 'Subtotal', extra_detail: null, amount: '$78.00' },
    discounts: null,
    credits: null,
    taxes: { type: 'Taxes', description: 'Taxes', extra_detail: null, amount: '$2.00' },
    total: { type: 'Total', description: 'Total', extra_detail: null, amount: '$80.00' }
  },
  paymentMethods: [
    { id: '1112223', description: 'Visa ending in 1112', type: 'card', expiration_date: '02/2030', is_default: true }
  ],
  address: {
    address_line1: '1234 rue Exemple',
    address_line2: 'App 5',
    city: 'Montréal',
    region: 'QC',
    country_iso2_code: 'CA',
    postal_code: 'H0H 0H0'
  },
  tax: { tax_name: 'GST+QST', tax_rate: '14.975', tax_location_name: 'Canada' }
}

const USAGE: RawDigitalOceanUsage = {
  facetUsage: [
    { facet: 'DROPLET_COUNT', usage: '4', error: '' },
    { facet: 'VOLUME_GLOBAL_CAPACITY_BYTES', usage: String(10 * 1024 ** 3), error: '' },
    { facet: 'NFS_SHARE_COUNT', usage: '0', error: 'facet not implemented' },
    { facet: 'DOMAIN_COUNT', usage: '0', error: '' },
    { facet: 'GEN_AI_AGENT_COUNT', usage: '0', error: '' }
  ],
  limits: [
    { facet: 'DROPLET_COUNT', limit: '25' },
    { facet: 'VOLUME_GLOBAL_CAPACITY_BYTES', limit: String(100 * 1024 ** 3) },
    { facet: 'DOMAIN_COUNT', limit: '30' },
    { facet: 'GEN_AI_AGENT_COUNT', limit: '0' }
  ],
  daily: [
    { date: '2024-03-02', amount: '30.00' },
    { date: '2024-03-01', amount: '12.00' }
  ]
}

// --- descriptor ---

test('digitalocean replays the Rails session cookie over node transport', () => {
  expect(digitaloceanPlugin.auth.kind).toBe('cookie')
  expect(digitaloceanPlugin.session?.requiredCookie).toBe('_digitalocean2_session_v4')
  // Google omniauth stashes the OAuth state in that same cookie — a stale one must not survive into a re-login.
  expect(digitaloceanPlugin.session?.clearCookiesBeforeCapture).toContain('_digitalocean2_session_v4')
  expect(digitaloceanPlugin.transport?.engine).toBe('node')
  expect(digitaloceanPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'usage'])
})

test('every safelisted document names the operation and the panel bundle it is registered under', () => {
  const documents = Object.values(queries).filter(
    (q): q is queries.SafelistedQuery => typeof q === 'object' && q !== null && 'document' in q
  )

  expect(documents.length).toBeGreaterThan(0)

  for (const q of documents) {
    // The endpoint matches the registered text, so the document must still declare the operation it was
    // registered as — a rename or a trim here is what earns a PERSISTED_QUERY_NOT_FOUND.
    expect(q.document.startsWith(`query ${q.operationName}`), `${q.operationName} declares its operation`).toBe(true)
    expect(['ui-projects', 'ui-billing']).toContain(q.client)
  }
})

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of digitaloceanPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

test('the sample meters facets the plugin actually requests, and scales with the documents knob', () => {
  const metered = new Set(FACETS.map((f) => f.facet))

  expect(SAMPLE_FACETS.filter((f) => !metered.has(f))).toEqual([])

  const small = sampleDigitalOceanBilling(createSampleGen('do:t'), resolveSampleConfig({ size: 'small' }))
  const large = sampleDigitalOceanBilling(createSampleGen('do:t'), resolveSampleConfig({ size: 'large' }))

  expect(large.history.length).toBeGreaterThanOrEqual(small.history.length)
  expect(small.team.urn.startsWith('do:team:')).toBe(true)
})

// --- billing history ---

test('history parses decimal strings (payments negative), sorts newest first, and builds each PDF path', () => {
  const rows = buildDigitalOceanHistory(HISTORY, TEAM.urn)

  expect(rows.map((r) => r.date)).toEqual(['2024-03-02', '2024-03-01', '2024-02-01'])
  expect(rows[0]).toMatchObject({ type: 'Payment', amount: -250, id: '123456789' })
  expect(rows[0].pdfUrl).toBe(`https://cloud.digitalocean.com/v2/customers/${TEAM.urn}/payment_receipt/123456789/pdf`)
  expect(rows[1].pdfUrl).toBe(
    `https://cloud.digitalocean.com/v2/customers/${TEAM.urn}/invoices/11112222-3333-4444-5555-666677778888/pdf`
  )
})

test('history falls back to the team URN and leaves a document-less row without a URL', () => {
  const rows = buildDigitalOceanHistory(
    [{ description: 'Credit', amount: '-5.00', date: '2024-03-05T00:00:00Z', type: 'Credit' }],
    TEAM.urn
  )

  expect(rows[0]).toMatchObject({ amount: -5, pdfUrl: null, id: '2024-03-05:-5' })
  expect(buildDigitalOceanHistory(null, TEAM.urn)).toEqual([])
})

test('the chart counts invoices only, dated back onto the month the spend was incurred', () => {
  const invoices = invoicesForChart(buildDigitalOceanHistory(HISTORY, TEAM.urn))

  expect(invoices.map((i) => i.date)).toEqual(['2024-02-29', '2024-01-31'])
  expect(invoices.every((i) => i.amount > 0)).toBe(true)
})

// --- Summary ---

test('summary headlines the accrued month, projects the pace, and sparks off the monthly series', () => {
  const result = buildDigitalOceanSummary(BILLING)

  expect(validateCapabilityResult(result)).toEqual([])

  const account = result.datasets.find((d) => d.id === 'account') as unknown as { value: Record<string, unknown> }

  expect(account.value).toMatchObject({ currentMtd: 80, projected: 240, dailyAverage: 8, estimatedDue: 80 })
  expect(result.summaries?.[0]).toMatchObject({ section: 'spend', value: 80, basis: 'accrued' })

  const monthly = result.datasets.find((d) => d.id === 'monthly') as unknown as { rows: Record<string, unknown>[] }

  expect(monthly.rows).toEqual([
    { month: '2024-01', amount: 100 },
    { month: '2024-02', amount: 250 }
  ])
  // The Summary is the headline; the invoice history is the Billing tab's.
  expect(result.datasets.some((d) => d.id === 'history')).toBe(false)
})

test('summary shows a past-due card only while there is a balance', () => {
  const withDue = buildDigitalOceanSummary({
    ...BILLING,
    summary: { ...BILLING.summary, past_due_amount: '42.50' }
  })
  const account = withDue.datasets.find((d) => d.id === 'account') as unknown as { value: Record<string, unknown> }

  expect(account.value.pastDue).toBe(42.5)
  expect(
    (buildDigitalOceanSummary(BILLING).datasets.find((d) => d.id === 'account') as unknown as { value: object }).value
  ).not.toHaveProperty('pastDue')
})

test('summary tolerates a service that answers with none of the billing panels', () => {
  const empty = buildDigitalOceanSummary({ ...BILLING, summary: null, insights: null, history: [] })

  expect(validateCapabilityResult(empty)).toEqual([])
  expect(empty.summaries?.[0]).toMatchObject({ value: 0 })
})

// --- Billing ---

test('billing renders the open invoice, its charges, the account panel and the downloadable history', () => {
  const result = buildDigitalOceanBillingTab(BILLING)

  expect(validateCapabilityResult(result)).toEqual([])

  const invoice = result.datasets.find((d) => d.id === 'invoice') as unknown as { value: Record<string, unknown> }

  expect(invoice.value).toMatchObject({
    period: '2024-03-01 → 2024-03-10',
    generated: '2024-03-10',
    subtotal: 78,
    taxes: 2,
    total: 80,
    discounts: null
  })

  const account = result.datasets.find((d) => d.id === 'account') as unknown as { value: Record<string, unknown> }

  expect(account.value).toMatchObject({
    team: 'Sample Team',
    paymentMethod: 'Visa ending in 1112',
    expires: '02/2030',
    address: '1234 rue Exemple, App 5, Montréal, QC, H0H 0H0, CA',
    tax: 'GST+QST 14.975% · Canada',
    credits: 15
  })

  const files = result.views?.find((v) => v.type === 'table' && v.dataset === 'history') as { files?: unknown }

  expect(files.files).toMatchObject({ source: { url: 'pdfUrl' }, name: 'name', ext: 'pdf', category: 'Invoices' })
  // The monthly chart + headline are the Summary's; Billing carries the detail.
  expect(result.datasets.some((d) => d.id === 'monthly')).toBe(false)
  expect(result.summaries).toBeUndefined()
})

test('charges roll a category up from its leaf resources, never double-counting a nested one', () => {
  const result = buildDigitalOceanBillingTab(BILLING)
  const charges = result.datasets.find((d) => d.id === 'charges') as unknown as { rows: Record<string, unknown>[] }
  const items = result.datasets.find((d) => d.id === 'chargeItems') as unknown as { rows: Record<string, unknown>[] }

  expect(charges.rows).toEqual([
    { category: 'Droplets', items: 2, amount: 70 },
    { category: 'Managed Databases', items: 2, amount: 8 }
  ])
  // The cluster's own $8.00 line is a subtotal of its nodes — only the nodes bill.
  expect(items.rows.filter((r) => r.category === 'Managed Databases')).toEqual([
    { category: 'Managed Databases', description: 'Primary node', detail: '192 hours', amount: 5 },
    { category: 'Managed Databases', description: 'Extra storage', detail: '192 hours', amount: 3 }
  ])

  const view = result.views?.find((v) => v.type === 'table' && v.dataset === 'charges') as { detail?: unknown }

  expect(view.detail).toEqual({ dataset: 'chargeItems', on: 'category' })
})

test('billing drops the invoice panels a team without an open invoice has none of', () => {
  const result = buildDigitalOceanBillingTab({ ...BILLING, invoice: null, address: null, tax: null, credits: null })

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.datasets.some((d) => d.id === 'invoice')).toBe(false)
  expect(result.datasets.some((d) => d.id === 'charges')).toBe(false)

  const account = result.datasets.find((d) => d.id === 'account') as unknown as { value: Record<string, unknown> }

  expect(account.value).toMatchObject({ address: null, tax: null, credits: null })
})

// --- Usage ---

test('usage meters each facet against its limit, converts bytes to GiB, and drops what is not metered', () => {
  const result = buildDigitalOceanUsage(USAGE)

  expect(validateCapabilityResult(result)).toEqual([])

  const metrics = result.datasets.find((d) => d.id === 'metrics') as unknown as { rows: Record<string, unknown>[] }

  expect(metrics.rows).toEqual([
    { label: 'Droplets', value: 4, unit: null, limit: 25, cost: null },
    { label: 'Block-storage capacity', value: 10, unit: 'GiB', limit: 100, cost: null },
    { label: 'Domains', value: 0, unit: null, limit: 30, cost: null }
  ])
})

test('usage renders the month spend curve oldest-first and emits no competing spend summary', () => {
  const result = buildDigitalOceanUsage(USAGE)
  const daily = result.datasets.find((d) => d.id === 'daily') as unknown as { rows: Record<string, unknown>[] }

  expect(daily.rows).toEqual([
    { date: '2024-03-01', cost: 12 },
    { date: '2024-03-02', cost: 30 }
  ])
  expect(result.summaries).toBeUndefined()

  const bare = buildDigitalOceanUsage({ facetUsage: [], limits: [], daily: [] })

  expect(validateCapabilityResult(bare)).toEqual([])
})

import { resolveCurrencies, validateCapabilityResult } from '@butinapp/sdk/data'
import { members } from '@butinapp/sdk/presets'
import { expect, test } from 'vitest'

import {
  buildVercelBillingResult,
  buildVercelMembers,
  buildVercelSummaryResult,
  invoiceSplit,
  type RawInvoiceList,
  type RawMembersList,
  type RawPaymentMethods,
  type RawSubscription,
  type RawUsageSummary,
  vercelPlugin
} from './main.js'

// Money values carry no currency until core stamps the plugin's reportingCurrency at the edge; resolve it
// (USD for Vercel) before validating a raw build* result so the money-column/summary currency checks pass.
const sampleValidate = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  validateCapabilityResult(resolveCurrencies(r, 'USD'))

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of vercelPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(sampleValidate(cap.sample!()), cap.id).toEqual([])
  }
})

// --- synthetic fixtures (no real slugs/emails/cards) ---

const subscription: RawSubscription = {
  plan: 'enterprise',
  account: {
    billingName: 'Acme Inc',
    billingAddress: { line1: '1 Main St', city: 'Townsville', country: 'CA', postalCode: 'A1A1A1' },
    createdAt: 1_700_000_000_000,
    stripeCustomerId: 'cus_test'
  },
  payment: { status: 'paid', openInvoices: [{}, {}] },
  products: [
    { slug: 'pro', prices: [{ type: 'licensed', billableItemSlug: 'teamSeats', quantity: 12, maxQuantity: 50 }] },
    { slug: 'pro', prices: [{ type: 'licensed', billableItemSlug: 'concurrentBuilds', quantity: 4 }] },
    { slug: 'bandwidth', prices: [{ type: 'metered' }] }
  ]
}

const usage: RawUsageSummary = {
  data: {
    onDemandCharges: 42.5,
    usage: [
      { id: 'p1', name: 'web', value: 30, percent: 0.6 },
      { id: 'p2', name: 'api', value: 12.5, percent: 0.25 }
    ]
  },
  cycle: { start: 1_717_200_000_000, end: 1_719_792_000_000 }
}

const payment: RawPaymentMethods = {
  defaultSource: 'src_2',
  sources: [
    { id: 'src_1', card: { brand: 'visa', last4: '1111', exp_month: 1, exp_year: 2030 } },
    {
      id: 'src_2',
      card: { display_brand: 'mastercard', last4: '4444', exp_month: 9, exp_year: 2028 },
      billing_details: { email: 'billing@example.com' }
    }
  ]
}

const invoices: RawInvoiceList = {
  data: [
    {
      id: 'in_2',
      invoiceNumber: 'F-002',
      status: 'paid',
      total: '540.00',
      issuedAt: '2026-05-05T09:24:30.000Z',
      pdfDownloadUrl: 'https://vercel.com/api/invoices/in_2/pdf',
      groups: [
        { id: 'managed-infra', total: '500.00' },
        { id: 'devex', total: '40.00' }
      ]
    },
    {
      id: 'in_1',
      invoiceNumber: 'F-001',
      status: 'open',
      total: '120.50',
      createdAt: '2026-04-01T00:00:00.000Z',
      pdfDownloadUrl: null
    }
  ]
}

test('summary: headline stat, monthly chart, top projects, and spend.mtd for the Overview', () => {
  const result = buildVercelSummaryResult({ subscription, usage, invoices })

  expect(sampleValidate(result)).toEqual([])

  // MTD = onDemandCharges in dollars (no /100), surfaced as the spend.mtd summary with a monthly spark.
  expect(result.summaries?.[0]).toMatchObject({
    section: 'spend',
    value: 42.5,
    role: 'money',
    basis: 'accrued',
    spark: { dataset: 'monthly' }
  })

  const account = result.datasets.find((d) => d.id === 'account')

  expect(account?.shape === 'record' && account.value).toMatchObject({
    currentMtd: 42.5,
    plan: 'enterprise',
    teamSeats: 12,
    // Invoice count derived from the already-fetched invoice list — no extra query.
    invoiceCount: 2
  })

  // Monthly spend bucketed by the INCURRED month — each invoice shifts a month back from its issue date
  // (billed in arrears), so issue months 04/05 chart as 03/04.
  const monthly = result.datasets.find((d) => d.id === 'monthly')

  expect(monthly?.shape === 'table' && monthly.rows).toEqual([
    { month: '2026-03', amount: 120.5 },
    { month: '2026-04', amount: 540 }
  ])

  // Top projects sorted by spend desc; percent is the raw 0..1 fraction (the renderer scales it via Intl).
  const projects = result.datasets.find((d) => d.id === 'topProjects')

  expect(projects?.shape === 'table' && projects.rows).toEqual([
    { name: 'web', value: 30, percent: 0.6 },
    { name: 'api', value: 12.5, percent: 0.25 }
  ])
})

test('summary: MTD null + no projects when the usage summary is missing (so the Overview skips Vercel)', () => {
  const result = buildVercelSummaryResult({ subscription, usage: null, invoices })

  expect(sampleValidate(result)).toEqual([])
  expect(result.summaries).toBeUndefined()
  expect(result.datasets.find((d) => d.id === 'topProjects')).toBeUndefined()
  // The monthly chart still renders from invoices even without the usage summary.
  expect(result.datasets.find((d) => d.id === 'monthly')?.shape === 'table').toBe(true)
})

test('billing: invoices, account details, payment method, and licensed items', () => {
  const result = buildVercelBillingResult({ subscription, usage, payment, invoices })

  expect(sampleValidate(result)).toEqual([])

  const details = result.datasets.find((d) => d.id === 'details')

  expect(details?.shape === 'record' && details.value).toMatchObject({
    billingName: 'Acme Inc',
    billingEmail: 'billing@example.com',
    paymentStatus: 'paid',
    openInvoices: 2,
    customerSince: '2023-11-14',
    cycle: '2024-06-01 → 2024-07-01'
  })
  // teamSeats is NOT duplicated into the details record (it's a Summary stat + a Licensed-items row).
  expect(details?.shape === 'record' && 'teamSeats' in details.value).toBe(false)

  // Licensed items sorted by quantity desc — teamSeats lives here (and on the Summary stat).
  const licensed = result.datasets.find((d) => d.id === 'licensed')

  expect(licensed?.shape === 'table' && licensed.rows.map((r) => r.slug)).toEqual(['teamSeats', 'concurrentBuilds'])

  // Default source picked (not the first), display_brand preferred.
  const pm = result.datasets.find((d) => d.id === 'paymentMethod')

  expect(pm?.shape === 'record' && pm.value).toMatchObject({ brand: 'mastercard', last4: '4444', expiry: '09/2028' })

  // Invoices flow through (dollar strings → numbers).
  const invoiceDs = result.datasets.find((d) => d.id === 'invoices')

  expect(invoiceDs?.shape === 'table' && invoiceDs.rows[0]).toMatchObject({ amount: 540, status: 'paid' })

  // The two keyvalue panels are adjacent so the renderer's 2-col grid pairs them side by side.
  expect(result.views?.map((v) => v.type)).toEqual(['table', 'keyvalue', 'keyvalue', 'table'])

  // The invoices table is downloadable: the host turns pdfUrl rows into selectable files (no documents tab).
  const invoicesView = result.views?.find((v) => v.type === 'table' && v.dataset === 'invoices')

  expect(invoicesView?.type === 'table' && invoicesView.files).toEqual({
    name: 'name',
    source: { url: 'pdfUrl' },
    ext: 'pdf',
    category: 'Invoices'
  })
  // Each invoice row carries a `name` field for the download filename (not a rendered column).
  expect(invoiceDs?.shape === 'table' && invoiceDs.rows[0].name).toBe('Invoice F-002')
})

test('members normalize uid/name/email/role', () => {
  const raw: RawMembersList = {
    members: [
      { uid: 'u1', email: 'a@example.com', role: 'OWNER', name: 'Ada' },
      { uid: 'u2', email: 'b@example.com', role: 'DEVELOPER', username: 'bob-123' },
      { uid: 'u3', email: 'c@example.com', role: 'MEMBER' }
    ]
  }
  // mirror collectVercelMembers without a client: the pure builder + preset compose to a valid result.
  const result = members.result(buildVercelMembers(raw))

  expect(validateCapabilityResult(result)).toEqual([])
  const membersDs = result.datasets.find((d) => d.id === 'members')

  expect(membersDs?.shape === 'table' && membersDs.rows).toEqual([
    { id: 'u1', name: 'Ada', email: 'a@example.com', role: 'OWNER' },
    { id: 'u2', name: 'bob-123', email: 'b@example.com', role: 'DEVELOPER' },
    { id: 'u3', name: null, email: 'c@example.com', role: 'MEMBER' }
  ])
})

test('invoiceSplit carries the infra/platform group totals', () => {
  expect(invoiceSplit(invoices.data![0])).toEqual({ infra: 500, platform: 40 })
})

test('plugin is well-formed: Summary (billing kind) + Billing + Members + Invoices tabs', () => {
  expect(vercelPlugin.meta.id).toBe('vercel')
  expect(vercelPlugin.auth.kind).toBe('cookie')
  expect(vercelPlugin.session?.requiredCookie).toBe('authorization')
  expect(vercelPlugin.config?.fields[0]).toMatchObject({ key: 'teamSlug', required: true })
  expect(vercelPlugin.capabilities.map((c) => c.label)).toEqual(['Summary', 'Billing', 'Members'])
  // The Summary tab carries a spend.mtd summary — that's what the cross-service Overview rollup reads.
  // No separate documents tab — invoice PDFs download from the Billing invoices table.
  expect(vercelPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'members'])
})

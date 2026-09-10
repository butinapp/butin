import { members } from '@butinapp/sdk/presets'
import { resultValidator, validateSamples } from '@butinapp/sdk/testing'
import { currentMonthKey } from '@butinapp/sdk/util'
import { expect, test } from 'vitest'

import {
  buildInfisicalBilling,
  buildInfisicalBillingResult,
  buildInfisicalMembers,
  buildInfisicalSummary,
  buildInfisicalUsage,
  humanizeMetric,
  type InfisicalBillingInput,
  infisicalPlugin,
  jidFromSetCookie,
  setCookieValue,
  type InfisicalUsageInput
} from './main.js'

const validateCapabilityResult = resultValidator('USD')

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(infisicalPlugin)).toEqual([])
})

// All fixtures below are SYNTHETIC — invented org ids, amounts, and Stripe-shaped ids (no real account
// data). Dates that must be "this month" are derived from the structure, not hard-coded.
const ym = currentMonthKey()
const thisMonthUnix = Math.floor(Date.parse(`${ym}-15T12:00:00Z`) / 1000)

const billingFixture: InfisicalBillingInput = {
  invoices: [
    // CENTS. Out of order on purpose — build*() sorts newest-first.
    {
      id: 'in_aaa',
      created: Math.floor(Date.parse('2026-01-10T00:00:00Z') / 1000),
      paid: true,
      number: 'A-1',
      total: 1200,
      invoice_pdf: 'https://files.example.test/in_aaa.pdf'
    },
    {
      id: 'in_ccc',
      created: thisMonthUnix,
      paid: true,
      number: 'A-3',
      total: 2500,
      invoice_pdf: 'https://files.example.test/in_ccc.pdf'
    },
    {
      _id: 'in_bbb',
      created: Math.floor(Date.parse('2026-02-10T00:00:00Z') / 1000),
      paid: false,
      number: 'A-2',
      total: 1200
    }
  ],
  planBilling: {
    currentPeriodStart: Math.floor(Date.parse('2026-06-01T00:00:00Z') / 1000),
    currentPeriodEnd: Math.floor(Date.parse('2026-07-01T00:00:00Z') / 1000),
    interval: 'month',
    amount: 1800, // $18.00/seat in CENTS
    quantity: 3,
    users: 2,
    identities: 1
  },
  plan: { plan: { slug: 'pro', status: 'active' } },
  billingDetails: { name: 'Sample Org', email: 'billing@example.test' },
  // The card list repeats the same card — build*() dedupes to the first.
  paymentMethods: [
    { brand: 'visa', funding: 'credit', exp_month: 8, exp_year: 2030, last4: '4242' },
    { brand: 'visa', funding: 'credit', exp_month: 8, exp_year: 2030, last4: '4242' }
  ]
}

// --- auth helpers (rotating-refresh cookie write-back) ---

test('setCookieValue replaces an existing jid and appends a missing one, preserving other pairs', () => {
  expect(setCookieValue('jid=old; other=keep', 'jid', 'new')).toBe('jid=new; other=keep')
  expect(setCookieValue('other=keep', 'jid', 'new')).toBe('other=keep; jid=new')
})

test('jidFromSetCookie pulls the rotated jid from a string or an array of Set-Cookie lines', () => {
  expect(jidFromSetCookie('jid=rotated123; Path=/api; HttpOnly')).toBe('rotated123')
  expect(jidFromSetCookie(['session=x; Path=/', 'jid=rotated456; HttpOnly'])).toBe('rotated456')
  expect(jidFromSetCookie(undefined)).toBeUndefined()
  expect(jidFromSetCookie(['nojid=here'])).toBeUndefined()
})

// --- billing normalization ---

test('billing converts CENTS to USD dollars, sorts invoices newest-first, dedupes the card', () => {
  const r = buildInfisicalBilling(billingFixture)

  expect(r.invoices.map((i) => i.number)).toEqual(['A-3', 'A-2', 'A-1'])
  expect(r.invoices[0]).toMatchObject({ amount: 25, status: 'paid', pdfUrl: 'https://files.example.test/in_ccc.pdf' })
  expect(r.invoices[1]).toMatchObject({ amount: 12, status: 'open' }) // not paid → open
  expect(r.invoices[2].id).toBe('in_aaa')
  // _id fallback when id is absent
  expect(r.invoices[1].id).toBe('in_bbb')

  expect(r.subscription).toMatchObject({
    planSlug: 'pro',
    status: 'active',
    unitAmount: 18,
    quantity: 3,
    users: 2,
    identities: 1
  })
  expect(r.subscription.monthlySubtotal).toBe(54) // 18 * 3
  expect(r.subscription.currentPeriodStart).toBe('2026-06-01')

  expect(r.paymentMethod).toMatchObject({ brand: 'visa', last4: '4242', expMonth: 8, expYear: 2030 })
  expect(r.contact).toEqual({ name: 'Sample Org', email: 'billing@example.test' })
})

test('billing currentMtd sums only invoices dated to the current calendar month', () => {
  const r = buildInfisicalBilling(billingFixture)

  expect(r.currentMtd).toBe(25) // only the thisMonthUnix invoice (A-3, $25); A-1/A-2 are older
})

test('billing tolerates empty input and produces a valid summary + billing result', () => {
  const empty = buildInfisicalBilling({ invoices: [] })

  expect(empty.invoices).toEqual([])
  expect(empty.currentMtd).toBe(0)
  expect(empty.paymentMethod).toBeNull()
  expect(empty.subscription).toMatchObject({ planSlug: 'unknown', quantity: 0, monthlySubtotal: 0 })

  expect(validateCapabilityResult(buildInfisicalSummary({ invoices: [] }))).toEqual([])
  expect(validateCapabilityResult(buildInfisicalBillingResult({ invoices: [] }))).toEqual([])
})

test('summary is a valid billing result carrying spend.mtd + the monthly spark + plan/seat stats', () => {
  const result = buildInfisicalSummary(billingFixture)

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries?.[0]?.section).toBe('spend')
  expect(result.summaries?.[0]?.value).toBe(25)
  expect(result.summaries?.[0]?.spark).toMatchObject({ dataset: 'monthly', x: 'month', y: 'amount' })

  const account = result.datasets.find((d) => d.id === 'account')

  expect(account?.shape).toBe('record')

  if (account?.shape === 'record') {
    expect(account.value.plan).toBe('pro')
    expect(account.value.seats).toBe(3)
    expect(account.value.baseFee).toBe(54)
  }

  expect(result.summaries?.[0]?.basis).toBe('invoiced')
})

test('billing result exposes a downloadable invoices table + subscription/contact/card keyvalues', () => {
  const result = buildInfisicalBillingResult(billingFixture)

  expect(validateCapabilityResult(result)).toEqual([])

  const invoiceView = result.views?.find((v) => v.type === 'table' && v.dataset === 'invoices')

  expect(invoiceView).toMatchObject({ files: { source: { url: 'pdfUrl' }, ext: 'pdf' } })

  // keyed by the unique invoice number so an invoice's status accumulates as it flips open→paid.
  const invoices = result.datasets.find((d) => d.id === 'invoices')

  expect(invoices?.shape === 'table' && invoices.key).toBe('number')

  expect(result.datasets.map((d) => d.id)).toEqual(['subscription', 'contact', 'paymentMethod', 'invoices'])

  // The long invoices table renders last, after the compact context panels.
  expect(result.views?.at(-1)).toMatchObject({ type: 'table', dataset: 'invoices' })
})

test('billing result omits the payment-method keyvalue when no card is on file', () => {
  const result = buildInfisicalBillingResult({ ...billingFixture, paymentMethods: [] })

  expect(result.datasets.find((d) => d.id === 'paymentMethod')).toBeUndefined()
  expect(result.views?.some((v) => v.dataset === 'paymentMethod')).toBe(false)
})

// --- usage normalization ---

const usageFixture: InfisicalUsageInput = {
  plan: {
    plan: { slug: 'pro', status: 'active', membersUsed: 4, identitiesUsed: 2, workspacesUsed: 7, memberLimit: 10 }
  },
  productStats: {
    secretManager: { secretsCount: 128, environmentsCount: 3 },
    kms: { keysCount: 5 },
    customThing: { widgetsCount: 9 } // unknown group → humanized label
  },
  planTable: {
    rows: [
      { name: 'Audit logs', allowed: true, used: '29' },
      { name: 'SAML SSO', allowed: false, used: '-' } // '-' normalizes to em-dash
    ]
  }
}

test('humanizeMetric drops the Count suffix, splits camelCase, title-cases the head', () => {
  expect(humanizeMetric('secretsCount')).toBe('Secrets')
  expect(humanizeMetric('environmentsCount')).toBe('Environments')
  expect(humanizeMetric('widgetsCount')).toBe('Widgets')
})

test('usage maps seats to count metrics, joins product counts, and the feature/limit matrix', () => {
  const result = buildInfisicalUsage(usageFixture)

  expect(validateCapabilityResult(result)).toEqual([])

  const metrics = result.datasets.find((d) => d.id === 'metrics')

  expect(metrics?.shape).toBe('table')

  if (metrics?.shape === 'table') {
    expect(metrics.rows).toEqual([
      { label: 'Members', value: 4, unit: 'seats', limit: 10, cost: null },
      { label: 'Machine identities', value: 2, unit: 'seats', limit: null, cost: null },
      { label: 'Projects', value: 7, unit: 'projects', limit: null, cost: null }
    ])
  }

  const products = result.datasets.find((d) => d.id === 'products')

  if (products?.shape === 'table') {
    expect(products.rows).toContainEqual({ product: 'Secret Manager', metric: 'Secrets', count: 128 })
    expect(products.rows).toContainEqual({ product: 'KMS', metric: 'Keys', count: 5 })
    expect(products.rows).toContainEqual({ product: 'Custom Thing', metric: 'Widgets', count: 9 })
    // (product, metric) uniquely identifies a resource row → the ledger key.
    expect(products.key).toEqual(['product', 'metric'])
  }

  const features = result.datasets.find((d) => d.id === 'features')

  if (features?.shape === 'table') {
    expect(features.rows).toEqual([
      { name: 'Audit logs', allowed: 'Yes', used: '29' },
      { name: 'SAML SSO', allowed: 'No', used: '—' }
    ])
    // the feature name is unique in the plan matrix → the ledger key.
    expect(features.key).toBe('name')
  }
})

test('usage tolerates empty input and stays a valid result with no money summary', () => {
  const result = buildInfisicalUsage({})

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries).toBeUndefined() // seats carry no cost → no usage.primary
  expect(result.datasets.find((d) => d.id === 'products')).toBeUndefined()
  expect(result.datasets.find((d) => d.id === 'features')).toBeUndefined()
})

// --- members normalization (SYNTHETIC roster) ---

test('members maps membership.user first/last → name, plus email + top-level role', () => {
  const { members } = buildInfisicalMembers({
    users: [
      {
        id: 'mem_1',
        role: 'admin',
        user: { id: 'usr_1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' }
      },
      // No last name → name is just the first; no firstName → undefined name.
      {
        id: 'mem_2',
        role: 'member',
        user: { id: 'usr_2', firstName: 'Grace', lastName: null, email: 'grace@example.test' }
      },
      {
        id: 'mem_3',
        role: 'no-access',
        user: { id: 'usr_3', firstName: null, lastName: null, email: 'anon@example.test' }
      }
    ]
  })

  expect(members).toEqual([
    { id: 'mem_1', name: 'Ada Lovelace', email: 'ada@example.test', role: 'admin' },
    { id: 'mem_2', name: 'Grace', email: 'grace@example.test', role: 'member' },
    { id: 'mem_3', name: undefined, email: 'anon@example.test', role: 'no-access' }
  ])
})

test('members tolerates empty / missing input', () => {
  expect(buildInfisicalMembers({ users: [] }).members).toEqual([])
  expect(buildInfisicalMembers(undefined).members).toEqual([])
  expect(validateCapabilityResult(members.result(buildInfisicalMembers({ users: [] })))).toEqual([])
})

// --- descriptor ---

test('infisical is a rotating-refresh plugin over the jid cookie with an org config field', () => {
  expect(infisicalPlugin.auth.kind).toBe('rotating-refresh')
  expect('resolve' in infisicalPlugin.auth && typeof infisicalPlugin.auth.resolve === 'function').toBe(true)
  expect(infisicalPlugin.session?.requiredCookie).toBe('jid')
  expect(infisicalPlugin.session?.cookieDomains).toContain('infisical.com')
  expect(infisicalPlugin.transport?.engine ?? 'node').toBe('node')

  // The org id is auto-captured from the dashboard URL, so the config field is an optional override.
  const orgField = infisicalPlugin.config?.fields.find((f) => f.key === 'organizationId')

  expect(orgField).toMatchObject({ kind: 'text' })
  expect(orgField?.required).toBeFalsy()
  expect(infisicalPlugin.session?.captureFromUrl).toContainEqual({
    pattern: '/organizations/([0-9a-fA-F-]{36})',
    storeAs: 'organizationId'
  })

  expect(infisicalPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'usage', 'members'])
})

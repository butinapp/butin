import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { expect, test } from 'vitest'

import {
  basetenGraphqlError,
  basetenPlugin,
  buildBasetenBillingReport,
  buildBasetenBillingTab,
  buildBasetenKeys,
  buildBasetenMembers,
  buildBasetenSummaryResult,
  buildBasetenUsageReport,
  buildBasetenUsageResult
} from './main.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

test('baseten plugin is well-formed', () => {
  expect(basetenPlugin.meta.id).toBe('baseten')
  expect(basetenPlugin.meta.vendor).toBe('Baseten')
  expect(basetenPlugin.auth.kind).toBe('cookie')
  // node transport (AWS WAF, needs Origin) — NOT requiresBrowserEngine.
  expect(basetenPlugin.transport?.requiresBrowserEngine).toBeUndefined()
  expect(basetenPlugin.transport?.defaultHeaders?.Origin).toBe('https://app.baseten.co')
  expect(basetenPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'usage', 'keys', 'members'])
})

test('drops the stale WorkOS session cookie before capture', () => {
  // A lingering workos_session wedges the next sign-in into an authorize/refresh loop — clear it so a reconnect
  // re-auths cleanly.
  expect(basetenPlugin.session?.clearCookiesBeforeCapture).toContain('workos_session')
})

test('an expired-session GraphQL error is tagged 401 so core prompts Reconnect', () => {
  const expired = basetenGraphqlError('Invoices', ['The user does not have the authorization to perform the request'])

  expect(expired.status).toBe(401)
  expect(expired.message).toContain('[baseten] Invoices failed')

  // A genuine non-auth GraphQL error stays status-less (a normal fetch failure, not a dead session).
  expect(basetenGraphqlError('Usage', ["Cannot query field 'foo'"]).status).toBeUndefined()
})

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of basetenPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

const rawInvoices = [
  {
    created: '2026-04-01T00:00:00Z',
    periodStart: '2026-04-01',
    periodEnd: '2026-05-31',
    amount: 855_774,
    status: 'PAID',
    pdfLink: 'https://pay.example/may.pdf'
  },
  {
    created: '2026-03-01T00:00:00Z',
    periodStart: '2026-03-01',
    periodEnd: '2026-04-30',
    amount: 500_00,
    status: 'ISSUED',
    pdfLink: null
  }
]
const orgBudget = {
  organization: { currentNetSpend: { netSpendDollars: '2299.78084336', creditsUsedDollars: '36.00' } }
}
const credits = { organization: { creditGranted: 1_000_00, creditBalance: 250_00, paymentMethodStatus: 'valid' } }
const paymentMethod = { brand: 'visa', last4: '4242', paymentMethodTitle: 'Visa', paymentMethodSubtitle: '•••• 4242' }

test('buildBasetenBillingReport: cents vs dollar-string units, period_end dating', () => {
  const report = buildBasetenBillingReport(rawInvoices, paymentMethod, orgBudget, credits)

  // invoices[].amount is CENTS → dollars; dated by period_end, newest first.
  expect(report.invoices[0]).toMatchObject({ date: '2026-05-31', amount: 8557.74, status: 'paid' })
  expect(report.latestAmount).toBe(8557.74)
  // currentNetSpend is a DOLLAR string.
  expect(report.currentNetSpend).toBeCloseTo(2299.78, 2)
  expect(report.currentCreditsUsed).toBe(36)
  // monetary credits are CENTS.
  expect(report.creditGranted).toBe(1000)
  expect(report.creditBalance).toBe(250)
  expect(report.paymentMethod).toMatchObject({ brand: 'visa', last4: '4242' })
})

test('buildBasetenSummaryResult: spend.mtd summary from currentNetSpend', () => {
  const result = buildBasetenSummaryResult(buildBasetenBillingReport(rawInvoices, null, orgBudget, credits))

  expect(result.summaries?.[0]).toMatchObject({ section: 'spend', role: 'money', basis: 'accrued' })
  expect(result.summaries?.[0]?.value).toBeCloseTo(2299.78, 2)

  // Settled past-month invoices (dated by period_end) stay on the chart; only an invoice whose period_end lands
  // in the OPEN month is dropped so the live currentNetSpend fills that bar via backfill. These two are past.
  const monthly = result.datasets.find((d) => d.id === 'monthly')

  expect(monthly?.shape === 'table' && monthly.rows).toEqual([
    { month: '2026-04', amount: 500 },
    { month: '2026-05', amount: 8557.74 }
  ])
})

test('buildBasetenBillingTab: downloadable invoices + credits record, payment card optional', () => {
  const withCard = buildBasetenBillingTab(buildBasetenBillingReport(rawInvoices, paymentMethod, orgBudget, credits))

  expect(withCard.datasets.some((d) => d.id === 'paymentMethod')).toBe(true)
  const invoicesDs = withCard.datasets.find((d) => d.id === 'invoices')

  // Keyed on the stable invoice-URL id, not the date: Baseten reissues several invoices on one period_end date.
  expect(invoicesDs?.shape === 'table' && invoicesDs.key).toBe('id')
  const ids = invoicesDs?.shape === 'table' ? invoicesDs.rows.map((r) => r.id) : []

  expect(new Set(ids).size).toBe(ids.length)
  const tableView = withCard.views?.find((v) => v.type === 'table')

  expect(tableView && 'files' in tableView && tableView.files?.ext).toBe('pdf')

  const noCard = buildBasetenBillingTab(buildBasetenBillingReport(rawInvoices, null, orgBudget, credits))

  expect(noCard.datasets.some((d) => d.id === 'paymentMethod')).toBe(false)
})

const usageSummary = {
  usageSummaryForDateRange: {
    dedicatedUsage: {
      currentPeriodTotal: '2299.78',
      startDate: '2026-06-01T00:00:00Z',
      endDate: '2026-06-30T00:00:00Z',
      productCategoryUsages: [
        {
          category: 'MODEL_INFERENCE',
          items: [
            {
              minutes: 1200,
              cost: '36.00',
              requests: '1008817',
              entity: { name: 'llama-3', oracle: { name: 'Llama 3 70B' } },
              billingEntity: { instanceType: 'H100', environmentName: 'production' },
              usagePerDay: [
                { date: '2026-06-01', cost: '12.00', requests: '500000' },
                { date: '2026-06-02', cost: '24.00', requests: '508817' }
              ]
            }
          ]
        }
      ]
    },
    trainingUsage: { minutes: '300', cost: '15.50' }
  }
}

test('buildBasetenUsageReport: dollar-string costs, string counts, per-day aggregation', () => {
  const report = buildBasetenUsageReport(usageSummary, { start: '2026-06-01', end: '2026-06-30' })

  expect(report.dedicatedTotal).toBeCloseTo(2299.78, 2)
  expect(report.trainingCost).toBe(15.5)
  expect(report.models[0]).toMatchObject({ model: 'Llama 3 70B', instanceType: 'H100', requests: 1_008_817, cost: 36 })
  expect(report.totalRequests).toBe(1_008_817)
  expect(report.daily).toEqual([
    { date: '2026-06-01', cost: 12, requests: 500_000 },
    { date: '2026-06-02', cost: 24, requests: 508_817 }
  ])
})

test('buildBasetenUsageResult: usage.primary = dedicated + training, daily spark', () => {
  const result = buildBasetenUsageResult(
    buildBasetenUsageReport(usageSummary, { start: '2026-06-01', end: '2026-06-30' })
  )

  expect(result.summaries?.[0]).toMatchObject({ section: 'other', role: 'money' })
  expect(result.summaries?.[0]?.value).toBeCloseTo(2315.28, 2) // 2299.78 + 15.50
  expect(result.summaries?.[0]?.spark).toMatchObject({ dataset: 'daily', x: 'date', y: 'cost' })

  // Each usage row is one (model, instance, environment) deployment — keyed as that triple.
  const modelsDs = result.datasets.find((d) => d.id === 'models')

  expect(modelsDs?.shape === 'table' && modelsDs.key).toEqual(['model', 'instanceType', 'environment'])
})

test('buildBasetenKeys: org + user keys → apiKeys input with revoked status', () => {
  const input = buildBasetenKeys([{ id: 'org_k1', revoked: false }], [{ id: 'user_k1', revoked: true }])

  expect(input.keys).toEqual([
    { id: 'org_k1', name: 'Org key', masked: 'org_k1', revoked: false },
    { id: 'user_k1', name: 'User key', masked: 'user_k1', revoked: true }
  ])
})

test('buildBasetenMembers: members + non-duplicate pending invites', () => {
  const input = buildBasetenMembers(
    [{ id: 'u1', name: 'Alice', email: 'alice@example.com', username: 'alice', roleName: 'admin', status: 'APPROVED' }],
    [
      { id: 'i1', email: 'bob@example.com', roleName: 'member', invited: true },
      { id: 'i2', email: 'alice@example.com', roleName: 'admin', invited: true } // already a member → dropped
    ]
  )

  expect(input.members).toEqual([
    { id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'admin' },
    { id: 'i1', email: 'bob@example.com', role: 'member (invited)' }
  ])
})

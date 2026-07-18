import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { expect, test } from 'vitest'

import {
  buildSentryBillingReport,
  buildSentryBillingResult,
  buildSentryMembers,
  buildSentrySummaryResult,
  buildSentryUsageReport,
  discoverOrgSlug,
  pickOrgSlug,
  sentryPlugin
} from './main.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of sentryPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

test('pickOrgSlug returns the first org with a slug', () => {
  expect(pickOrgSlug([{ slug: 'acme' }, { slug: 'beta' }])).toBe('acme')
  expect(pickOrgSlug([{}, { slug: 'beta' }])).toBe('beta')
  expect(pickOrgSlug([])).toBeUndefined()
})

test('discoverOrgSlug fetches /api/0/organizations and picks one', async () => {
  const get = async <T>(_url: string): Promise<T> => [{ slug: 'acme' }] as unknown as T

  expect(await discoverOrgSlug(get)).toBe('acme')
})

test('buildSentryBillingReport: cents→USD net-of-refund, newest first, MTD from on-demand', () => {
  const report = buildSentryBillingReport(
    [
      { id: 'a', amountBilled: 9000, amountRefunded: 0, isPaid: true, dateCreated: '2026-05-01T00:00:00Z' },
      {
        id: 'b',
        amount: 20000,
        amountRefunded: 5000,
        isPaid: false,
        dateCreated: '2026-06-01T00:00:00Z',
        receipt: { url: 'https://x/pdf' }
      }
    ],
    { plan: 'team', planDetails: { name: 'Team' }, onDemandSpendUsed: 1234 }
  )

  expect(report.plan).toBe('Team')
  expect(report.currentMtd).toBe(12.34)
  // newest first
  expect(report.invoices[0]?.date).toBe('2026-06-01')
  expect(report.invoices[0]?.status).toBe('open')
  expect(report.invoices[0]?.amount).toBe(150) // (20000 - 5000) cents
  expect(report.invoices[0]?.pdfUrl).toBe('https://x/pdf')
  expect(report.invoices[1]?.amount).toBe(90)
})

test('buildSentryUsageReport maps accepted/reserved/onDemand→metrics, cents→USD, sorted by cost', () => {
  const report = buildSentryUsageReport(
    { totals: { errors: { accepted: 1200 }, replays: { accepted: 50 } } },
    {
      categories: [
        { category: 'errors', reserved: 5000, onDemandSpendUsed: 0 },
        { category: 'replays', reserved: 500, onDemandSpendUsed: 2500 }
      ],
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30'
    }
  )

  expect(report.periodStart).toBe('2026-06-01')
  expect(report.metrics.find((m) => m.label === 'Errors')).toMatchObject({ value: 1200, limit: 5000, cost: 0 })
  expect(report.metrics.find((m) => m.label === 'Replays')).toMatchObject({ value: 50, limit: 500, cost: 25 })
  // sorted by cost desc → Replays (25) before Errors (0)
  expect(report.metrics[0]?.label).toBe('Replays')
})

test('buildSentryUsageReport accepts categories as a name-keyed dict (live /history/current/ shape)', () => {
  const report = buildSentryUsageReport(
    { totals: { errors: { accepted: 1200 } } },
    {
      categories: {
        errors: { reserved: 5000, onDemandSpendUsed: 0 },
        replays: { reserved: 500, onDemandSpendUsed: 2500 }
      },
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30'
    }
  )

  expect(report.metrics.find((m) => m.label === 'Errors')).toMatchObject({ value: 1200, limit: 5000, cost: 0 })
  expect(report.metrics.find((m) => m.label === 'Replays')).toMatchObject({ value: 0, limit: 500, cost: 25 })
})

test('buildSentrySummaryResult: kind-billing headline (MTD + plan + invoice count) + monthly spark', () => {
  const report = buildSentryBillingReport(
    [
      { id: 'a', amountBilled: 9000, isPaid: true, dateCreated: '2026-05-01T00:00:00Z' },
      { id: 'b', amount: 15000, isPaid: false, dateCreated: '2026-06-01T00:00:00Z' }
    ],
    { planDetails: { name: 'Team' }, onDemandSpendUsed: 1234 }
  )
  const result = buildSentrySummaryResult(report)

  const account = result.datasets.find((d) => d.id === 'account')

  expect(account?.shape).toBe('record')
  expect((account as { value: Record<string, unknown> }).value).toMatchObject({
    currentMtd: 12.34,
    plan: 'Team',
    invoiceCount: 2
  })
  // the monthly dataset is the spark target
  expect(result.summaries?.[0]).toMatchObject({
    section: 'spend',
    value: 12.34,
    basis: 'accrued',
    spark: { dataset: 'monthly' }
  })
  expect(result.datasets.find((d) => d.id === 'monthly')?.shape).toBe('table')
  // no invoices table on Summary — that's the detail tab
  expect(result.datasets.find((d) => d.id === 'invoices')).toBeUndefined()
})

test('buildSentrySummaryResult omits the summary when MTD is null (Overview skips the provider)', () => {
  const report = buildSentryBillingReport([], { plan: 'team' }) // no onDemandSpendUsed → currentMtd null
  const result = buildSentrySummaryResult(report)

  expect(report.currentMtd).toBeNull()
  expect(result.summaries).toBeUndefined()
})

test('buildSentryBillingResult: invoicing detail is just the invoices table (no headline)', () => {
  const report = buildSentryBillingReport(
    [{ id: 'b', amount: 15000, isPaid: false, dateCreated: '2026-06-01T00:00:00Z', receipt: { url: 'https://x/pdf' } }],
    { onDemandSpendUsed: 1234 }
  )
  const result = buildSentryBillingResult(report)

  expect(result.datasets.map((d) => d.id)).toEqual(['invoices'])
  // Keyed by the raw invoice id (threaded through, hidden) so an invoice accumulates past the fetch window.
  expect((result.datasets[0] as { key?: string }).key).toBe('id')
  const rows = (result.datasets[0] as { rows: Record<string, unknown>[] }).rows

  expect(rows[0]).toMatchObject({ id: 'b', date: '2026-06-01', amount: 150, status: 'open', pdfUrl: 'https://x/pdf' })
  // the invoices table is downloadable (per-row receipt PDF)
  const view = result.views?.find((v) => v.type === 'table' && v.dataset === 'invoices') as { files?: unknown }

  expect(view.files).toMatchObject({ name: 'name', source: { url: 'pdfUrl' }, ext: 'pdf' })
})

test('buildSentryMembers flattens user-nested name/email and keeps role', () => {
  const report = buildSentryMembers([
    { id: '1', email: 'a@x.com', name: 'Ann', role: 'owner' },
    { id: '2', role: 'member', user: { email: 'b@x.com', name: 'Bob' } }
  ])

  expect(report.members).toHaveLength(2)
  expect(report.members[0]).toEqual({ id: '1', email: 'a@x.com', name: 'Ann', role: 'owner' })
  expect(report.members[1]).toEqual({ id: '2', email: 'b@x.com', name: 'Bob', role: 'member' })
})

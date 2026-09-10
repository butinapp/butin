import { billing, keys, usage } from '@butinapp/sdk/presets'
import { createSampleGen, resolveSampleConfig, resultValidator, validateSamples } from '@butinapp/sdk/testing'
import { currentMonthKey } from '@butinapp/sdk/util'
import { expect, test } from 'vitest'

import {
  buildSerperBilling,
  buildSerperBillingResult,
  buildSerperDaily,
  buildSerperKeys,
  buildSerperPaymentMethod,
  buildSerperSummaryResult,
  buildSerperUsageMetrics,
  buildSerperUsageResult,
  maskKey,
  serperPlugin
} from './main.js'
import { sampleSerperBilling, sampleSerperKeys } from './sample.js'

const validateCapabilityResult = resultValidator('USD')

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(serperPlugin)).toEqual([])
})

test('serper sample generators are synthetic and scale with the documents/users knobs', () => {
  const small = sampleSerperBilling(createSampleGen('serper:t'), resolveSampleConfig({ size: 'small' }))
  const large = sampleSerperBilling(createSampleGen('serper:t'), resolveSampleConfig({ size: 'large' }))

  expect(large.payments.length).toBeGreaterThanOrEqual(small.payments.length)
  expect(small.payments.every((p) => (p.receiptUrl ?? '').includes('example.invalid'))).toBe(true)
  expect(sampleSerperKeys(createSampleGen('serper:t'), resolveSampleConfig({ users: 4 })).keys.length).toBe(4)
})

test('serper is a plain cookie session (username/password)', () => {
  expect(serperPlugin.auth.kind).toBe('cookie')
  expect(serperPlugin.session?.cookieDomains).toContain('serper.dev')
})

// --- billing ---

test('billing parses dollar-string amounts (no /100), newest first, uppercased currency', () => {
  const r = buildSerperBilling([
    { amount: '57.49', currency: 'usd', date: '2026-05-19T09:59:05.000Z', receiptUrl: 'https://my.paddle.com/r/1' },
    { amount: '20.00', date: '2026-04-01T00:00:00.000Z' }
  ])

  expect(r.invoices[0]).toMatchObject({ date: '2026-05-19', amount: 57.49, status: 'paid' })
  expect(r.invoices[0].hostedUrl).toBe('https://my.paddle.com/r/1')
  expect(r.invoices[1].amount).toBe(20)
  expect(r.currency).toBe('USD')
})

test('billing currentMtd sums only payments in the current calendar month', () => {
  const ym = currentMonthKey()
  const r = buildSerperBilling([
    { amount: '10.00', date: `${ym}-15T00:00:00Z` },
    { amount: '5.00', date: '2000-01-01T00:00:00Z' }
  ])

  expect(r.currentMtd).toBe(10)
})

test('billing tolerates empty/missing payments and maps to a valid result', () => {
  expect(buildSerperBilling(null)).toMatchObject({ currentMtd: 0, invoices: [] })
  expect(
    validateCapabilityResult(billing.result(buildSerperBilling([{ amount: '12.00', date: '2026-05-01T00:00:00Z' }])))
  ).toEqual([])
})

// --- usage ---

test('usage maps credit figures to count metrics in balance/today/last-month order', () => {
  expect(buildSerperUsageMetrics({ creditBalance: 1000, usageToday: 12, usageLastMonth: 340 })).toEqual([
    { label: 'Credit balance', value: 1000, unit: 'credits' },
    { label: 'Used today', value: 12, unit: 'credits' },
    { label: 'Used last month', value: 340, unit: 'credits' }
  ])
  expect(buildSerperUsageMetrics(null).every((m) => m.value === 0)).toBe(true)
})

test('usage result is valid and emits no money summary (credits are not money)', () => {
  const result = usage.result({ metrics: buildSerperUsageMetrics({ creditBalance: 5 }) })

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries).toBeUndefined()
})

// --- usage: daily trend ---

test('daily trend maps buckets to date/credits, drops undated, sorts oldest→newest', () => {
  const points = buildSerperDaily({
    data: [{ start: '2026-06-02T00:00:00Z', count: 20 }, { start: '2026-06-01T00:00:00Z', count: 10 }, { count: 5 }]
  })

  expect(points).toEqual([
    { date: '2026-06-01', credits: 10 },
    { date: '2026-06-02', credits: 20 }
  ])
  expect(buildSerperDaily(null)).toEqual([])
})

test('usage result appends a daily timeseries when buckets exist; valid either way', () => {
  const withTrend = buildSerperUsageResult(
    { creditBalance: 5 },
    { data: [{ start: '2026-06-01T00:00:00Z', count: 10 }] }
  )

  expect(validateCapabilityResult(withTrend)).toEqual([])
  expect(withTrend.datasets.some((d) => d.id === 'daily')).toBe(true)
  // Keyed by day so each day's credits accumulate past the trailing fetch window.
  expect((withTrend.datasets.find((d) => d.id === 'daily') as { key?: string }).key).toBe('date')
  expect(
    withTrend.views?.some((v) => v.type === 'timeseries' && v.dataset === 'daily' && v.granularity === 'daily')
  ).toBe(true)

  const noTrend = buildSerperUsageResult({ creditBalance: 5 }, null)

  expect(validateCapabilityResult(noTrend)).toEqual([])
  expect(noTrend.datasets.some((d) => d.id === 'daily')).toBe(false)
})

// --- apiKeys ---

test('maskKey keeps only the last 4 chars; empty degrades to an em dash', () => {
  expect(maskKey('a3874ba30b3b20')).toBe('…3b20')
  expect(maskKey()).toBe('—')
})

test('apiKeys builds the inventory with masked secrets and active/revoked status', () => {
  const r = buildSerperKeys([
    { id: 1, key: 'abcd1234', name: 'prod', createdAt: '2026-01-02T00:00:00Z' },
    { id: 2, key: 'wxyz5678', revokedAt: '2026-03-01T00:00:00Z' }
  ] as never)

  expect(r.keys[0]).toMatchObject({ name: 'prod', masked: '…1234', revoked: false })
  expect(r.keys[1]).toMatchObject({ name: '(unnamed)', masked: '…5678', revoked: true })
  expect(validateCapabilityResult(keys.result(buildSerperKeys([{ id: '1', key: 'k', name: 'n' }])))).toEqual([])
})

// --- billing: payment method ---

test('payment method maps card fields; null when no card on file', () => {
  expect(
    buildSerperPaymentMethod({ paymentMethod: 'card', cardType: 'visa', lastFourDigits: '7059', expiryDate: '08/2029' })
  ).toEqual({ method: 'card', cardType: 'visa', lastFour: '7059', expiry: '08/2029' })
  expect(buildSerperPaymentMethod(null)).toBeNull()
  expect(buildSerperPaymentMethod({ cardType: 'visa' })).toBeNull()
})

test('billing result appends a paymentMethod record + keyvalue view when a card is present', () => {
  const withCard = buildSerperBillingResult([{ amount: '12.00', date: '2026-05-01T00:00:00Z' }], {
    paymentMethod: 'card',
    cardType: 'master',
    lastFourDigits: '4242',
    expiryDate: '01/2030'
  })

  expect(validateCapabilityResult(withCard)).toEqual([])
  expect(withCard.datasets.some((d) => d.id === 'paymentMethod')).toBe(true)
  expect(withCard.views?.some((v) => v.type === 'keyvalue' && v.dataset === 'paymentMethod')).toBe(true)

  const noCard = buildSerperBillingResult([{ amount: '12.00', date: '2026-05-01T00:00:00Z' }], null)

  expect(validateCapabilityResult(noCard)).toEqual([])
  expect(noCard.datasets.some((d) => d.id === 'paymentMethod')).toBe(false)
})

// --- Summary (kind billing) ---

test('buildSerperSummaryResult: kind-billing headline (MTD + payment count) + monthly spark; no invoices table', () => {
  const ym = currentMonthKey()
  const result = buildSerperSummaryResult([
    { amount: '10.00', date: `${ym}-15T00:00:00Z` },
    { amount: '20.00', date: '2026-01-01T00:00:00Z' }
  ])

  expect(validateCapabilityResult(result)).toEqual([])
  const account = result.datasets.find((d) => d.id === 'account') as unknown as { value: Record<string, unknown> }

  expect(account.value).toMatchObject({ currentMtd: 10, invoiceCount: 2 })
  expect(result.summaries?.[0]).toMatchObject({
    section: 'spend',
    value: 10,
    basis: 'invoiced',
    spark: { dataset: 'monthly' }
  })
  expect(result.datasets.some((d) => d.id === 'invoices')).toBe(false)
})

// --- Billing detail: the downloadable invoices table (replaces the separate documents tab) ---

test('billing invoices table is downloadable (receiptUrl), carries a filename row field, and skips null receipts', () => {
  const result = buildSerperBillingResult(
    [
      { amount: '57.49', date: '2026-05-19T09:59:05.000Z', receiptUrl: 'https://my.paddle.com/r/1' },
      { amount: '20.00', date: '2026-04-01T00:00:00.000Z', receiptUrl: null }
    ],
    null
  )

  expect(validateCapabilityResult(result)).toEqual([])
  const view = result.views?.find((v) => v.type === 'table' && v.dataset === 'invoices') as { files?: unknown }

  expect(view.files).toMatchObject({ source: { url: 'receiptUrl' }, name: 'name', ext: 'pdf', category: 'Invoices' })

  const invoicesDs = result.datasets.find((d) => d.id === 'invoices') as unknown as {
    key: string
    rows: Record<string, unknown>[]
  }

  // Keyed on the payment date so each payment accumulates in the ledger past the fetch window.
  expect(invoicesDs.key).toBe('date')
  const rows = invoicesDs.rows

  expect(rows[0]).toMatchObject({
    date: '2026-05-19',
    receiptUrl: 'https://my.paddle.com/r/1',
    name: 'Invoice 2026-05-19'
  })
  expect(rows[1]).toMatchObject({ receiptUrl: null })
})

test('serper leads with a Summary tab and has no separate documents capability', () => {
  expect(serperPlugin.capabilities[0]).toMatchObject({ id: 'summary' })
  expect(serperPlugin.capabilities.some((c) => 'enumerate' in c)).toBe(false)
})

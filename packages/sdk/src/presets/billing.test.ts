import { expect, test } from 'vitest'

import { resolveCurrencies } from '../data/currency.js'
import { validateCapabilityResult } from '../data/result.js'
import { SummarySchema } from '../data/summary.js'

import { billingResult, billingSummaryResult, monthlySpend } from './billing.js'

const sample = billingResult({
  currentMtd: 42.1,
  plan: 'Pro',
  currency: 'USD',
  invoices: [
    { date: '2026-05-10', amount: 30, status: 'paid', pdfUrl: 'https://x/a.pdf' },
    { date: '2026-05-20', amount: 12.1, status: 'paid' },
    { date: '2026-04-15', amount: 25, status: 'paid' }
  ]
})

test('billingResult produces a valid CapabilityResult', () => {
  expect(validateCapabilityResult(resolveCurrencies(sample, 'USD'))).toEqual([])
})

test('billingResult emits account, invoices, and a monthly rollup', () => {
  const ids = sample.datasets.map((d) => d.id).sort()

  expect(ids).toEqual(['account', 'invoices', 'monthly'])
})

test('billingResult keys invoices (on id) and the monthly rollup (on month) for accumulation', () => {
  const byId = Object.fromEntries(sample.datasets.map((d) => [d.id, d]))
  const invoices = byId.invoices
  const monthly = byId.monthly

  if (invoices.shape !== 'table' || monthly.shape !== 'table') {
    throw new Error('expected tables')
  }

  expect(invoices.key).toBe('id')
  expect(monthly.key).toBe('month')
  expect(invoices.rows[0]!.id).toBe('2026-05-10:30') // date+amount fallback when the provider gives no id
  expect(validateCapabilityResult(resolveCurrencies(sample, 'USD'))).toEqual([])
})

test('the monthly rollup sums invoice amounts per YYYY-MM, sorted ascending', () => {
  const monthly = sample.datasets.find((d) => d.id === 'monthly')!

  expect(monthly.shape).toBe('table')

  if (monthly.shape !== 'table') {
    return
  }

  expect(monthly.rows).toEqual([
    { month: '2026-04', amount: 25 },
    { month: '2026-05', amount: 42.1 }
  ])
})

test('the summary is a spend section in money with the monthly sparkline', () => {
  expect(sample.summaries?.[0]).toMatchObject({
    section: 'spend',
    value: 42.1,
    role: 'money',
    spark: { dataset: 'monthly', x: 'month', y: 'amount' }
  })
})

test('no invoices yet: empty monthly rollup, still a valid result', () => {
  const empty = billingResult({ currentMtd: 0, invoices: [] })

  expect(validateCapabilityResult(resolveCurrencies(empty, 'USD'))).toEqual([])
  const monthly = empty.datasets.find((d) => d.id === 'monthly')!

  if (monthly.shape !== 'table') {
    throw new Error('monthly should be a table')
  }

  expect(monthly.rows).toEqual([])
})

test('summing many two-decimal amounts in a month does not drift', () => {
  const r = billingResult({
    currentMtd: 0,
    invoices: [
      { date: '2026-05-01', amount: 10.1, status: 'paid' },
      { date: '2026-05-02', amount: 20.2, status: 'paid' },
      { date: '2026-05-03', amount: 0.1, status: 'paid' }
    ]
  })
  const monthly = r.datasets.find((d) => d.id === 'monthly')!

  if (monthly.shape !== 'table') {
    throw new Error('monthly should be a table')
  }

  expect(monthly.rows).toEqual([{ month: '2026-05', amount: 30.4 }])
})

test('a null currentMtd renders as a blank account value and emits no summary', () => {
  const r = billingResult({ currentMtd: null, invoices: [] })

  expect(validateCapabilityResult(resolveCurrencies(r, 'USD'))).toEqual([])
  expect(r.summaries).toBeUndefined()
  const account = r.datasets.find((d) => d.id === 'account')!

  if (account.shape !== 'record') {
    throw new Error('account should be a record')
  }

  expect(account.value.currentMtd).toBeNull()
})

test('a numeric currentMtd still emits the spend summary', () => {
  const r = billingResult({ currentMtd: 10, invoices: [] })

  expect(r.summaries?.[0]).toMatchObject({ section: 'spend', value: 10, role: 'money' })
})

// --- monthlySpend (shared bucketing) ---

test('monthlySpend buckets by YYYY-MM ascending, rounds per month, skips undated', () => {
  expect(
    monthlySpend([
      { date: '2026-05-10', amount: 10.1, status: 'paid' },
      { date: '2026-05-02', amount: 20.2, status: 'paid' },
      { date: '2026-04-15', amount: 25, status: 'paid' },
      { date: undefined, amount: 99, status: 'paid' }
    ])
  ).toEqual([
    { month: '2026-04', amount: 25 },
    { month: '2026-05', amount: 30.3 }
  ])
})

// --- billingSummaryResult (the Summary tab preset) ---

const summary = billingSummaryResult({
  currentMtd: 42.1,
  plan: 'Pro',
  currency: 'USD',
  invoices: [
    { date: '2026-05-10', amount: 30, status: 'paid' },
    { date: '2026-04-15', amount: 25, status: 'paid' }
  ],
  stats: [{ key: 'invoiceCount', label: 'Invoices', role: 'count', value: 2 }]
})

test('billingSummaryResult: account stat + monthly chart + spend.mtd summary, NO invoices table', () => {
  expect(validateCapabilityResult(resolveCurrencies(summary, 'USD'))).toEqual([])
  expect(summary.datasets.map((d) => d.id).sort()).toEqual(['account', 'monthly'])
  const account = summary.datasets.find((d) => d.id === 'account')!

  if (account.shape !== 'record') {
    throw new Error('account should be a record')
  }

  expect(account.value).toMatchObject({ currentMtd: 42.1, plan: 'Pro', invoiceCount: 2 })
  expect(summary.summaries?.[0]).toMatchObject({
    section: 'spend',
    value: 42.1,
    spark: { dataset: 'monthly', x: 'month', y: 'amount' }
  })
})

test('billingSummaryResult: a label override drives the currentMtd field + summary label', () => {
  const r = billingSummaryResult({ currentMtd: 5, currentMtdLabel: 'Montant dû', currency: 'CAD', invoices: [] })
  const account = r.datasets.find((d) => d.id === 'account')!

  if (account.shape !== 'record') {
    throw new Error('account should be a record')
  }

  expect(account.fields[0]).toMatchObject({ key: 'currentMtd', label: 'Montant dû' })
  expect(r.summaries?.[0]).toMatchObject({ label: 'Montant dû', value: 5 })
})

test('billingSummaryResult: null currentMtd omits the summary, omitted plan adds no plan field', () => {
  const r = billingSummaryResult({ currentMtd: null, currency: 'USD', invoices: [] })

  expect(validateCapabilityResult(resolveCurrencies(r, 'USD'))).toEqual([])
  expect(r.summaries).toBeUndefined()
  const account = r.datasets.find((d) => d.id === 'account')!

  if (account.shape !== 'record') {
    throw new Error('account should be a record')
  }

  expect(account.fields.some((f) => f.key === 'plan')).toBe(false)
})

test('billingResult: credits + paymentMethod add keyvalue panels; invoiceDownload wires the table', () => {
  const r = billingResult({
    currentMtd: 10,
    currency: 'USD',
    invoices: [{ date: '2026-05-10', amount: 30, status: 'paid', pdfUrl: 'https://x/a.pdf' }],
    credits: { balance: 50, granted: 100 },
    paymentMethod: { brand: 'visa', last4: '4242' },
    invoiceDownload: true
  })

  expect(validateCapabilityResult(resolveCurrencies(r, 'USD'))).toEqual([])
  expect(r.datasets.map((d) => d.id).sort()).toEqual(['account', 'credits', 'invoices', 'monthly', 'paymentMethod'])

  const credits = r.datasets.find((d) => d.id === 'credits')!

  expect(credits.shape === 'record' && credits.value).toEqual({ balance: 50, granted: 100 })

  const invoicesView = r.views?.find((v) => v.type === 'table' && v.dataset === 'invoices')

  expect(invoicesView?.type === 'table' && invoicesView.files).toMatchObject({
    source: { url: 'pdfUrl' },
    name: 'name',
    ext: 'pdf',
    category: 'Invoices'
  })

  const invoices = r.datasets.find((d) => d.id === 'invoices')!

  expect(invoices.shape === 'table' && invoices.rows[0].name).toBe('Invoice 2026-05-10')
})

test('billingResult emits sections in declarative order: stat → paymentMethod → credits → monthly → invoices', () => {
  const r = billingResult({
    currentMtd: 130,
    baseFee: 100,
    meteredMtd: 30,
    mtdBasis: 'accrued',
    currency: 'USD',
    invoices: [
      { date: '2026-04-15', amount: 25, status: 'paid' },
      { date: '2026-05-10', amount: 130, status: 'paid', pdfUrl: 'https://x/a.pdf' }
    ],
    credits: { balance: 50, granted: 100 },
    paymentMethod: { brand: 'visa', last4: '4242' },
    invoiceDownload: true
  })

  expect(r.views?.map((v) => `${v.type}:${v.dataset}`)).toEqual([
    'stat:account',
    'keyvalue:paymentMethod',
    'keyvalue:credits',
    'timeseries:monthly',
    'table:invoices'
  ])
  expect(r.summaries?.[0]?.basis).toBe('accrued')
  expect(validateCapabilityResult(resolveCurrencies(r, 'USD'))).toEqual([])
})

test('billingResult: credits inherit the billing currency when not overridden', () => {
  const r = billingResult({ currentMtd: 0, currency: 'CAD', invoices: [], credits: { balance: 5 } })
  const credits = r.datasets.find((d) => d.id === 'credits')!

  if (credits.shape !== 'record') {
    throw new Error('credits should be a record')
  }

  expect(credits.fields[0].currency).toBe('CAD')
})

test('the invoice status column auto-tones; statusTones supplies only overrides', () => {
  const statusCol = (r: typeof sample) => {
    const t = r.datasets.find((d) => d.id === 'invoices')!

    if (t.shape !== 'table') {
      throw new Error('invoices should be a table')
    }

    return t.columns.find((c) => c.key === 'status')
  }

  // Common statuses (paid/open/failed) auto-tone in the renderer, so the default column carries no map.
  expect(statusCol(sample)?.role).toBe('status')
  expect(statusCol(sample)?.badges).toBeUndefined()

  // statusTones is the override hatch — only the caller's entries land on the column (the renderer still
  // auto-tones everything else).
  const overridden = billingResult({ currentMtd: 0, invoices: [], statusTones: { open: 'danger', draft: 'neutral' } })

  expect(statusCol(overridden)?.badges).toEqual({ open: 'danger', draft: 'neutral' })
})

// --- Summary schema: section + optional basis ---

test('summary accepts a section and an optional basis', () => {
  const parsed = SummarySchema.parse({
    section: 'other',
    label: 'Revenue',
    value: 10,
    role: 'money',
    basis: 'invoiced'
  })

  expect(parsed.section).toBe('other')
  expect(parsed.basis).toBe('invoiced')
})

// --- base / overage cells + mtd basis ---

test('billingSummaryResult renders base + overage cells and tags the basis', () => {
  const r = billingSummaryResult({
    currentMtd: 130,
    baseFee: 100,
    meteredMtd: 30,
    mtdBasis: 'accrued',
    currency: 'USD',
    plan: 'Pro',
    invoices: []
  })
  const account = r.datasets.find((d) => d.id === 'account')!
  const keys = account.shape === 'record' ? account.fields.map((f) => f.key) : []

  expect(keys).toEqual(expect.arrayContaining(['currentMtd', 'baseFee', 'meteredMtd', 'plan']))
  expect(r.summaries?.[0]?.basis).toBe('accrued')
})

test('billingSummaryResult omits base/overage cells when not provided, and basis defaults to invoiced', () => {
  const r = billingSummaryResult({ currentMtd: 50, currency: 'USD', invoices: [] })
  const account = r.datasets.find((d) => d.id === 'account')!
  const keys = account.shape === 'record' ? account.fields.map((f) => f.key) : []

  expect(keys).not.toContain('baseFee')
  expect(keys).not.toContain('meteredMtd')
  expect(r.summaries?.[0]?.basis).toBe('invoiced')
})

test('billingResult renders base + overage cells and tags the basis', () => {
  const r = billingResult({
    currentMtd: 130,
    baseFee: 100,
    meteredMtd: 30,
    mtdBasis: 'accrued',
    currency: 'USD',
    invoices: []
  })
  const account = r.datasets.find((d) => d.id === 'account')!
  const keys = account.shape === 'record' ? account.fields.map((f) => f.key) : []

  expect(keys).toEqual(expect.arrayContaining(['currentMtd', 'baseFee', 'meteredMtd', 'plan']))
  expect(account.shape === 'record' && account.value).toMatchObject({ baseFee: 100, meteredMtd: 30 })
  expect(r.summaries?.[0]?.basis).toBe('accrued')
})

// --- month-over-month delta ---

test('invoiced basis: delta compares currentMtd against the prior month and renders as momDelta', () => {
  const r = billingSummaryResult({
    currentMtd: 42.1,
    currency: 'USD',
    invoices: [
      { date: '2026-04-15', amount: 25, status: 'paid' },
      { date: '2026-05-10', amount: 42.1, status: 'paid' }
    ]
  })
  const account = r.datasets.find((d) => d.id === 'account')!

  expect(account.shape === 'record' && account.value.momDelta).toBe(17.1) // 42.1 − 25
})

test('accrued basis: delta compares the live currentMtd against the last full month', () => {
  const r = billingSummaryResult({
    currentMtd: 130,
    mtdBasis: 'accrued',
    currency: 'USD',
    invoices: [{ date: '2026-05-10', amount: 30, status: 'paid' }]
  })
  const account = r.datasets.find((d) => d.id === 'account')!

  expect(account.shape === 'record' && account.value.momDelta).toBe(100) // 130 − 30 (last full month)
})

test('showDelta:false suppresses the delta even when a baseline month exists', () => {
  const r = billingSummaryResult({
    currentMtd: 130,
    mtdBasis: 'accrued',
    showDelta: false,
    currency: 'USD',
    invoices: [
      { date: '2026-04-10', amount: 30, status: 'paid' },
      { date: '2026-05-10', amount: 80, status: 'paid' }
    ]
  })
  const account = r.datasets.find((d) => d.id === 'account')!
  const keys = account.shape === 'record' ? account.fields.map((f) => f.key) : []

  expect(keys).not.toContain('momDelta')
})

test('a single month (no prior baseline) emits no delta cell', () => {
  const r = billingSummaryResult({
    currentMtd: 42.1,
    currency: 'USD',
    invoices: [{ date: '2026-05-10', amount: 42.1, status: 'paid' }]
  })
  const account = r.datasets.find((d) => d.id === 'account')!
  const keys = account.shape === 'record' ? account.fields.map((f) => f.key) : []

  expect(keys).not.toContain('momDelta')
})

test('a status stat carries its badge tones onto the rendered column', () => {
  const r = billingSummaryResult({
    currentMtd: 10,
    currency: 'USD',
    invoices: [],
    stats: [{ key: 'pay', label: 'Payment', role: 'status', value: 'delinquent', badges: { delinquent: 'danger' } }]
  })
  const account = r.datasets.find((d) => d.id === 'account')!
  const col = account.shape === 'record' ? account.fields.find((f) => f.key === 'pay') : undefined

  expect(col?.badges).toEqual({ delinquent: 'danger' })
})

// --- rich stat presentation (max/unit/caption/tone forwarded onto the stat view fields) ---

test('billingSummaryResult forwards rich-stat presentation onto the stat view fields', () => {
  const r = billingSummaryResult({
    currentMtd: 42.1,
    currentMtdCaption: 'invoiced · CAD',
    currency: 'CAD',
    invoices: [
      { date: '2026-04-15', amount: 25, status: 'paid' },
      { date: '2026-05-10', amount: 42.1, status: 'paid' }
    ],
    stats: [
      {
        key: 'usageLimit',
        label: 'Usage limit',
        role: 'money',
        currency: 'CAD',
        value: 10350,
        max: 20000,
        caption: '52% of cap'
      },
      { key: 'recurringSeats', label: 'Recurring seats', role: 'money', currency: 'CAD', value: 5347, unit: '/mo' },
      { key: 'invoiceCount', label: 'Invoices', role: 'count', value: 2 }
    ]
  })

  expect(validateCapabilityResult(resolveCurrencies(r, 'CAD'))).toEqual([])
  const stat = r.views?.find((v) => v.type === 'stat')
  const fields = stat?.type === 'stat' ? stat.fields : undefined

  expect(fields).toContainEqual({ key: 'currentMtd', caption: 'invoiced · CAD' })
  expect(fields).toContainEqual({ key: 'usageLimit', max: 20000, caption: '52% of cap' })
  expect(fields).toContainEqual({ key: 'recurringSeats', unit: '/mo' })
  // 42.1 vs prior month 25 → spending more → negative tone
  expect(fields).toContainEqual({ key: 'momDelta', tone: 'negative' })
  // a stat with no rich layers stays a bare key
  expect(fields).toContain('invoiceCount')
})

test('billingSummaryResult: spending less than the baseline tones the delta positive', () => {
  const r = billingSummaryResult({
    currentMtd: 20,
    currency: 'USD',
    invoices: [
      { date: '2026-04-15', amount: 25, status: 'paid' },
      { date: '2026-05-10', amount: 20, status: 'paid' }
    ]
  })
  const stat = r.views?.find((v) => v.type === 'stat')
  const fields = stat?.type === 'stat' ? stat.fields : undefined

  expect(fields).toContainEqual({ key: 'momDelta', tone: 'positive' }) // 20 − 25 = −5
})

test('billingResult also renders the delta cell', () => {
  const r = billingResult({
    currentMtd: 42.1,
    currency: 'USD',
    invoices: [
      { date: '2026-04-15', amount: 25, status: 'paid' },
      { date: '2026-05-10', amount: 42.1, status: 'paid' }
    ]
  })
  const account = r.datasets.find((d) => d.id === 'account')!

  expect(account.shape === 'record' && account.value.momDelta).toBe(17.1)
})

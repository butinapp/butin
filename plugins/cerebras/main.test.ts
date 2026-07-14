import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { describe, expect, it, test } from 'vitest'

import {
  buildCerebrasBilling,
  buildCerebrasBillingTab,
  buildCerebrasKeys,
  buildCerebrasMembers,
  buildCerebrasSummaryResult,
  buildCerebrasUsage,
  buildCerebrasUsageResult,
  cerebrasPlugin,
  parseFlightResult
} from './main.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of cerebrasPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

describe('buildCerebrasBilling', () => {
  const invoices = [
    {
      created: 1_748_736_000,
      status: 'paid',
      total: 50_001,
      currency: 'usd',
      number: 'A-1',
      hosted_invoice_url: 'https://pay/1'
    },
    { created: 1_746_057_600, status: 'open', total: 120_455, number: 'A-2' }
  ]
  const upcoming = [
    { amount: 1234, description: 'gpt-oss-120b-input' },
    { amount: 5678, description: 'gpt-oss-120b-output' },
    { amount: 1000, description: 'gpt-oss-120b-input' }
  ]

  it('normalizes Stripe cents to dollars and sorts invoices newest-first', () => {
    const r = buildCerebrasBilling(
      invoices,
      upcoming,
      { available: 250_000, ledger: 500_000 },
      { balance: -1000, currency: 'usd', email: 'billing@example.com' }
    )

    expect(r.invoices[0].number).toBe('A-1')
    expect(r.invoices[0].amount).toBe(500.01)
    expect(r.creditsAvailable).toBe(2500)
    expect(r.accountBalance).toBe(-10)
    expect(r.accountEmail).toBe('billing@example.com')
    expect(r.currency).toBe('USD')
  })

  it('falls back to amount_due when an invoice has no total and normalizes credit grants', () => {
    const r = buildCerebrasBilling(
      [{ created: 1_748_736_000, status: 'paid', amount_due: 7500, currency: 'usd' }],
      null,
      null,
      null,
      [{ name: 'Purchased credits', category: 'paid', amount: 50_000, available: 2_823, effective_at: 1_748_736_000 }]
    )

    expect(r.invoices[0].amount).toBe(75)
    expect(r.creditGrants[0]).toMatchObject({ name: 'Purchased credits', granted: 500, available: 28.23 })
    expect(r.creditGrants[0].effective).toBe('2025-06-01')
  })

  it('groups upcoming-invoice line items by description into the current breakdown', () => {
    const r = buildCerebrasBilling(invoices, upcoming, null, null)
    const input = r.currentBreakdown.find((l) => l.label === 'gpt-oss-120b-input')!

    expect(input.amount).toBe(22.34) // (1234 + 1000) cents
    expect(r.currentSpend).toBe(22.34 + 56.78)
  })

  it('handles empty input', () => {
    const r = buildCerebrasBilling(null, null, null, null)

    expect(r.invoices).toEqual([])
    expect(r.currentSpend).toBe(0)
    expect(r.currency).toBe('USD')
  })
})

describe('buildCerebrasSummaryResult', () => {
  it('emits a billing summary with the accrued period as MTD', () => {
    const billing = buildCerebrasBilling(
      [{ created: 1_748_736_000, total: 50_001, status: 'paid' }],
      [{ amount: 5000, description: 'x' }],
      null,
      null
    )
    const r = buildCerebrasSummaryResult(billing)

    expect(r.summaries?.[0]?.section).toBe('spend')
    expect(r.summaries?.[0]?.basis).toBe('accrued')
    expect(r.datasets.length).toBeGreaterThan(0)

    // The chart buckets by the INCURRED month — one back from the invoice's created date (billed in arrears),
    // so a 2025-06 invoice charts under 2025-05; the open month is left for the live accrual (backfilled in core).
    const monthly = r.datasets.find((d) => d.id === 'monthly')

    expect(monthly?.shape === 'table' && monthly.rows).toEqual([{ month: '2025-05', amount: 500.01 }])
  })
})

describe('buildCerebrasBillingTab', () => {
  it('builds account/credits records, line items, grants, and a downloadable invoice table', () => {
    const billing = buildCerebrasBilling(
      [
        {
          created: 1_748_736_000,
          total: 50_001,
          status: 'paid',
          number: 'A-1',
          hosted_invoice_url: 'https://pay/1',
          invoice_pdf: 'https://pay/1.pdf'
        }
      ],
      [{ amount: 4093, description: 'gpt-oss-120b-output' }],
      { available: 2_823, ledger: 88_864 },
      { balance: 0, currency: 'usd', email: 'ar@example.com', delinquent: false },
      [{ name: 'Purchased credits', category: 'paid', amount: 50_001, available: 2_823, effective_at: 1_748_736_000 }]
    )
    const r = buildCerebrasBillingTab(billing)

    expect(r.datasets.find((d) => d.id === 'account')).toBeDefined()
    expect(r.datasets.find((d) => d.id === 'invoices')).toBeDefined()
    expect(r.datasets.find((d) => d.id === 'grants')).toBeDefined()
    expect(r.datasets.find((d) => d.id === 'lineItems')).toBeDefined()
    // The invoice table carries a files descriptor (download source = the direct PDF) so "Save everything" grabs it.
    const invoiceView = r.views?.find((v) => v.type === 'table' && 'files' in v)

    expect(invoiceView && 'files' in invoiceView && invoiceView.files?.source).toMatchObject({ url: 'pdfUrl' })
    const invoicesDs = r.datasets.find((d) => d.id === 'invoices')
    const invoiceRow = invoicesDs && 'rows' in invoicesDs ? (invoicesDs.rows[0] as { pdfUrl?: string }) : undefined

    expect(invoiceRow?.pdfUrl).toBe('https://pay/1.pdf')
    expect(r.summaries ?? []).toEqual([]) // detail tab emits no rollup summary
  })

  it('falls back to the hosted-invoice URL for the PDF download when no direct invoice_pdf is present', () => {
    const billing = buildCerebrasBilling(
      [{ created: 1_748_736_000, total: 50_001, status: 'paid', number: 'A-1', hosted_invoice_url: 'https://pay/1' }],
      null,
      null,
      null
    )
    const ds = buildCerebrasBillingTab(billing).datasets.find((d) => d.id === 'invoices')
    const row = ds && 'rows' in ds ? (ds.rows[0] as { pdfUrl?: string }) : undefined

    expect(row?.pdfUrl).toBe('https://pay/1')
  })
})

describe('buildCerebrasMembers', () => {
  it('flattens the org-member roster to id/name/email/role', () => {
    const r = buildCerebrasMembers([
      { user: { id: 'u1', name: 'Ada', email: 'ada@example.com' }, role: 'ADMIN' },
      { user: { id: 'u2', email: 'grace@example.com' }, role: 'MEMBER' }
    ])

    expect(r.members[0]).toEqual({ id: 'u1', name: 'Ada', email: 'ada@example.com', role: 'ADMIN' })
    expect(r.members[1].name).toBeUndefined()
    expect(buildCerebrasMembers(null).members).toEqual([])
  })
})

describe('parseFlightResult', () => {
  it('resolves the action return value off the RSC flight stream', () => {
    const flight = '0:{"a":"$@1","f":"","b":"x"}\n1:"cus_ABC123"\n'

    expect(parseFlightResult<string>(flight)).toBe('cus_ABC123')
  })

  it('follows a non-default reference id and returns null on a malformed body', () => {
    expect(parseFlightResult('0:{"a":"$@2","f":""}\n2:{"ok":true}\n')).toEqual({ ok: true })
    expect(parseFlightResult('garbage')).toBeNull()
  })

  it('reads a value emitted directly (no re-render envelope) and ignores module/HTML bodies', () => {
    // No `{"a":"$@…"}` envelope — the action value sits on line 0 alongside client-module rows.
    expect(parseFlightResult('0:I["app"]\n1:"cus_DIRECT"')).toBe('cus_DIRECT')
    expect(parseFlightResult('0:"cus_DIRECT"')).toBe('cus_DIRECT')
    // An HTML page (action not executed) has no flight lines → null, so the caller degrades + logs.
    expect(parseFlightResult('<!DOCTYPE html><html><body>nope</body></html>')).toBeNull()
  })

  it('resolves cross-row references in a split payload (large invoice/credit responses)', () => {
    // A big result is split: the envelope row references the data array on another row.
    const flight = '0:{"a":"$@1","f":""}\n1:{"ok":true,"data":"$2"}\n2:[{"id":"in_1","total":50011}]\n'
    const result = parseFlightResult<{ ok: boolean; data: Array<{ id: string; total: number }> }>(flight)

    expect(result?.data).toEqual([{ id: 'in_1', total: 50011 }])
    // `$$` escapes a literal dollar string; `$undefined` is undefined.
    expect(parseFlightResult('0:{"a":"$@1"}\n1:{"note":"$$5.00","skip":"$undefined"}')).toEqual({ note: '$5.00' })
  })
})

describe('buildCerebrasKeys', () => {
  it('masks secrets and marks non-active keys revoked', () => {
    const r = buildCerebrasKeys([
      { id: 'k1', name: 'prod', secretKey: 'csk-8p9hk5abcdvvvx', state: 'ACTIVE', createdAt: '2026-01-02T00:00:00Z' },
      { id: 'k2', secretKey: 'csk-zzzz1234', state: 'DELETED' }
    ])

    expect(r.keys[0].masked).toBe('csk-…vvvx')
    expect(r.keys[0].revoked).toBe(false)
    expect(r.keys[1].name).toBe('(unnamed)')
    expect(r.keys[1].revoked).toBe(true)
  })

  it('handles empty input', () => {
    expect(buildCerebrasKeys(null).keys).toEqual([])
  })
})

describe('buildCerebrasUsage', () => {
  const models = [
    { id: 'm1', name: 'gpt-oss-120b', deprecated: false },
    { id: 'm2', name: 'old', deprecated: true }
  ]
  const quotas = [
    {
      modelId: 'm1',
      requestsPerMinute: '1000',
      tokensPerMinute: '60000',
      requestsPerDay: '50000',
      maxCompletionTokens: '8192'
    }
  ]
  const graph = [
    { timeWindow: '2026-06-10T00:00:00Z', httpStatus: '200', requestCount: 100 },
    { timeWindow: '2026-06-10T00:00:00Z', httpStatus: '4xx', requestCount: 5 },
    { timeWindow: '2026-06-11T00:00:00Z', httpStatus: '200', requestCount: 200 }
  ]

  it('sums request counts per day and joins model names onto quotas', () => {
    const r = buildCerebrasUsage(305, graph, quotas, models, '2026-05-12', '2026-06-11')

    expect(r.totalRequests).toBe(305)
    expect(r.daily).toEqual([
      { date: '2026-06-10', requests: 105 },
      { date: '2026-06-11', requests: 200 }
    ])
    expect(r.models[0].name).toBe('gpt-oss-120b')
    expect(r.models[0].rpm).toBe(1000)
    expect(r.modelCount).toBe(1) // deprecated model excluded
  })

  it('handles empty input', () => {
    const r = buildCerebrasUsage(null, null, null, null)

    expect(r.totalRequests).toBe(0)
    expect(r.daily).toEqual([])
    expect(r.models).toEqual([])
  })
})

describe('buildCerebrasUsageResult', () => {
  it('produces usage + daily + quota datasets', () => {
    const usage = buildCerebrasUsage(
      305,
      [{ timeWindow: '2026-06-10T00:00:00Z', requestCount: 105 }],
      [{ modelId: 'm1', requestsPerMinute: '1000' }],
      [{ id: 'm1', name: 'gpt-oss-120b' }]
    )
    const r = buildCerebrasUsageResult(usage)

    expect(r.datasets.find((d) => d.id === 'daily')).toBeDefined()
    expect(r.datasets.find((d) => d.id === 'quotas')).toBeDefined()
    expect(r.views?.some((v) => v.type === 'timeseries')).toBe(true)
  })
})

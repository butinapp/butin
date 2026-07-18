import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { describe, expect, it, test } from 'vitest'

import {
  buildLinearBilling,
  buildLinearBillingResult,
  buildLinearMembers,
  buildLinearSummaryResult,
  currentMonthSpend,
  type LinearInvoice,
  linearPlugin,
  resolveLinearAuth,
  stripeInvoicePdfUrl,
  useraccountFromCookie
} from './main.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of linearPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

// Synthetic billing fixture (amounts in cents): fake org name, email, invoice ids, tax id.
const details = {
  billingDetails: {
    success: true,
    name: 'Synthetic Org Inc',
    email: 'receipts+test@example.com',
    taxId: { type: 'ca_qst', value: '1234567890TQ0001' },
    paymentMethod: { type: 'card', country: 'US', brand: 'mastercard', last4: '4242' },
    invoices: [
      // billingDetails carries only the first page — older invoices exist in billingInvoices.
      {
        created: '2026-05-19T16:55:43.000Z',
        dueDate: null,
        status: 'paid',
        total: 174400,
        url: 'https://invoice.example/abc1',
        kind: 'subscription'
      }
    ],
    invoicesPageInfo: { hasNextPage: true, hasPreviousPage: false }
  }
}

const invoiceList = {
  billingInvoices: {
    success: true,
    invoices: [
      {
        created: '2026-03-19T16:55:36.000Z',
        dueDate: null,
        status: 'paid',
        total: 163200,
        url: 'https://invoice.example/abc3',
        kind: 'subscription'
      },
      {
        created: '2026-05-19T16:55:43.000Z',
        dueDate: null,
        status: 'paid',
        total: 174400,
        url: 'https://invoice.example/abc1',
        kind: 'subscription'
      },
      {
        created: '2026-04-19T16:56:23.000Z',
        dueDate: null,
        status: 'open',
        total: 169600,
        url: 'https://invoice.example/abc2',
        kind: 'subscription'
      }
    ]
  }
}

test('linear plugin is well-formed', () => {
  expect(linearPlugin.meta.id).toBe('linear')
  expect(linearPlugin.auth.kind).toBe('cookie-csrf')
  expect(linearPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'members'])
})

describe('stripeInvoicePdfUrl', () => {
  it('inserts /pdf before the query string of a Stripe hosted-invoice URL', () => {
    expect(stripeInvoicePdfUrl('https://invoice.stripe.com/i/acct_1A/live_XYZ?s=ap')).toBe(
      'https://invoice.stripe.com/i/acct_1A/live_XYZ/pdf?s=ap'
    )
    expect(stripeInvoicePdfUrl('https://invoice.stripe.com/i/acct_1A/live_XYZ')).toBe(
      'https://invoice.stripe.com/i/acct_1A/live_XYZ/pdf'
    )
  })

  it('leaves an already-/pdf, non-Stripe, or empty URL unchanged', () => {
    expect(stripeInvoicePdfUrl('https://invoice.stripe.com/i/acct_1A/live_XYZ/pdf?s=ap')).toBe(
      'https://invoice.stripe.com/i/acct_1A/live_XYZ/pdf?s=ap'
    )
    expect(stripeInvoicePdfUrl('https://example.com/invoice/123')).toBe('https://example.com/invoice/123')
    expect(stripeInvoicePdfUrl(null)).toBeNull()
    expect(stripeInvoicePdfUrl(undefined)).toBeNull()
  })
})

describe('useraccountFromCookie', () => {
  it('reads the account id from the session:<id> cookie name', () => {
    const cookie = 'lastUsedLogin=x; session:55b6eb05-00a4-4e70-a1c0-7cfa7396398f=jwt.tok.en; loggedIn=1'

    expect(useraccountFromCookie(cookie)).toBe('55b6eb05-00a4-4e70-a1c0-7cfa7396398f')
  })

  it('returns undefined when no session cookie is present', () => {
    expect(useraccountFromCookie('loggedIn=1')).toBeUndefined()
    expect(useraccountFromCookie(undefined)).toBeUndefined()
  })
})

describe('resolveLinearAuth', () => {
  const ctx = (creds: Record<string, string>, config: Record<string, unknown> = {}) => ({
    client: {} as never,
    creds: { get: (f?: string) => creds[f ?? 'cookie'], set: () => {} },
    config
  })

  it('re-attaches the cookie and derives the useraccount header from it', async () => {
    const cookie = 'session:55b6eb05-00a4-4e70-a1c0-7cfa7396398f=jwt; loggedIn=1'
    const att = await resolveLinearAuth(ctx({ cookie }))

    expect(att.cookie).toBe(cookie)
    expect(att.headers).toEqual({ useraccount: '55b6eb05-00a4-4e70-a1c0-7cfa7396398f' })
  })

  it('sends organization / user headers from captured creds, config overriding', async () => {
    const att = await resolveLinearAuth(
      ctx(
        { cookie: 'session:acc-1=jwt', useraccount: 'acc-1', organizationId: 'org-captured', userId: 'usr-1' },
        { organizationId: 'org-override' }
      )
    )

    expect(att.headers).toEqual({ useraccount: 'acc-1', organization: 'org-override', user: 'usr-1' })
  })

  it('omits headers it cannot resolve', async () => {
    const att = await resolveLinearAuth(ctx({ cookie: 'loggedIn=1' }))

    expect(att.headers).toEqual({})
  })
})

describe('buildLinearBilling', () => {
  it('normalizes cents → dollars, slices the ISO date, and sorts invoices newest-first', () => {
    const report = buildLinearBilling(details, invoiceList)

    expect(report.invoices).toEqual([
      {
        date: '2026-05-19',
        amount: 1744,
        status: 'paid',
        kind: 'subscription',
        hostedUrl: 'https://invoice.example/abc1'
      },
      {
        date: '2026-04-19',
        amount: 1696,
        status: 'open',
        kind: 'subscription',
        hostedUrl: 'https://invoice.example/abc2'
      },
      {
        date: '2026-03-19',
        amount: 1632,
        status: 'paid',
        kind: 'subscription',
        hostedUrl: 'https://invoice.example/abc3'
      }
    ])
    expect(report.latestAmount).toBe(1744)
  })

  it('extracts payment method, billing contact, and formatted tax id', () => {
    const report = buildLinearBilling(details, invoiceList)

    expect(report.paymentMethod).toEqual({ type: 'card', brand: 'mastercard', last4: '4242', country: 'US' })
    expect(report.billingContact).toEqual({ name: 'Synthetic Org Inc', email: 'receipts+test@example.com' })
    expect(report.taxId).toBe('ca_qst: 1234567890TQ0001')
  })

  it('falls back to the billingDetails invoice page when the dedicated list is empty', () => {
    const report = buildLinearBilling(details, { billingInvoices: { success: true, invoices: [] } })

    expect(report.invoices).toHaveLength(1)
    expect(report.invoices[0]).toMatchObject({ date: '2026-05-19', amount: 1744 })
  })

  it('tolerates empty / nullish input', () => {
    const report = buildLinearBilling({}, {})

    expect(report.invoices).toEqual([])
    expect(report.latestAmount).toBe(0)
    expect(report.paymentMethod).toBeNull()
    expect(report.billingContact).toBeNull()
    expect(report.taxId).toBeUndefined()

    const nullish = buildLinearBilling(null, undefined)

    expect(nullish.invoices).toEqual([])
  })
})

describe('currentMonthSpend', () => {
  const invoices: LinearInvoice[] = [
    { date: '2026-06-03', amount: 100, status: 'paid', kind: 'subscription' },
    { date: '2026-06-19', amount: 50.5, status: 'open', kind: 'subscription' },
    { date: '2026-05-19', amount: 999, status: 'paid', kind: 'subscription' }
  ]

  it('sums only invoices dated in the given calendar month', () => {
    expect(currentMonthSpend(invoices, new Date('2026-06-15T00:00:00.000Z'))).toBe(150.5)
    expect(currentMonthSpend(invoices, new Date('2026-05-15T00:00:00.000Z'))).toBe(999)
    expect(currentMonthSpend(invoices, new Date('2026-07-15T00:00:00.000Z'))).toBe(0)
  })

  it('returns 0 for no invoices', () => {
    expect(currentMonthSpend([], new Date('2026-06-15T00:00:00.000Z'))).toBe(0)
  })
})

describe('buildLinearSummaryResult', () => {
  it('emits the account stat record, monthly-spend chart, and a spend.mtd summary', () => {
    const report = buildLinearBilling(details, invoiceList)
    const result = buildLinearSummaryResult(report)

    // Dataset discriminant is `shape`, not `kind`.
    const account = result.datasets.find((d) => d.id === 'account')

    expect(account?.shape).toBe('record')
    const monthly = result.datasets.find((d) => d.id === 'monthly')

    expect(monthly?.shape).toBe('table')

    // The monthly series buckets the three invoices into three months (ascending).
    expect((monthly as { rows: unknown[] }).rows).toHaveLength(3)

    // billingSummaryResult emits spend.mtd whenever currentMtd is a number (date-dependent value, so we
    // assert the structure, not a hardcoded amount).
    expect(result.summaries?.[0]?.section).toBe('spend')
    expect(result.summaries?.[0]?.basis).toBe('invoiced')
    expect(typeof result.summaries?.[0]?.value).toBe('number')
  })
})

describe('buildLinearBillingResult', () => {
  it('builds a downloadable invoices table + a billing-account keyvalue record', () => {
    const report = buildLinearBilling(details, invoiceList)
    const result = buildLinearBillingResult(report)

    const invoices = result.datasets.find((d) => d.id === 'invoices')

    expect(invoices?.shape).toBe('table')
    expect((invoices as { rows: unknown[] }).rows).toHaveLength(3)
    // keyed by the invoice date (one invoice per billing month, no id in the payload) so status accumulates.
    expect((invoices as { key?: unknown }).key).toBe('date')

    const tableView = result.views?.find((v) => v.type === 'table')

    expect(tableView && 'files' in tableView ? tableView.files?.source : undefined).toEqual({ url: 'pdfUrl' })

    const account = result.datasets.find((d) => d.id === 'account')

    expect(account?.shape).toBe('record')
    expect((account as { value: Record<string, unknown> }).value).toMatchObject({
      contact: 'Synthetic Org Inc',
      email: 'receipts+test@example.com',
      taxId: 'ca_qst: 1234567890TQ0001'
    })
    expect(String((account as { value: Record<string, unknown> }).value.card)).toContain('4242')

    const keyvalue = result.views?.find((v) => v.type === 'keyvalue')

    expect(keyvalue?.dataset).toBe('account')
  })

  it('omits the account record when there is no contact / payment / tax info', () => {
    const report = buildLinearBilling({ billingDetails: { invoices: [] } }, { billingInvoices: { invoices: [] } })
    const result = buildLinearBillingResult(report)

    expect(result.datasets.find((d) => d.id === 'account')).toBeUndefined()
    expect(result.views?.find((v) => v.type === 'keyvalue')).toBeUndefined()
  })
})

describe('buildLinearMembers', () => {
  // SYNTHETIC users.nodes roster (fake ids, names, emails) shaped like the dashboard `users` query.
  const usersResponse = {
    users: {
      nodes: [
        { id: 'usr_1', name: 'Ada Synthetic', email: 'ada@example.com', admin: true, guest: false, active: true },
        { id: 'usr_2', name: 'Bo Synthetic', email: 'bo@example.com', admin: false, guest: false, active: true },
        { id: 'usr_3', name: 'Cy Synthetic', email: 'cy@example.com', admin: false, guest: true, active: true },
        { id: 'usr_4', name: 'Di Synthetic', email: 'di@example.com', admin: false, guest: false, active: false },
        // No id — skipped (id is the stable key).
        { id: '', name: 'Ghost', email: 'ghost@example.com', admin: false, guest: false, active: true }
      ]
    }
  }

  it('maps users.nodes → id/name/email with role from admin/guest/active flags', () => {
    const { members } = buildLinearMembers(usersResponse)

    expect(members).toEqual([
      { id: 'usr_1', name: 'Ada Synthetic', email: 'ada@example.com', role: 'admin' },
      { id: 'usr_2', name: 'Bo Synthetic', email: 'bo@example.com', role: 'member' },
      { id: 'usr_3', name: 'Cy Synthetic', email: 'cy@example.com', role: 'guest' },
      { id: 'usr_4', name: 'Di Synthetic', email: 'di@example.com', role: 'suspended' }
    ])
  })

  it('tolerates empty / nullish input', () => {
    expect(buildLinearMembers({ users: { nodes: [] } }).members).toEqual([])
    expect(buildLinearMembers({}).members).toEqual([])
    expect(buildLinearMembers(null).members).toEqual([])
    expect(buildLinearMembers(undefined).members).toEqual([])
  })
})

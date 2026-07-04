import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { members } from '@butinapp/sdk/presets'
import { currentMonthKey, round2 } from '@butinapp/sdk/util'
import { describe, expect, test } from 'vitest'

import {
  buildHubspotBilling,
  buildHubspotBillingResult,
  buildHubspotDaily,
  buildHubspotMembers,
  buildHubspotUsageMetrics,
  buildHubspotUsageResult,
  extractHubspotCsrf,
  hubspotPlugin,
  type RawCreditsResponse,
  type RawDelinquency,
  type RawHubspotPaymentMethodsResponse,
  type RawHubspotTransactionsResponse,
  type RawHubspotUsersResponse,
  type RawMarketableContactsResponse,
  type RawPaidProductsResponse,
  type RawSeatInfo,
  type RawUpcomingPaymentsResponse,
  resolveHubspotAuth
} from './main.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of hubspotPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

// SYNTHETIC fixtures — shapes mirror the dashboard API, values invented. HubSpot money is in DOLLARS
// already (1200.5 → $1200.50); usage values are plain counts. Date-derived fields (currentMtd) are asserted
// by structure, not against a hardcoded calendar month.

const invoices: RawHubspotTransactionsResponse = {
  transactions: [
    {
      type: 'INVOICE',
      issuedTimestamp: 1700000000000,
      issued: '2024-01-15T10:00:00.000',
      pdfUrl: 'https://example.test/invoice/aaa.pdf',
      status: 'PROCESSED',
      products: ['Demo Hub Starter'],
      invoiceAmount: 1200.5,
      balanceDue: 0,
      dueDate: '2024-01-15',
      currencyCode: 'USD',
      id: 'INVOICE:111'
    },
    {
      type: 'INVOICE',
      issuedTimestamp: 1702592000000,
      issued: '2024-02-15T10:00:00.000',
      pdfUrl: 'https://example.test/invoice/bbb.pdf',
      status: 'PROCESSED',
      products: ['Demo Hub Starter'],
      invoiceAmount: 1200.5,
      balanceDue: 0,
      dueDate: '2024-02-15',
      currencyCode: 'USD',
      id: 'INVOICE:222'
    }
  ]
}

const upcoming: RawUpcomingPaymentsResponse = {
  upcomingPayments: [
    {
      issueDate: [2024, 3, 15],
      billingPeriodStart: [2024, 3, 15],
      billingPeriodEnd: [2024, 4, 14],
      amount: 1200.5,
      currencyCode: 'USD',
      paymentMethodType: 'CREDIT_CARD',
      isProcessing: false
    }
  ]
}

const paymentMethods: RawHubspotPaymentMethodsResponse = {
  paymentMethods: [
    {
      paymentMethodType: 'CREDIT_CARD',
      lastFour: '4242',
      creditCardVariant: 'visa',
      cardHolderName: 'Demo Holder',
      creditCardExpirationMonth: 5,
      creditCardExpirationYear: 2030,
      expired: false
    }
  ]
}

const paidProducts: RawPaidProductsResponse[] = [
  {
    subscriptionId: 999,
    paidProducts: [
      {
        name: 'Demo Hub Starter',
        type: 'MARKETING',
        productTier: 'STARTER',
        quantity: 1,
        limits: [
          { name: 'contacts', limit: 10000, used: 4200 },
          { name: 'email_sends', limit: 50000, used: 1234 }
        ],
        quantityPacks: [{ name: 'Extra contacts pack', limits: [{ name: 'extra_contacts', limit: 5000, used: 1000 }] }]
      },
      {
        name: 'Demo Sales (3 seats)',
        type: 'SALES_SEAT',
        productTier: 'PROFESSIONAL',
        quantity: 3,
        limits: [{ name: 'sales-seats', limit: 3, used: 2 }]
      }
    ]
  }
]

const delinquency: RawDelinquency = { customerDelinquencyStatus: false, customerDelinquentInvoiceIds: [] }

const seatInfo: RawSeatInfo[] = [{ maxAssignableSeats: 5, currentAssignedSeats: 3, seatName: 'core' }]

const marketable: RawMarketableContactsResponse = {
  contactsTier: 10000,
  latestCountForBilling: { date: '2024-02-14', marketableContactsCount: 4200, marketableContactsLimit: 10000 },
  realTimeCount: { date: '2024-02-15', marketableContactsCount: 4250, marketableContactsLimit: 10000 },
  usageByResolution: {
    resolution: 'DAILY',
    usage: [
      { date: '2024-02-02', marketableContactsCount: 4000, marketableContactsLimit: 10000 },
      { date: '2024-02-01', marketableContactsCount: 3900, marketableContactsLimit: 10000 }
    ]
  }
}

const credits: RawCreditsResponse = {
  type: 'data',
  data: {
    startDate: '2024-02-01',
    endDate: '2024-02-29',
    creditsUsed: 120,
    totalCredits: 1000,
    grantedCredits: 0,
    overages: 0,
    percentageOfTotalCreditsUsed: 12
  }
}

// ── auth: cookie-csrf parse ──────────────────────────────────────────────────────────

describe('extractHubspotCsrf', () => {
  test('parses the hubspotapi-csrf cookie value from a multi-cookie string', () => {
    const cookie = 'foo=bar; hubspotapi-csrf=tok-abc123; hubspotapi=sess-xyz'

    expect(extractHubspotCsrf(cookie)).toBe('tok-abc123')
  })

  test('matches when it is the first cookie', () => {
    expect(extractHubspotCsrf('hubspotapi-csrf=lead; other=1')).toBe('lead')
  })

  test('returns undefined when absent / empty', () => {
    expect(extractHubspotCsrf('hubspotapi=sess-only')).toBeUndefined()
    expect(extractHubspotCsrf('')).toBeUndefined()
    expect(extractHubspotCsrf(undefined)).toBeUndefined()
  })
})

describe('resolveHubspotAuth', () => {
  const ctx = (cookie: string | undefined) =>
    ({ creds: { get: () => cookie, set: () => {} }, client: {} as never, config: {} }) as never

  test('returns the cookie verbatim + the CSRF header double-submitted', async () => {
    const out = await resolveHubspotAuth(ctx('hubspotapi-csrf=tok9; hubspotapi=sess'))

    expect(out.cookie).toBe('hubspotapi-csrf=tok9; hubspotapi=sess')
    expect(out.headers).toEqual({ 'x-hubspot-csrf-hubspotapi': 'tok9' })
  })

  test('omits the header when no csrf cookie is present', async () => {
    const out = await resolveHubspotAuth(ctx('hubspotapi=sess'))

    expect(out.cookie).toBe('hubspotapi=sess')
    expect(out.headers).toEqual({})
  })
})

// ── billing ───────────────────────────────────────────────────────────────────────────

describe('buildHubspotBilling', () => {
  test('normalizes invoices (dollars), newest-first, sums total', () => {
    const b = buildHubspotBilling(invoices, upcoming, paymentMethods, paidProducts, delinquency)

    expect(b.invoices.map((i) => i.date)).toEqual(['2024-02-15', '2024-01-15'])
    expect(b.invoices[0]).toMatchObject({
      date: '2024-02-15',
      amount: 1200.5,
      status: 'processed',
      pdfUrl: 'https://example.test/invoice/bbb.pdf'
    })
    expect(b.totalBilled).toBe(2401)
    expect(b.currency).toBe('USD')
  })

  test('currentMtd is a number summing only this-month invoices', () => {
    const b = buildHubspotBilling(invoices, upcoming, paymentMethods, paidProducts, delinquency)

    expect(typeof b.currentMtd).toBe('number')
    // The fixture invoices are dated in 2024, so unless the test runs in that month, MTD is 0.
    const ym = currentMonthKey()
    const expected = b.invoices.filter((i) => i.date?.startsWith(ym)).reduce((s, i) => s + i.amount, 0)

    expect(b.currentMtd).toBe(round2(expected))
  })

  test('parses the [y,m,d] upcoming payment, payment method, and products', () => {
    const b = buildHubspotBilling(invoices, upcoming, paymentMethods, paidProducts, delinquency)

    expect(b.upcomingPayment).toEqual({
      amount: 1200.5,
      date: '2024-03-15',
      periodStart: '2024-03-15',
      periodEnd: '2024-04-14'
    })
    expect(b.paymentMethod).toEqual({ brand: 'visa', last4: '4242', expMonth: 5, expYear: 2030 })
    expect(b.products).toEqual([
      { name: 'Demo Hub Starter', tier: 'STARTER', quantity: 1 },
      { name: 'Demo Sales (3 seats)', tier: 'PROFESSIONAL', quantity: 3 }
    ])
    expect(b.delinquent).toBe(false)
  })

  test('degrades safely on empty / missing inputs', () => {
    const b = buildHubspotBilling(null, null, null, null, null)

    expect(b.invoices).toEqual([])
    expect(b.currentMtd).toBe(0)
    expect(b.totalBilled).toBe(0)
    expect(b.currency).toBe('USD')
    expect(b.products).toEqual([])
    expect(b.upcomingPayment).toBeNull()
    expect(b.paymentMethod).toBeNull()
    expect(b.delinquent).toBe(false)
  })
})

describe('buildHubspotBillingResult', () => {
  test('is a valid billing CapabilityResult with extra stats', () => {
    const r = buildHubspotBillingResult(invoices, upcoming, paymentMethods, paidProducts, delinquency)

    expect(validateCapabilityResult(r)).toEqual([])
    const account = r.datasets.find((d) => d.id === 'account')

    expect(account?.shape).toBe('record')

    if (account?.shape === 'record') {
      expect(account.value.totalBilled).toBe(2401)
      expect(account.value.products).toBe(2)
      expect(account.value.nextCharge).toBe(1200.5)
      expect(account.value.delinquent).toBe('current') // delinquent/current auto-tone in the renderer lexicon
      const col = account.fields.find((f) => f.key === 'delinquent')

      expect(col).toMatchObject({ role: 'status' })
      expect(col?.badges).toBeUndefined()
    }

    // monthly-spend chart present (the Overview spark target).
    expect(r.datasets.some((d) => d.id === 'monthly')).toBe(true)
  })

  test('emits spend.mtd only when currentMtd is a number (always, here)', () => {
    const r = buildHubspotBillingResult(invoices, upcoming, paymentMethods, paidProducts, delinquency)

    expect(r.summaries?.[0]?.section).toBe('spend')
    expect(typeof r.summaries?.[0]?.value).toBe('number')
    expect(r.summaries?.[0]?.basis).toBe('invoiced')
  })

  test('empty inputs still validate (currentMtd 0 → spend.mtd present)', () => {
    const r = buildHubspotBillingResult(null, null, null, null, null)

    expect(validateCapabilityResult(r)).toEqual([])
  })
})

// ── usage ───────────────────────────────────────────────────────────────────────────

describe('buildHubspotUsageMetrics', () => {
  test('flattens product limits (incl. quantity packs) + seats + contacts + credits', () => {
    const m = buildHubspotUsageMetrics(paidProducts, seatInfo, marketable, credits)

    expect(m).toContainEqual({ label: 'Demo Hub Starter · contacts', value: 4200, limit: 10000 })
    expect(m).toContainEqual({ label: 'Demo Hub Starter · email_sends', value: 1234, limit: 50000 })
    // nested quantity-pack limit is flattened in
    expect(m).toContainEqual({ label: 'Extra contacts pack · extra_contacts', value: 1000, limit: 5000 })
    expect(m).toContainEqual({ label: 'Demo Sales (3 seats) · sales-seats', value: 2, limit: 3 })
    expect(m).toContainEqual({ label: 'Seats · core', value: 3, limit: 5, unit: 'seats' })
    expect(m).toContainEqual({ label: 'Marketable contacts', value: 4200, limit: 10000, unit: 'contacts' })
    expect(m).toContainEqual({ label: 'HubSpot credits', value: 120, limit: 1000, unit: 'credits' })
  })

  test('prefers latestCountForBilling over realTimeCount for marketable contacts', () => {
    const m = buildHubspotUsageMetrics(null, null, marketable, null)

    expect(m.find((x) => x.label === 'Marketable contacts')?.value).toBe(4200)
  })

  test('empty inputs → no metrics', () => {
    expect(buildHubspotUsageMetrics(null, null, null, null)).toEqual([])
  })
})

describe('buildHubspotDaily', () => {
  test('returns oldest-first marketable-contacts points', () => {
    expect(buildHubspotDaily(marketable)).toEqual([
      { date: '2024-02-01', count: 3900 },
      { date: '2024-02-02', count: 4000 }
    ])
  })

  test('empty / missing → []', () => {
    expect(buildHubspotDaily(null)).toEqual([])
    expect(buildHubspotDaily({})).toEqual([])
  })
})

describe('buildHubspotUsageResult', () => {
  test('is a valid usage CapabilityResult with a daily timeseries', () => {
    const r = buildHubspotUsageResult(paidProducts, seatInfo, marketable, credits)

    expect(validateCapabilityResult(r)).toEqual([])
    expect(r.datasets.some((d) => d.id === 'daily')).toBe(true)
    expect(r.views?.some((v) => v.type === 'timeseries' && v.dataset === 'daily')).toBe(true)
  })

  test('omits the timeseries when there is no daily data, still valid', () => {
    const r = buildHubspotUsageResult(paidProducts, seatInfo, null, credits)

    expect(validateCapabilityResult(r)).toEqual([])
    expect(r.datasets.some((d) => d.id === 'daily')).toBe(false)
  })

  test('empty inputs still validate', () => {
    expect(validateCapabilityResult(buildHubspotUsageResult(null, null, null, null))).toEqual([])
  })
})

// ── members ───────────────────────────────────────────────────────────────────────────

const users: RawHubspotUsersResponse = {
  results: [
    {
      id: 101,
      email: 'demo.admin@example.test',
      firstName: 'Demo',
      lastName: 'Admin',
      superAdmin: true,
      roleIds: [1]
    },
    {
      id: 102,
      email: 'demo.sales@example.test',
      firstName: 'Demo',
      lastName: 'Sales',
      primaryRoleName: 'Sales',
      roleIds: [7]
    },
    {
      id: 103,
      email: 'demo.norole@example.test',
      roleIds: [42]
    }
  ]
}

describe('buildHubspotMembers', () => {
  test('maps app-users → id/name/email/role (super-admin, named role, roleId fallback)', () => {
    const out = buildHubspotMembers(users)

    expect(out.members).toEqual([
      { id: '101', name: 'Demo Admin', email: 'demo.admin@example.test', role: 'super_admin' },
      { id: '102', name: 'Demo Sales', email: 'demo.sales@example.test', role: 'Sales' },
      { id: '103', name: undefined, email: 'demo.norole@example.test', role: '42' }
    ])
  })

  test('accepts a bare array payload as well as { results }', () => {
    expect(buildHubspotMembers(users.results)).toEqual(buildHubspotMembers(users))
  })

  test('falls back to the index when a user has no id, and drops an empty name', () => {
    const out = buildHubspotMembers({ results: [{ email: 'no.id@example.test' }] })

    expect(out.members).toEqual([{ id: '0', name: undefined, email: 'no.id@example.test', role: undefined }])
  })

  test('empty / missing input → no members', () => {
    expect(buildHubspotMembers(null).members).toEqual([])
    expect(buildHubspotMembers({}).members).toEqual([])
    expect(buildHubspotMembers([]).members).toEqual([])
  })

  test('the members result validates', () => {
    expect(validateCapabilityResult(members.result(buildHubspotMembers(users)))).toEqual([])
  })
})

// ── descriptor ──────────────────────────────────────────────────────────────────────

describe('hubspotPlugin', () => {
  test('is well-formed: cookie-csrf auth, node transport, billing + usage + members', () => {
    expect(hubspotPlugin.meta.id).toBe('hubspot')
    expect(hubspotPlugin.auth.kind).toBe('cookie-csrf')
    expect('resolve' in hubspotPlugin.auth && typeof hubspotPlugin.auth.resolve === 'function').toBe(true)
    expect(hubspotPlugin.transport?.engine).toBe('node')
    expect(hubspotPlugin.transport?.requiresBrowserEngine).toBeUndefined()
    expect(hubspotPlugin.capabilities.map((c) => c.id)).toEqual(['billing', 'usage', 'members'])
    expect(hubspotPlugin.session?.cookieDomains).toEqual(['hubspot.com'])
  })

  test('portal id is auto-captured from the dashboard URL, so the config field is an optional override', () => {
    const cap = hubspotPlugin.session?.captureFromUrl?.find((c) => c.storeAs === 'portalId')

    expect(cap).toBeDefined()

    const re = new RegExp(cap!.pattern)

    expect(re.exec('https://app.hubspot.com/account-and-billing/20692578')?.[1]).toBe('20692578')
    expect(re.exec('https://app.hubspot.com/reports-dashboard/20692578/view/19404448')?.[1]).toBe('20692578')

    const field = hubspotPlugin.config?.fields.find((f) => f.key === 'portalId')

    expect(field).toMatchObject({ kind: 'text' })
    expect(field?.required).toBeFalsy()
  })
})

import { validateCapabilityResult, type Dataset } from '@butinapp/sdk/data'
import { createSampleGen, resolveSampleConfig, validateSamples } from '@butinapp/sdk/testing'
import { expect, test } from 'vitest'

import {
  buildAccountsResult,
  type BillingBundle,
  buildBillingDetail,
  buildBillingSummary,
  buildMobileResult,
  type LegacyInvoiceLink,
  parseLegacyInvoiceLinks,
  videotronPlugin
} from './main.js'
import { sampleVidetronAccounts, sampleVidetronBilling } from './sample.js'

const byId = (datasets: Dataset[], id: string): Dataset => {
  const ds = datasets.find((d) => d.id === id)

  if (!ds) {
    throw new Error(`dataset ${id} not found`)
  }

  return ds
}

// Synthetic — no real account numbers, emails, or balances from any capture.
const billingFixture: BillingBundle = {
  financial: {
    currentBalance: 64.5,
    lastInvoiceAmount: 64.5,
    monthlyPayment: 0,
    paymentDueDate: 1781496000000, // 2026-06-15
    recentCreditRating: 'Good'
  },
  invoices: [
    // newest-first off the wire; build*() sorts ascending. Current one is still open, prior one paid.
    { invoiceNumber: '2', invoiceDate: 1770350400000, totalPayableAmount: 64.5, openAmount: 64.5, docIdFr: 'DOC-2' }, // 2026-02-06
    { invoiceNumber: '1', invoiceDate: 1767672000000, totalPayableAmount: 64.5, openAmount: 0, docIdFr: 'DOC-1' } // 2026-01-06
  ]
}

test('every defined sample is contract-valid', () => {
  expect(validateSamples(videotronPlugin)).toEqual([])
})

test('videotron sample is synthetic and scales statement count with documents', () => {
  const small = sampleVidetronBilling(createSampleGen('videotron:t'), resolveSampleConfig({ documents: 4 }))
  const large = sampleVidetronBilling(createSampleGen('videotron:t'), resolveSampleConfig({ documents: 12 }))

  expect(small.bundle.invoices.length).toBe(4)
  expect(large.bundle.invoices.length).toBe(12)
  expect(sampleVidetronAccounts(createSampleGen('videotron:t'))[0]!.serviceAddress!.addrDesc).toContain('rue')
})

test('videotron plugin is well-formed, with a monespace backend for mobile', () => {
  expect(videotronPlugin.meta.id).toBe('videotron')
  expect(videotronPlugin.auth.kind).toBe('spa-bearer')
  expect(videotronPlugin.transport?.engine).toBe('node')
  expect(videotronPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'mobile', 'accounts'])
  // the legacy mobile platform is a separate backend with its own spa-bearer + base URL
  expect(videotronPlugin.backends?.monespace?.auth.kind).toBe('spa-bearer')
  expect(videotronPlugin.backends?.monespace?.transport?.baseUrl).toContain('monespace.videotron.com')
})

test('marvel login settles on the portal host, gated on the Keycloak SSO cookie', () => {
  expect(videotronPlugin.session?.dashboardMarkers).toEqual(['moncompte.videotron.com/'])
  expect(videotronPlugin.session?.requiredCookie).toBe('KEYCLOAK_IDENTITY')
})

test('buildMobileResult merges the bill, dashboard, and user into a record + lastInvoice summary', () => {
  const result = buildMobileResult({
    last: { invoiceDate: '2026-05-29', amount: 63.87, balance: 63.87, dueDate: '2026-06-18' },
    dashboard: {
      payment: { data: { automaticWithdrawal: true } },
      account: { data: { startDate: '2026-05-18', endDate: '2026-06-17' } }
    },
    user: { accountNumber: '464132350016' }
  })

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries?.[0]).toMatchObject({
    section: 'other',
    role: 'money',
    currency: 'CAD',
    value: 63.87
  })

  const mobile = byId(result.datasets, 'mobile') as Extract<Dataset, { shape: 'record' }>

  expect(mobile.value).toMatchObject({
    amount: 63.87,
    balance: 63.87,
    dueDate: '2026-06-18',
    autoWithdrawal: 'Yes',
    billingPeriod: '2026-05-18 → 2026-06-17',
    accountNumber: '464132350016'
  })
})

test('buildMobileResult falls back to dashboard balance + omits the summary when the bill is missing', () => {
  const withDash = buildMobileResult({
    last: {},
    dashboard: { billing: { data: { balance: 40, dueDate: '2026-07-01' } } }
  })

  expect(validateCapabilityResult(withDash)).toEqual([])
  expect(withDash.summaries?.[0]).toMatchObject({ section: 'other', value: 40 })

  const empty = buildMobileResult({ last: {} })

  expect(validateCapabilityResult(empty)).toEqual([])
  expect(empty.summaries).toBeUndefined()
})

test('buildBillingSummary emits the headline (stat + monthly chart + spend.mtd), and NO tables', () => {
  const result = buildBillingSummary(billingFixture)

  expect(validateCapabilityResult(result)).toEqual([])

  // headline metric feeds the cross-service Overview as CAD month-to-date spend
  expect(result.summaries?.[0]).toMatchObject({
    section: 'spend',
    role: 'money',
    currency: 'CAD',
    value: 64.5,
    basis: 'invoiced'
  })

  const account = byId(result.datasets, 'account')

  expect(account.shape).toBe('record')
  expect((account as Extract<Dataset, { shape: 'record' }>).value.currentMtd).toBe(64.5)

  // Summary owns the chart, not the detail tables — those live on Billing.
  expect(result.datasets.find((d) => d.id === 'invoices')).toBeUndefined()
  expect(result.datasets.find((d) => d.id === 'balance')).toBeUndefined()
  expect(result.views?.some((v) => v.type === 'timeseries')).toBe(true)
})

test('buildBillingSummary sums the legacy mobile bill into the monthly history + headline', () => {
  const mobile: LegacyInvoiceLink[] = [
    { date: '2026-02-20', amount: 10, dateFacturation: '', medium: 'FA', resourceVersion: 'R1' }
  ]
  const result = buildBillingSummary(billingFixture, mobile)
  const monthly = byId(result.datasets, 'monthly')
  const rows = (monthly as Extract<Dataset, { shape: 'table' }>).rows

  // 2026-02 now sums the marvel invoice (64.5) + the mobile bill (10); 2026-01 (marvel only) stays 64.5.
  expect(rows).toEqual([
    { month: '2026-01', amount: 64.5 },
    { month: '2026-02', amount: 74.5 }
  ])
  // The headline = the latest month's combined total.
  expect(result.summaries?.[0]).toMatchObject({ section: 'spend', value: 74.5 })
})

const mobileFixture: LegacyInvoiceLink[] = [
  { dateFacturation: '1780027200000', date: '2026-05-29', medium: 'FA', resourceVersion: 'R20240510', amount: 63.87 }
]

test('buildBillingDetail merges marvel + mobile invoices into one table grouped by type, with the balance', () => {
  const result = buildBillingDetail(billingFixture, '800000000000', mobileFixture)

  expect(validateCapabilityResult(result)).toEqual([])
  // Detail tab carries no chart/summary — Summary owns those.
  expect(result.summaries).toBeUndefined()

  const invoices = byId(result.datasets, 'invoices') as Extract<Dataset, { shape: 'table' }>

  // `name` is unique per row across both surfaces — the accumulation key.
  expect(invoices.key).toBe('name')
  // marvel rows newest-first (Invoice), then the legacy mobile rows (Mobile invoice)
  expect(invoices.rows.map((r) => r.type)).toEqual(['Invoice', 'Invoice', 'Mobile invoice'])
  expect(invoices.rows.map((r) => r.date)).toEqual(['2026-02-06', '2026-01-06', '2026-05-29'])
  // marvel rows carry amount/status + the docId its PDF POST needs
  expect(invoices.rows[0]).toMatchObject({
    amount: 64.5,
    status: 'Open',
    docId: 'DOC-2',
    billingAccountId: '800000000000'
  })
  // the legacy mobile row carries its scraped amount (no paid/open status) + the PDF params
  expect(invoices.rows[2]).toMatchObject({
    amount: 63.87,
    status: null,
    name: 'Mobile invoice 2026-05-29',
    dateFacturation: '1780027200000',
    resourceVersion: 'R20240510'
  })

  // one downloadable table, grouped by type, bytes via the capability's fetchFile
  const view = result.views?.find((v) => v.type === 'table' && v.dataset === 'invoices')

  expect(view?.type === 'table' && view.groupBy).toBe('type')
  expect(view?.type === 'table' && view.files).toMatchObject({ ext: 'pdf', name: 'name', source: { fetch: true } })

  const balance = byId(result.datasets, 'balance') as Extract<Dataset, { shape: 'record' }>

  expect(balance.value).toMatchObject({ currentBalance: 64.5, dueDate: '2026-06-15', creditRating: 'Good' })
})

test('parseLegacyInvoiceLinks pulls each DisplayFacturePdf link, de-duped, newest first', () => {
  // Synthetic DisplayFacture list markup: the current invoice link appears twice; two prior eras differ in
  // resourceVersion (older bills use an older template).
  const html = `
    <a href="/x?dispatch=displayFacturePdf&dateFacturation=1780027200000&date=2026-05-29&medium=FA&resourceVersion=R20240510">Show</a>
    <a href="/x?dispatch=displayFacturePdf&dateFacturation=1780027200000&date=2026-05-29&medium=FA&resourceVersion=R20240510">Show again</a>
    <a href="/x?dispatch=displayFacturePdf&dateFacturation=1700802000000&date=2023-11-24&medium=FA&resourceVersion=R20180516">Old</a>
  `
  const links = parseLegacyInvoiceLinks(html)

  expect(links.map((l) => l.date)).toEqual(['2026-05-29', '2023-11-24'])
  // No data-total in this markup → amount stays null.
  expect(links[1]).toMatchObject({
    dateFacturation: '1700802000000',
    medium: 'FA',
    resourceVersion: 'R20180516',
    amount: null
  })
})

test('parseLegacyInvoiceLinks reads each history row amount off its <tr data-total>', () => {
  // The real billing-history table markup: each row's amount lives on the <tr data-total="$X"> just before its
  // displayFacturePdf link.
  const html = `
    <tr class="invoice-history-item item-0" data-date="May 29, 2026" data-total="$63.87">
      <td data-name="bill"><span data-name="total">$63.87</span>
        <a href="/x?dispatch=displayFacturePdf&dateFacturation=1780027200000&date=2026-05-29&medium=FA&resourceVersion=R20240510">Invoice</a>
      </td>
    </tr>
    <tr class="invoice-history-item item-1" data-date="April 24, 2026" data-total="$61.42">
      <td data-name="bill"><span data-name="total">$61.42</span>
        <a href="/x?dispatch=displayFacturePdf&dateFacturation=1777003200000&date=2026-04-24&medium=FA&resourceVersion=R20240510">Invoice</a>
      </td>
    </tr>
  `
  const links = parseLegacyInvoiceLinks(html)

  expect(links.map((l) => l.date)).toEqual(['2026-05-29', '2026-04-24'])
  expect(links.map((l) => l.amount)).toEqual([63.87, 61.42])
})

test('parseLegacyInvoiceLinks handles the serialized-DOM form (page.html() encodes href & as &amp;)', () => {
  const html =
    '<a href="/client/user-management/residentiel/secur/DisplayFactureForm.do?dispatch=displayFacturePdf&amp;dateFacturation=1774584000000&amp;date=2026-03-27&amp;medium=FA&amp;resourceVersion=R20240510">PDF</a>'

  expect(parseLegacyInvoiceLinks(html)).toEqual([
    { dateFacturation: '1774584000000', date: '2026-03-27', medium: 'FA', resourceVersion: 'R20240510', amount: null }
  ])
})

test('the legacy mobile-invoices surface has no backend — it runs through ctx.browser, not headless replay', () => {
  // The Struts /secur/ session can't be replayed by a one-shot request, so there is no monespace-legacy
  // backend; the only secondary backend is the modern /rest monespace one.
  expect(videotronPlugin.backends?.['monespace-legacy']).toBeUndefined()
  expect(Object.keys(videotronPlugin.backends ?? {})).toEqual(['monespace'])
  // The legacy invoices fold into the Billing tab (no separate tab); Billing carries the fetchFile that
  // downloads either invoice type.
  expect(videotronPlugin.capabilities.find((c) => c.id === 'billing')?.fetchFile).toBeDefined()
})

test('buildAccountsResult humanizes service families and labels the bare invoice account', () => {
  const result = buildAccountsResult([
    {
      customerBillingAccount: { acctNo: '800000000001', statusName: 'Active', invoiceAccountId: 800000000000 },
      serviceAddress: { addrDesc: '100 RUE EXEMPLE, VILLE QC A0A 0A0' },
      familyCategoryShortCode: 'INTERNET'
    },
    {
      // parent invoice account — no family
      customerBillingAccount: { acctNo: '800000000000', statusName: 'Active', invoiceAccountId: 800000000000 }
    }
  ])

  expect(validateCapabilityResult(result)).toEqual([])

  const accounts = byId(result.datasets, 'accounts') as Extract<Dataset, { shape: 'table' }>

  expect(accounts.rows.map((r) => r.service)).toEqual(['Internet', 'Billing account'])
  expect(accounts.rows[0]).toMatchObject({ account: '800000000001', status: 'Active' })
  // Each billing account has a distinct account number — the accumulation key.
  expect(accounts.key).toBe('account')
})

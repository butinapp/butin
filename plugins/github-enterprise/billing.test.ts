import { resolveCurrencies, validateCapabilityResult as rawValidateCR, type CapabilityResult } from '@butinapp/sdk/data'
import { describe, expect, it } from 'vitest'

import {
  type BuildBillingArgs,
  buildGithubBilling,
  buildGithubSummary,
  extractCardExpiry,
  extractGheLicensing,
  fetchAllPayments,
  parseContacts,
  parseDollarAmount,
  parsePaymentHistory,
  parseTotalPages,
  sumIncludedUsage
} from './billing.js'
import type { Dashboard } from './dashboard.js'
import { githubEnterprisePlugin } from './main.js'

const validateCapabilityResult = (r: CapabilityResult): string[] => rawValidateCR(resolveCurrencies(r, 'USD'))

// Minimal payment-history HTML: two payment rows — a successful charge with receipt + invoice, and a
// declined one with neither. Synthetic ids + vendor.
const html = `
<payment-history>
  <ul>
    <li class="Box-row">
      <div class="col-2 float-left date"><time title="2026-05-17 13:39:11" class="no-wrap">2026-05-17</time></div>
      <div class="col-2 float-left id"><code><span id="short-transaction-id-AAA111">AAA111</span></code></div>
      <div class="col-3 float-left method"><svg></svg> MasterCard ending in 5587 </div>
      <div class="col-2 float-left amount"> $3,199.32 </div>
      <div class="col-1 float-left status"><span class="Label Label--success">Success</span></div>
      <div class="col-1 float-left text-center receipt"><a id="download-receipt-ch_AAA" href="/businesses/acme-co/billing/receipt/ch_AAA" class="Link"><svg></svg></a></div>
      <div class="col-1 float-left text-center">
        <invoice-download data-url="/businesses/acme-co/billing/invoices/download?transaction_id=359336601" data-transaction="AAA111"></invoice-download>
      </div>
    </li>
    <li class="Box-row">
      <div class="col-2 float-left date"><time title="2026-03-17 09:01:00" class="no-wrap">2026-03-17</time></div>
      <div class="col-2 float-left id"><code><span id="short-transaction-id-BBB222">BBB222</span></code></div>
      <div class="col-3 float-left method"><svg></svg> MasterCard ending in 5587 </div>
      <div class="col-2 float-left amount"> $2,558.24 </div>
      <div class="col-1 float-left status"><span class="Label Label--error">Declined</span></div>
      <div class="col-1 float-left text-center receipt">-</div>
      <div class="col-1 float-left text-center">
        <invoice-download data-url="/businesses/acme-co/billing/invoices/download?transaction_id=359000000" data-transaction="BBB222"></invoice-download>
      </div>
    </li>
  </ul>
  <nav class="paginate-container">
    <div class="pagination">
      <em class="current" data-total-pages="7">1</em>
      <a rel="next" href="/enterprises/acme-co/billing/payment_history?page=2">2</a>
    </div>
  </nav>
</payment-history>`

// The licensing page embeds props.ghe in a react-partial JSON script tag.
const licensingHtml = `<div data-react-partial-name="licensing-enterprise-overview">
<script type="application/json" data-target="react-partial.embeddedData">{"props":{"ghe":{"billingTermEndDate":"2026-06-17","currentPayment":"$1,365.00","enterpriseLicensesBillable":67,"enterpriseLicensesConsumed":62,"enterpriseLicensesPurchased":67,"isMonthly":true,"unitCost":"$21.00/user per month","paymentMethod":{"credit_card":true,"paypal":false,"last_four":"5587","card_type":"MasterCard"},"pendingCycleChange":{"changeType":"downgrade","effectiveDate":"2026-06-17","newPrice":"$1,365","newSeatCount":65,"planDisplayName":"Enterprise","planDuration":"month"}}}}</script>
</div>`

const contactsHtml = `
<div class="Box-row flex-items-center d-flex color-fg-muted">
  <div class="my-1"><svg class="octicon octicon-person"></svg></div>
  <div class="tmp-ml-4"> billing@acme-co.example </div>
  <div class="ml-1"><span title="Label: Primary" class="Label Label--secondary">Primary</span></div>
</div>
<div class="Box-row flex-items-center d-flex color-fg-muted">
  <div class="d-flex my-1"><svg class="octicon octicon-person"></svg></div>
  <div class="tmp-ml-4 d-flex flex-1"> receipts@acme-co.example </div>
</div>
<div class="Box-row"><div>not a contact, no person icon</div></div>`

/** Build args helper — everything empty except what a test overrides. */
const args = (overrides: Partial<BuildBillingArgs> = {}): BuildBillingArgs => ({
  payments: [],
  totalPages: 1,
  pagesFetched: 1,
  usageTotal: {},
  discounts: { discounts: [] },
  ghe: null,
  cardExpiry: undefined,
  contacts: [],
  ...overrides
})

const recordById = (result: CapabilityResult, id: string) => {
  const ds = result.datasets.find((d) => d.id === id)

  if (!ds || ds.shape !== 'record') {
    throw new Error(`${id} should be a record`)
  }

  return ds.value
}

const tableById = (result: CapabilityResult, id: string) => {
  const ds = result.datasets.find((d) => d.id === id)

  if (!ds || ds.shape !== 'table') {
    throw new Error(`${id} should be a table`)
  }

  return ds.rows
}

// --- parsers ---

describe('parseDollarAmount', () => {
  it('parses plain, comma-grouped, and negative dollar strings', () => {
    expect(parseDollarAmount('$3,199.32')).toBeCloseTo(3199.32, 2)
    expect(parseDollarAmount('$1,365.00')).toBeCloseTo(1365, 2)
    expect(parseDollarAmount(undefined)).toBe(0)
    expect(parseDollarAmount('-')).toBe(0)
  })
})

describe('parseTotalPages', () => {
  it('reads data-total-pages, defaulting to 1', () => {
    expect(parseTotalPages(html)).toBe(7)
    expect(parseTotalPages('<div>no pagination</div>')).toBe(1)
  })
})

describe('parsePaymentHistory', () => {
  it('scrapes date, id, method, amount, status, and absolute receipt/invoice URLs', () => {
    const rows = parsePaymentHistory(html)

    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      date: '2026-05-17',
      timestamp: '2026-05-17 13:39:11',
      id: 'AAA111',
      method: 'MasterCard ending in 5587',
      amount: 3199.32,
      amountFormatted: '$3,199.32',
      status: 'Success',
      receiptUrl: 'https://github.com/businesses/acme-co/billing/receipt/ch_AAA',
      invoiceUrl: 'https://github.com/businesses/acme-co/billing/invoices/download?transaction_id=359336601'
    })
    expect(rows[1]).toMatchObject({ id: 'BBB222', status: 'Declined', receiptUrl: undefined })
  })

  it('ignores non-transaction markup', () => {
    expect(parsePaymentHistory('<ul><li class="Box-row"><div>header</div></li></ul>')).toEqual([])
  })
})

// A single payment-history row, newest-first like a real page. `timestamp` drives the since-watermark check.
const paymentRow = (id: string, timestamp: string): string => `
  <li class="Box-row">
    <div class="col-2 float-left date"><time title="${timestamp}" class="no-wrap">${timestamp.slice(0, 10)}</time></div>
    <div class="col-2 float-left id"><code><span id="short-transaction-id-${id}">${id}</span></code></div>
    <div class="col-3 float-left method">MasterCard ending in 5587</div>
    <div class="col-2 float-left amount"> $10.00 </div>
    <div class="col-1 float-left status"><span class="Label Label--success">Success</span></div>
  </li>`

// Page 1's pagination nav is the only one `parseTotalPages` reads — later pages don't need one.
const paymentPage = (rowsHtml: string, totalPages: number): string =>
  `<ul>${rowsHtml}</ul><nav class="paginate-container"><div class="pagination">
    <em class="current" data-total-pages="${totalPages}">1</em></div></nav>`

describe('fetchAllPayments', () => {
  it('stops the sequential walk once a fetched page is entirely at/older than since', async () => {
    const requested: number[] = []
    const dash = {
      billingBase: '/enterprises/acme-co/billing',
      getHtml: async (_path: string, params?: Record<string, string | number>) => {
        const page = (params?.page as number | undefined) ?? 1

        requested.push(page)

        if (page === 1) {
          return paymentPage(paymentRow('P1', '2026-06-20 10:00:00'), 3) // newest, past the watermark
        }

        if (page === 2) {
          return paymentPage(paymentRow('P2', '2026-05-01 10:00:00'), 3) // entirely at/older than since
        }

        return paymentPage(paymentRow('P3', '2026-01-01 10:00:00'), 3) // must never be requested
      }
    } as unknown as Dashboard

    const result = await fetchAllPayments(dash, '2026-06-01')

    expect(requested).toEqual([1, 2]) // page 3 never requested
    expect(result.payments.map((p) => p.id)).toEqual(['P1', 'P2'])
    expect(result).toMatchObject({ totalPages: 3, pagesFetched: 2 })
  })

  it('control: with no since, walks every page up to totalPages', async () => {
    const requested: number[] = []
    const dash = {
      billingBase: '/enterprises/acme-co/billing',
      getHtml: async (_path: string, params?: Record<string, string | number>) => {
        const page = (params?.page as number | undefined) ?? 1

        requested.push(page)

        return paymentPage(paymentRow(`P${page}`, '2026-01-01 10:00:00'), 3)
      }
    } as unknown as Dashboard

    const result = await fetchAllPayments(dash)

    expect(requested).toEqual([1, 2, 3])
    expect(result.payments.map((p) => p.id)).toEqual(['P1', 'P2', 'P3'])
    expect(result).toMatchObject({ totalPages: 3, pagesFetched: 3 })
  })
})

describe('sumIncludedUsage', () => {
  it('sums each discount currentAmount (the included-usage figure)', () => {
    expect(
      sumIncludedUsage({
        discounts: [{ currentAmount: 50.12, name: null }, { currentAmount: 92.936 }, { currentAmount: 1.4186081 }, {}]
      })
    ).toBeCloseTo(144.47, 2)
    expect(sumIncludedUsage({})).toBe(0)
  })
})

describe('extractGheLicensing', () => {
  it('pulls the props.ghe blob from the licensing react-partial', () => {
    const ghe = extractGheLicensing(licensingHtml)

    expect(ghe?.currentPayment).toBe('$1,365.00')
    expect(ghe?.enterpriseLicensesPurchased).toBe(67)
    expect(ghe?.paymentMethod?.card_type).toBe('MasterCard')
    expect(ghe?.pendingCycleChange?.newSeatCount).toBe(65)
  })

  it('returns null when the partial is absent or malformed', () => {
    expect(extractGheLicensing('<div>no partial here</div>')).toBeNull()
    expect(
      extractGheLicensing('<script type="application/json" data-target="react-partial.embeddedData">{bad json</script>')
    ).toBeNull()
  })
})

describe('extractCardExpiry', () => {
  it('reads the "expiring M/YYYY" line', () => {
    expect(extractCardExpiry('<li class="text-small">expiring 8/2026</li>')).toBe('8/2026')
    expect(extractCardExpiry('no expiry here')).toBeUndefined()
  })
})

describe('parseContacts', () => {
  it('scrapes billing contacts, flags Primary, and orders primary first', () => {
    expect(parseContacts(contactsHtml)).toEqual([
      { email: 'billing@acme-co.example', primary: true },
      { email: 'receipts@acme-co.example', primary: false }
    ])
  })

  it('returns [] for empty/iconless markup', () => {
    expect(parseContacts('<div class="Box-row"><div>header</div></div>')).toEqual([])
  })
})

// --- the Summary tab ---

describe('buildGithubSummary', () => {
  it('builds a monthly-paid trend from successful payments only', () => {
    const monthly = tableById(buildGithubSummary(args({ payments: parsePaymentHistory(html) })), 'monthly')

    // Only the successful 2026-05 charge contributes; the declined 2026-03 row is excluded.
    expect(monthly).toEqual([{ month: '2026-05', amount: 3199.32 }])
  })

  it('computes metered net = gross − included and MTD = net + monthly license', () => {
    const result = buildGithubSummary(
      args({
        usageTotal: { usage: { totalGrossAmount: 195.100630145 } },
        discounts: { discounts: [{ currentAmount: 100 }, { currentAmount: 45.98 }] },
        ghe: extractGheLicensing(licensingHtml)
      })
    )

    expect(recordById(result, 'metered')).toEqual({ gross: 195.1, included: 145.98, net: 49.12 })
    // MTD = net 49.12 + license 1365 = 1414.12
    expect(recordById(result, 'account').currentMtd).toBeCloseTo(1414.12, 2)
    expect(result.summaries?.[0]).toMatchObject({ section: 'spend', value: 1414.12, spark: { dataset: 'monthly' } })
    // invoices/license/payments live on the detail tab, not Summary
    expect(result.datasets.some((d) => d.id === 'payments' || d.id === 'license')).toBe(false)
    expect(validateCapabilityResult(result)).toEqual([])
  })

  it('clamps net at 0 when discounts exceed gross', () => {
    const result = buildGithubSummary(
      args({ usageTotal: { usage: { totalGrossAmount: 10 } }, discounts: { discounts: [{ currentAmount: 99 }] } })
    )

    expect(recordById(result, 'metered').net).toBe(0)
  })

  it('null MTD and no summary when every billing surface is empty', () => {
    const result = buildGithubSummary(args())

    expect(recordById(result, 'account').currentMtd).toBeNull()
    expect(recordById(result, 'metered')).toEqual({ gross: 0, included: 0, net: 0 })
    expect(result.summaries).toBeUndefined()
    expect(validateCapabilityResult(result)).toEqual([])
  })
})

// --- the Billing detail tab ---

describe('buildGithubBilling', () => {
  it('sums only successful payments and counts statuses', () => {
    const result = buildGithubBilling(args({ payments: parsePaymentHistory(html), totalPages: 7, pagesFetched: 1 }))
    const totals = recordById(result, 'totals')

    expect(totals.totalPaid).toBeCloseTo(3199.32, 2) // declined excluded
    expect(totals).toMatchObject({ succeeded: 1, declined: 1, transactions: 2 })
    // Payments table newest-first; declined row carries no receipt link.
    const rows = tableById(result, 'payments')

    expect(rows.map((r) => r.id)).toEqual(['AAA111', 'BBB222'])
    expect(rows[1]).toMatchObject({ status: 'Declined', receipt: null })
    // Keyed by the transaction id so each payment accumulates its status/amount history in the ledger.
    const payments = result.datasets.find((d) => d.id === 'payments')

    expect(payments?.shape === 'table' && payments.key).toBe('id')
    // headline + chart live on Summary
    expect(result.datasets.some((d) => d.id === 'account' || d.id === 'monthly' || d.id === 'metered')).toBe(false)
    expect(validateCapabilityResult(result)).toEqual([])
  })

  it('makes the payment-history table downloadable on the invoice column, with a filename row field', () => {
    const result = buildGithubBilling(args({ payments: parsePaymentHistory(html) }))
    const view = result.views?.find((v) => v.type === 'table' && v.dataset === 'payments') as { files?: unknown }

    expect(view.files).toMatchObject({ source: { url: 'invoice' }, name: 'name', ext: 'pdf', category: 'Invoices' })
    expect(tableById(result, 'payments')[0]).toMatchObject({ name: 'Invoice 2026-05-17' })
  })

  it('renders the license detail when present', () => {
    const result = buildGithubBilling(args({ ghe: extractGheLicensing(licensingHtml) }))
    const license = recordById(result, 'license')

    expect(license).toMatchObject({
      monthly: 1365,
      term: 'Monthly',
      seats: '62/67 seats',
      unitCost: '$21.00/user per month'
    })
    expect(license.pending).toBe('↓ 65 seats on 2026-06-17')
    expect(validateCapabilityResult(result)).toEqual([])
  })

  it('surfaces the payment method (card from license blob + expiry from payment-info)', () => {
    const result = buildGithubBilling(args({ ghe: extractGheLicensing(licensingHtml), cardExpiry: '8/2026' }))

    expect(recordById(result, 'paymentMethod')).toEqual({ card: 'MasterCard •••• 5587', expiry: '8/2026' })
  })

  it('renders billing contacts as a table when present', () => {
    const result = buildGithubBilling(args({ contacts: parseContacts(contactsHtml) }))

    expect(tableById(result, 'contacts')).toEqual([
      { email: 'billing@acme-co.example', primary: 'Primary' },
      { email: 'receipts@acme-co.example', primary: null }
    ])
    // Keyed by the email so each contact accumulates in the ledger.
    const contacts = result.datasets.find((d) => d.id === 'contacts')

    expect(contacts?.shape === 'table' && contacts.key).toBe('email')
    expect(validateCapabilityResult(result)).toEqual([])
  })

  it('no optional sections, valid result when every summary is empty', () => {
    const result = buildGithubBilling(args())

    expect(result.datasets.find((d) => d.id === 'license')).toBeUndefined()
    expect(result.datasets.find((d) => d.id === 'paymentMethod')).toBeUndefined()
    expect(result.datasets.find((d) => d.id === 'contacts')).toBeUndefined()
    expect(validateCapabilityResult(result)).toEqual([])
  })
})

describe('github-enterprise capabilities', () => {
  it('leads with a Summary tab (kind billing) and has no separate documents capability', () => {
    expect(githubEnterprisePlugin.capabilities[0]).toMatchObject({ id: 'summary' })
    expect(githubEnterprisePlugin.capabilities.some((c) => c.id === 'billing')).toBe(true)
    expect(githubEnterprisePlugin.capabilities.some((c) => 'enumerate' in c)).toBe(false)
  })

  it('prefills the enterprise slug from the dashboard URL', () => {
    expect(githubEnterprisePlugin.session?.captureFromUrl).toContainEqual({
      pattern: '/enterprises/([^/?#]+)',
      storeAs: 'enterpriseSlug'
    })
  })
})

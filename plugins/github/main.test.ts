import type { CapabilityResult } from '@butinapp/sdk/data'
import { resultValidator, validateSamples } from '@butinapp/sdk/testing'
import { describe, expect, test } from 'vitest'

import {
  buildGithubBilling,
  extractBillingApp,
  extractFetchNonce,
  type GithubBillingRaw,
  githubPlugin,
  parsePaymentHistory,
  parseTotalPages
} from './main.js'

const validate = resultValidator('USD')

const dataset = (result: CapabilityResult, id: string) =>
  result.datasets.find((d) => d.id === id) as unknown as {
    value: Record<string, unknown>
    rows: Record<string, unknown>[]
  }

// Invented values in the recorded markup shape.
const historyRow = (o: { date: string; id: string; amount: string; status: string; tx: string }) => `
  <li data-view-component="true" class="Box-row p-2">
    <div class="clearfix">
      <div class="col-2 float-left date"><time title="${o.date} 10:00:00" class="no-wrap">${o.date}</time></div>
      <div class="col-2 float-left id"><code><span id="short-transaction-id-${o.id}">
        ${o.id}
      </span></code></div>
      <div class="col-3 float-left method "><svg class="octicon octicon-credit-card"></svg>
        Visa ending in 1234
      </div>
      <div class="col-2 float-left amount">
        ${o.amount}
      </div>
      <div class="col-1 float-left status"><span class="Label Label--success">
        ${o.status}
      </span></div>
      <div class="col-1 float-left text-center receipt">
        <span><a href="/account/receipt/ch_${o.id}"></a></span>
        <span><a href="/account/receipt/ch_${o.id}.pdf"></a></span>
      </div>
      <div class="col-1 float-left text-center">
        <invoice-download data-url=/users/octo/billing/invoices/download?transaction_id=${o.tx} data-transaction=${o.id}>
        </invoice-download>
      </div>
    </div>
  </li>`

const HISTORY_HTML = `<html><head><meta name="fetch-nonce" content="v2:00000000-0000-0000-0000-000000000000"></head><body>
  <ul>
    <li class="Box-row">header row, no transaction</li>
    ${historyRow({ date: '2001-02-14', id: 'AAAA1111', amount: '$1,500.00', status: 'Success', tx: '111' })}
    ${historyRow({ date: '2001-03-14', id: 'BBBB2222', amount: '$250.00', status: 'Declined', tx: '222' })}
    ${historyRow({ date: '2001-03-15', id: 'CCCC3333', amount: '$250.00', status: 'Success', tx: '333' })}
  </ul>
  <div class="paginate-container"><em class="current" data-total-pages="3">1</em></div>
</body></html>`

const BILLING_HTML = `<html><head><meta name="fetch-nonce" content="v2:11111111-1111-1111-1111-111111111111"></head><body>
  <turbo-frame id="settings-frame">
    <react-app app-name="billing-app" initial-path="/settings/billing">
      <script type="application/json" data-target="react-app.embeddedData">{"payload":{"customer":{"billingTarget":1,"customerId":1234567,"customerType":"User","plan":"pro","planDuration":"month","paymentAmount":"10.0","planPrice":10.0},"nextPaymentTileData":{"nextPaymentDate":"Jan 1, 2001"}},"title":"Billing Overview"}</script>
    </react-app>
  </turbo-frame>
</body></html>`

describe('dashboard scraping', () => {
  test('extractFetchNonce reads the meta tag and throws when the page is unauthenticated', () => {
    expect(extractFetchNonce(BILLING_HTML)).toBe('v2:11111111-1111-1111-1111-111111111111')
    expect(() => extractFetchNonce('<html></html>')).toThrow(/fetch-nonce/)
  })

  test('extractBillingApp pulls the customer out of the billing-app payload', () => {
    expect(extractBillingApp(BILLING_HTML)?.customer).toMatchObject({ customerId: 1234567, plan: 'pro', planPrice: 10 })
    expect(extractBillingApp('<html></html>')).toBeNull()
  })

  test('parsePaymentHistory parses every transaction row and skips non-transaction rows', () => {
    const rows = parsePaymentHistory(HISTORY_HTML)

    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      date: '2001-02-14',
      id: 'AAAA1111',
      method: 'Visa ending in 1234',
      amount: 1500,
      status: 'Success',
      receiptUrl: 'https://github.com/account/receipt/ch_AAAA1111',
      invoiceUrl: 'https://github.com/users/octo/billing/invoices/download?transaction_id=111'
    })
    expect(rows[1].status).toBe('Declined')
  })

  test('parseTotalPages reads the paginator and defaults to 1', () => {
    expect(parseTotalPages(HISTORY_HTML)).toBe(3)
    expect(parseTotalPages('<html></html>')).toBe(1)
  })
})

describe('buildGithubBilling', () => {
  const raw: GithubBillingRaw = {
    app: extractBillingApp(BILLING_HTML),
    payments: parsePaymentHistory(HISTORY_HTML),
    usageTotal: { usage: { billableAmount: 12.5 } },
    discounts: { discounts: [{ currentAmount: 7.25 }, { currentAmount: 0 }, {}] }
  }

  test('MTD = monthly plan fee + net metered usage; declined charges are dropped', () => {
    const result = buildGithubBilling(raw)

    expect(validate(result)).toEqual([])

    const account = dataset(result, 'account')

    expect(account.value).toMatchObject({
      currentMtd: 15.25,
      baseFee: 10,
      meteredMtd: 5.25,
      plan: 'Pro'
    })

    const invoices = dataset(result, 'invoices')
    const rows = invoices.rows

    expect(rows.map((r) => r.id)).toEqual(['CCCC3333', 'AAAA1111'])
    expect(rows[0]).toMatchObject({
      amount: 250,
      pdfUrl: 'https://github.com/users/octo/billing/invoices/download?transaction_id=333'
    })

    const pm = dataset(result, 'paymentMethod')

    expect(pm.value).toMatchObject({ brand: 'Visa', last4: '1234' })

    expect(result.summaries?.[0]).toMatchObject({ section: 'spend', value: 15.25, basis: 'accrued' })
  })

  test('an annual plan contributes no base fee, and no billing signal means no MTD', () => {
    const annual = buildGithubBilling({
      ...raw,
      app: { customer: { plan: 'pro', planDuration: 'year', planPrice: 100 } }
    })
    const account = dataset(annual, 'account')

    expect(account.value).toMatchObject({
      currentMtd: 5.25,
      baseFee: null,
      plan: 'Pro (annual)'
    })

    const empty = buildGithubBilling({ app: null, payments: [], usageTotal: {}, discounts: {} })

    expect(validate(empty)).toEqual([])
    expect(empty.summaries).toBeUndefined()
  })
})

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(githubPlugin)).toEqual([])
})

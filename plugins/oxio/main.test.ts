import type { CapabilityResult } from '@butinapp/sdk/data'
import { resultValidator, validateSamples } from '@butinapp/sdk/testing'
import { expect, test } from 'vitest'

import {
  buildOxioAccount,
  buildOxioBilling,
  buildOxioPlan,
  buildOxioSummary,
  extractOxioToken,
  oxioAccountNumber,
  oxioMonthlyCharge,
  oxioPlugin,
  oxioProductName,
  type OxioAccountRaw,
  type OxioBillingRaw,
  type OxioSummaryRaw,
  type RawOxioAccount
} from './main.js'

// Core stamps the plugin's reportingCurrency onto every unlabeled money value before validating, so the
// fixtures below assert against the same resolved result the app renders.
const check = resultValidator('CAD')

const cell = (result: CapabilityResult, dataset: string, key: string): unknown => {
  const ds = result.datasets.find((d) => d.id === dataset)

  return ds?.shape === 'record' ? ds.value[key] : undefined
}

const rows = (result: CapabilityResult, dataset: string): Record<string, unknown>[] => {
  const ds = result.datasets.find((d) => d.id === dataset)

  return ds?.shape === 'table' ? ds.rows : []
}

// All fixtures are SYNTHETIC — structurally faithful to the GraphQL responses but with invented data. That
// covers the identifiers as much as the names: an account id, an invoice number and a card's last four each
// identify on their own. The repo is public.

const ACCOUNT: RawOxioAccount = {
  status: 'ACTIVE',
  gaiiaId: 100200,
  createdAt: '2025-08-03T15:12:43+00:00',
  referralCode: 'RA00001',
  internetProvider: 'COGECO',
  primaryContact: {
    firstName: 'Demo',
    lastName: 'Person',
    email: 'demo@example.invalid',
    homePhone: null,
    mobilePhone: '555-0100'
  },
  physicalAddress: { line1: '1 rue de la Démo', locality: 'Saint-Gabriel', region: 'QC', postalCode: 'J0K 2N0' },
  mailingAddress: { line1: '1 rue de la Démo', locality: 'Saint-Gabriel', region: 'QC', postalCode: 'J0K 2N0' },
  internetRequests: [{ type: 'SELF_INSTALL', status: 'SUCCESS' }],
  operations: [
    { id: 'op-1', type: 'ACTIVATION', status: 'COMPLETED' },
    { id: 'op-2', type: 'SHIPMENT', status: 'COMPLETED' }
  ],
  communicationPreferences: { smsMessagingEnabled: true, emailMessagingEnabled: false, languagePreference: 'fr' },
  clientPortalUser: { username: 'demo@example.invalid', passwordLastModifiedAt: '2025-08-03T15:14:24+00:00' },
  productSubscriptions: {
    edges: [
      {
        node: {
          // An ended add-on stays in the list — it must not count toward the recurring charge.
          unassignedAt: '2026-08-08T16:20:53+00:00',
          version: {
            id: 'pv-credit',
            price: 0,
            product: {
              slug: 'outage-bill-credit',
              name: 'Outage Bill Credit ',
              productCategory: { slug: 'discounts' },
              translations: [{ languageId: 'en', key: 'product.outage-bill-credit.name', value: 'Outage Credit' }],
              rawSpecificationValue: { __category: 'discounts' }
            }
          }
        }
      },
      {
        node: {
          unassignedAt: null,
          version: {
            id: 'pv-plan',
            price: 3500,
            product: {
              slug: 'cable100qc',
              name: 'Cable100_QC',
              productCategory: { slug: 'internet-plan' },
              translations: [
                { languageId: 'fr', key: 'product.cable100qc.name', value: 'Internet : 100 mbit/s' },
                { languageId: 'en', key: 'product.cable100qc.name', value: 'Internet: 100 Mbps 10 Mbps [QC]' }
              ],
              rawSpecificationValue: {
                provider: 'COGECO',
                __category: 'internet-plan',
                supportedDevices: 10,
                downloadSpeedInKbps: 100000,
                maxUploadSpeedInKbps: 10000
              }
            }
          }
        }
      },
      {
        node: {
          unassignedAt: null,
          version: {
            id: 'pv-phone',
            price: 1500,
            product: {
              slug: 'additional-phone-line',
              name: 'Additional phone line',
              productCategory: { slug: 'residential-phone-plan' },
              translations: [],
              rawSpecificationValue: { isAddon: true, __category: 'residential-phone-plan' }
            }
          }
        }
      }
    ]
  }
}

const SUMMARY: OxioSummaryRaw = {
  account: ACCOUNT,
  params: {
    billDay: 8,
    nextBillDate: '2026-09-08',
    availableFunds: 0,
    nextRecurringChargeAmount: 3500,
    nextRecurringChargeTaxes: 524,
    balanceDue: 1250,
    totalBalance: 1250,
    isDelinquent: false
  }
}

const BILLING: OxioBillingRaw = {
  params: SUMMARY.params,
  invoices: [
    {
      id: 'inv-1',
      amountRemaining: 1250,
      invoiceNumber: '10000001',
      fromDate: '2026-08-08',
      s3Key: 'inv-1/oxio-2026-08-08.pdf',
      dueDate: '2026-08-29'
    },
    {
      id: 'inv-2',
      amountRemaining: 0,
      invoiceNumber: '10000002',
      fromDate: '2026-07-08',
      s3Key: 'inv-2/oxio-2026-07-08.pdf',
      dueDate: '2026-07-29'
    }
  ],
  paymentMethods: [
    {
      id: 'pm-1',
      createdAt: '2025-08-03T15:12:46+00:00',
      autoPaymentEnabled: false,
      creditCard: {
        brand: 'MASTERCARD',
        maskedIdentificationNumber: '1122',
        expirationMonth: 1,
        expirationYear: 2030
      },
      bankAccount: null
    },
    {
      id: 'pm-2',
      createdAt: '2025-11-17T02:14:38+00:00',
      autoPaymentEnabled: true,
      creditCard: null,
      bankAccount: { maskedIdentificationNumber: '3344' }
    }
  ]
}

const ACCOUNT_RAW: OxioAccountRaw = {
  account: ACCOUNT,
  referrals: [
    {
      id: 'ref-1',
      firstName: 'Friend',
      lastName: 'Example',
      refereeEmail: 'friend@example.invalid',
      refereeSms: null,
      status: 'SENT',
      sentOn: '2026-06-01T12:00:00+00:00',
      creditWillBeAppliedOn: '2026-07-01T12:00:00+00:00',
      refererAmountInCents: 3500
    }
  ]
}

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(oxioPlugin)).toEqual([])
})

test('the API token is the access_token cookie value, not the whole jar', () => {
  expect(extractOxioToken('i18next=fr; access_token=eyJhbGc.payload.sig; _ga=GA1.1')).toBe('eyJhbGc.payload.sig')
  expect(extractOxioToken('access_token=lead; other=x')).toBe('lead')
  // A jar captured before sign-in carries no token; a cookie merely CONTAINING the name must not match.
  expect(extractOxioToken('i18next=fr; my_access_token=nope')).toBeUndefined()
  expect(extractOxioToken(undefined)).toBeUndefined()
})

// --- summary ---

test('the recurring charge sums only the live subscriptions', () => {
  const subs = (ACCOUNT.productSubscriptions?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : []))

  // $35.00 plan + $15.00 phone line; the ended outage credit is excluded.
  expect(oxioMonthlyCharge(subs)).toBe(50)
  expect(oxioMonthlyCharge([])).toBeNull()
})

test('the account number reads as it does on the bill', () => {
  expect(oxioAccountNumber(ACCOUNT)).toBe('00100200')
  expect(oxioAccountNumber({})).toBeNull()
})

test('a product renders its customer-facing English name, not the internal one', () => {
  const plan = ACCOUNT.productSubscriptions?.edges?.[1]?.node?.version?.product

  expect(oxioProductName(plan)).toBe('Internet: 100 Mbps 10 Mbps [QC]')
  // No translation → the internal name, then the slug.
  expect(oxioProductName({ name: 'Additional phone line', translations: [] })).toBe('Additional phone line')
  expect(oxioProductName({ slug: 'mystery' })).toBe('mystery')
  expect(oxioProductName(null)).toBe('Unknown')
})

test('buildOxioSummary headlines the flat recurring charge with the account standing', () => {
  const result = buildOxioSummary(SUMMARY)

  expect(check(result)).toEqual([])
  expect(cell(result, 'account', 'currentMtd')).toBe(50)
  expect(cell(result, 'account', 'plan')).toBe('Internet: 100 Mbps 10 Mbps [QC]')
  expect(cell(result, 'account', 'balanceDue')).toBe(12.5)
  expect(cell(result, 'account', 'nextBill')).toBe('2026-09-08')
  expect(cell(result, 'account', 'accountNumber')).toBe('00100200')

  const summary = result.summaries?.[0]

  expect(summary).toMatchObject({ section: 'spend', basis: 'flat', value: 50 })
  // The Overview needs a spark even before any month has accrued a bar.
  expect(summary?.spark).toMatchObject({ dataset: 'monthly', x: 'month', y: 'amount' })
  expect(rows(result, 'monthly')).toEqual([])
})

test('buildOxioSummary reports no spend for an account with no live subscription', () => {
  const result = buildOxioSummary({ account: { ...ACCOUNT, productSubscriptions: { edges: [] } }, params: null })

  expect(check(result)).toEqual([])
  expect(result.summaries ?? []).toEqual([])
  expect(cell(result, 'account', 'balanceDue')).toBeNull()
})

// --- billing ---

test('buildOxioBilling normalizes the cycle, the cards, and the bill list', () => {
  const result = buildOxioBilling(BILLING)

  expect(check(result)).toEqual([])
  expect(cell(result, 'cycle', 'nextCharge')).toBe(35)
  expect(cell(result, 'cycle', 'taxes')).toBe(5.24)
  expect(cell(result, 'cycle', 'balanceDue')).toBe(12.5)
  expect(cell(result, 'cycle', 'paymentStatus')).toBe('Current')

  expect(rows(result, 'paymentMethods')).toEqual([
    {
      id: 'pm-1',
      method: 'Mastercard',
      last4: '1122',
      expires: '01/2030',
      autoPay: 'Disabled',
      createdAt: '2025-08-03'
    },
    // A bank account has no brand or expiry, and still shows its masked number.
    { id: 'pm-2', method: 'Bank account', last4: '3344', expires: null, autoPay: 'Enabled', createdAt: '2025-11-17' }
  ])

  const invoices = rows(result, 'invoices')

  expect(invoices).toHaveLength(2)
  expect(invoices[0]).toMatchObject({ fromDate: '2026-08-08', balance: 12.5, status: 'Outstanding' })
  expect(invoices[1]).toMatchObject({ invoiceNumber: '10000002', balance: 0, status: 'Paid' })
  // The download key rides hidden on the row — fetchFile exchanges it for a signed URL.
  expect(invoices[0].s3Key).toBe('inv-1/oxio-2026-08-08.pdf')
})

test('the invoices table sources its bytes from fetchFile, since the URL is minted per download', () => {
  const view = buildOxioBilling(BILLING).views?.find((v) => v.type === 'table' && v.dataset === 'invoices')

  expect(view).toMatchObject({ files: { source: { fetch: true }, name: 'name', ext: 'pdf' } })
  expect(oxioPlugin.capabilities.find((c) => c.id === 'billing')?.fetchFile).toBeDefined()
})

test('buildOxioBilling drops the payment-methods panel when the account has none', () => {
  const result = buildOxioBilling({ params: null, invoices: [], paymentMethods: [] })

  expect(check(result)).toEqual([])
  expect(result.datasets.some((d) => d.id === 'paymentMethods')).toBe(false)
  expect(cell(result, 'cycle', 'balanceDue')).toBeNull()
})

// --- plan ---

test('buildOxioPlan reads the speeds off the plan spec and lists every subscription', () => {
  const result = buildOxioPlan({ account: ACCOUNT })

  expect(check(result)).toEqual([])
  expect(cell(result, 'service', 'download')).toBe(100)
  expect(cell(result, 'service', 'upload')).toBe(10)
  expect(cell(result, 'service', 'devices')).toBe(10)
  expect(cell(result, 'service', 'price')).toBe(35)
  expect(cell(result, 'service', 'provider')).toBe('Cogeco')
  expect(cell(result, 'service', 'address')).toBe('1 rue de la Démo, Saint-Gabriel, QC J0K 2N0')

  expect(rows(result, 'subscriptions')).toHaveLength(3)
  expect(rows(result, 'subscriptions')[0]).toMatchObject({ status: 'Ended', ended: '2026-08-08', price: 0 })
  expect(rows(result, 'subscriptions')[1]).toMatchObject({ status: 'Active', ended: null, category: 'internet-plan' })
  // Account operations and internet requests are one provisioning trail.
  expect(rows(result, 'requests').map((r) => r.type)).toEqual(['Activation', 'Shipment', 'Self Install'])
})

test('buildOxioPlan renders an empty account without inventing sections', () => {
  const result = buildOxioPlan({ account: null })

  expect(check(result)).toEqual([])
  expect(result.datasets.map((d) => d.id)).toEqual(['service'])
  expect(cell(result, 'service', 'plan')).toBeNull()
})

// --- account ---

test('buildOxioAccount folds identity, portal, and preferences into one record', () => {
  const result = buildOxioAccount(ACCOUNT_RAW)

  expect(check(result)).toEqual([])
  expect(cell(result, 'holder', 'name')).toBe('Demo Person')
  expect(cell(result, 'holder', 'createdAt')).toBe('2025-08-03')
  expect(cell(result, 'holder', 'language')).toBe('FR')
  // Email messaging is off in the fixture, so only SMS is listed.
  expect(cell(result, 'holder', 'notifications')).toBe('SMS')
  expect(cell(result, 'holder', 'referralCode')).toBe('RA00001')
  expect(cell(result, 'addresses', 'mailing')).toBe('1 rue de la Démo, Saint-Gabriel, QC J0K 2N0')

  expect(rows(result, 'referrals')[0]).toMatchObject({
    name: 'Friend Example',
    contact: 'friend@example.invalid',
    credit: 35,
    sentOn: '2026-06-01'
  })
})

test('buildOxioAccount drops the referrals table when none were sent', () => {
  const result = buildOxioAccount({ account: ACCOUNT, referrals: [] })

  expect(check(result)).toEqual([])
  expect(result.datasets.some((d) => d.id === 'referrals')).toBe(false)
})

// --- descriptor ---

test('oxio replays the cookie-borne API token and leads with Summary', () => {
  expect(oxioPlugin.auth).toMatchObject({ kind: 'cookie-csrf' })
  expect(oxioPlugin.session?.requiredCookie).toBe('access_token')
  expect(oxioPlugin.reportingCurrency).toBe('CAD')
  expect(oxioPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'plan', 'account'])
})

test('ships a French map for the labels the shared dictionary does not carry', () => {
  const fr = oxioPlugin.meta.messages?.fr

  expect(fr?.['Monthly charge']).toBe('Frais mensuels')
  expect(fr?.['Balance due']).toBe('Solde dû')
  expect(fr?.['Internet service']).toBe('Service Internet')
})

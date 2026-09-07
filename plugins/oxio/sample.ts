// Synthetic sample GENERATORS for the demo seed — each fabricates the raw GraphQL bundle a capability's
// `fetch` returns, purely from the seeded toolkit (no literal data), and the seed draws it through the SAME
// `build` the live collector uses. Amounts stay in the wire's own unit (CENTS); `build` normalizes them.
// The `documents` knob scales the invoice history, `users` the referral list.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type {
  OxioAccountRaw,
  OxioBillingRaw,
  OxioPlanRaw,
  OxioSummaryRaw,
  RawOxioAccount,
  RawOxioBillingParameters,
  RawOxioInvoice,
  RawOxioPaymentMethod,
  RawOxioSubscription
} from './main.js'

const PLANS = [
  { slug: 'fibre150qc', label: 'Internet: 150 Mbps / 30 Mbps [QC]', down: 150_000, up: 30_000, price: 4500 },
  { slug: 'cable100qc', label: 'Internet: 100 Mbps / 10 Mbps [QC]', down: 100_000, up: 10_000, price: 3500 },
  { slug: 'fibre1000qc', label: 'Internet: 1000 Mbps / 100 Mbps [QC]', down: 1_000_000, up: 100_000, price: 7500 }
]

const PROVIDERS = ['COGECO', 'BELL', 'ROGERS', 'VIDEOTRON']

// A product carries its internal name plus one `product.<slug>.name` translation per language — the English
// one is what the plugin renders.
const product = (slug: string, label: string, category: string, spec: Record<string, unknown> = {}) => ({
  slug,
  name: slug.toUpperCase(),
  productCategory: { slug: category },
  translations: [
    { languageId: 'en', key: `product.${slug}.name`, value: label },
    { languageId: 'fr', key: `product.${slug}.name`, value: label }
  ],
  rawSpecificationValue: { __category: category, ...spec }
})

const sampleSubscriptions = (g: SampleGen): RawOxioSubscription[] => {
  const plan = g.pick(PLANS)

  return [
    {
      unassignedAt: null,
      version: {
        id: g.id('pv'),
        price: plan.price,
        product: product(plan.slug, plan.label, 'internet-plan', {
          provider: g.pick(PROVIDERS),
          supportedDevices: g.int(5, 20),
          downloadSpeedInKbps: plan.down,
          maxUploadSpeedInKbps: plan.up
        })
      }
    },
    {
      unassignedAt: g.midnightIso(90),
      version: { id: g.id('pv'), price: 0, product: product('outage-credit', 'Outage Credit', 'discounts') }
    }
  ]
}

const sampleAccount = (g: SampleGen): RawOxioAccount => {
  const holder = g.person(0)
  // g.address() is a full one-line address; the wire splits it, so keep only its street part as line1.
  const address = {
    line1: g.address().split(',')[0],
    locality: g.pick(['Saint-Gabriel', 'Sherbrooke', 'Trois-Rivières', 'Gatineau']),
    region: 'QC',
    postalCode: g.postal()
  }

  return {
    status: 'ACTIVE',
    gaiiaId: g.int(100_000, 999_999),
    createdAt: g.midnightIso(900),
    referralCode: g.seqId('RA', g.int(10_000, 99_999), 5),
    internetProvider: g.pick(PROVIDERS),
    primaryContact: {
      firstName: holder.firstName,
      lastName: holder.lastName,
      email: holder.email,
      homePhone: null,
      mobilePhone: g.phone()
    },
    physicalAddress: address,
    mailingAddress: address,
    internetRequests: [{ type: 'SELF_INSTALL', status: 'SUCCESS' }],
    operations: [
      { id: g.id('op'), type: 'ACTIVATION', status: 'COMPLETED' },
      { id: g.id('op'), type: 'SHIPMENT', status: 'COMPLETED' }
    ],
    communicationPreferences: { smsMessagingEnabled: true, emailMessagingEnabled: true, languagePreference: 'fr' },
    clientPortalUser: { username: holder.email, passwordLastModifiedAt: g.midnightIso(900) },
    productSubscriptions: { edges: sampleSubscriptions(g).map((node) => ({ node })) }
  }
}

// Every money field is cents. An account in good standing owes nothing, so the balances read 0; the upcoming
// charge is the recurring plan plus Québec's ~15% sales tax.
const sampleBillingParameters = (g: SampleGen): RawOxioBillingParameters => {
  const charge = g.amountCents(3000, 8000)

  return {
    billDay: g.int(1, 28),
    nextBillDate: `${g.monthsAgo(-1).yearMonth}-08`,
    availableFunds: 0,
    nextRecurringChargeAmount: charge,
    nextRecurringChargeTaxes: Math.round(charge * 0.14975),
    balanceDue: 0,
    totalBalance: 0,
    isDelinquent: false
  }
}

export const sampleOxioSummary = (g: SampleGen): OxioSummaryRaw => ({
  account: sampleAccount(g),
  params: sampleBillingParameters(g)
})

export const sampleOxioPlan = (g: SampleGen): OxioPlanRaw => ({ account: sampleAccount(g) })

// One bill per month, newest first — the shape the connection returns. `s3Key` is the download key, never a URL.
const sampleInvoices = (g: SampleGen, months: number): RawOxioInvoice[] =>
  g.repeat(months, (i) => {
    const id = g.id('inv')
    const day = `${g.monthsAgo(i).yearMonth}-08`

    return {
      id,
      amountRemaining: i === 0 ? g.amountCents(0, 4000) : 0,
      invoiceNumber: g.seqId('', 25_000_000 - i * 1000, 8),
      fromDate: day,
      s3Key: `${id}/oxio-${day}.pdf`,
      dueDate: `${g.monthsAgo(i).yearMonth}-29`
    }
  })

const samplePaymentMethods = (g: SampleGen): RawOxioPaymentMethod[] => [
  {
    id: g.id('pm'),
    createdAt: g.midnightIso(900),
    autoPaymentEnabled: true,
    creditCard: {
      brand: g.pick(['VISA', 'MASTERCARD', 'AMEX']),
      maskedIdentificationNumber: g.last4(),
      expirationMonth: g.int(1, 12),
      expirationYear: 2030
    },
    bankAccount: null
  }
]

export const sampleOxioBilling = (g: SampleGen, config: SampleConfig): OxioBillingRaw => ({
  params: sampleBillingParameters(g),
  invoices: sampleInvoices(g, Math.max(1, Math.min(config.documents, 24))),
  paymentMethods: samplePaymentMethods(g)
})

export const sampleOxioAccount = (g: SampleGen, config: SampleConfig): OxioAccountRaw => ({
  account: sampleAccount(g),
  referrals: g.repeat(Math.min(config.users, 4), (i) => {
    const friend = g.person(i + 1)

    return {
      id: g.id('ref'),
      firstName: friend.firstName,
      lastName: friend.lastName,
      refereeEmail: friend.email,
      refereeSms: null,
      status: g.pick(['SENT', 'ACCEPTED', 'CREDITED']),
      sentOn: g.midnightIso(180),
      creditWillBeAppliedOn: g.midnightIso(60),
      refererAmountInCents: 3500
    }
  })
})

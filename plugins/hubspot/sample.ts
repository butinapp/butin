// Synthetic sample GENERATORS for the demo seed — each builds a raw service bundle purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live
// collector uses. The `documents`/`users`/`days` knobs scale the invoice/usage/member counts.
// HubSpot money is in DOLLARS already; usage values are plain counts.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type {
  RawHubspotBillingBundle,
  RawHubspotUsageBundle,
  RawHubspotUsersResponse,
  RawMarketableContactsResponse,
  RawPaidProductsResponse
} from './main.js'

// [year, month, day] from a deterministic synthetic 'YYYY-MM-DD' day string (never the wall clock).
const ymd = (day: string): number[] => day.split('-').map(Number)

// Paid products — shared by both the Billing and Usage bundles (build flattens the products + limits).
const samplePaidProducts = (g: SampleGen): RawPaidProductsResponse[] => [
  {
    subscriptionId: g.int(1000, 9999),
    paidProducts: [
      {
        name: 'Marketing Hub',
        type: 'MARKETING',
        productTier: 'PROFESSIONAL',
        quantity: 1,
        limits: [
          { name: 'contacts', limit: 10_000, used: g.int(4_000, 9_000) },
          { name: 'email_sends', limit: 100_000, used: g.int(15_000, 60_000) }
        ],
        quantityPacks: [
          { name: 'Extra contacts pack', limits: [{ name: 'extra_contacts', limit: 5000, used: g.int(500, 4_500) }] }
        ]
      },
      {
        name: 'Sales Hub',
        type: 'SALES_SEAT',
        productTier: 'PROFESSIONAL',
        quantity: 5,
        limits: [{ name: 'sales-seats', limit: 5, used: g.int(1, 5) }]
      }
    ]
  }
]

// A run of monthly invoices (newest by date after build's sort), so the monthly-spend chart fills out.
export const sampleHubspotBilling = (g: SampleGen, config: SampleConfig): RawHubspotBillingBundle => {
  const months = Math.max(1, Math.min(config.documents, 14))
  const nextDay = g.dayString(0)

  return {
    invoices: {
      transactions: g.repeat(months, (i) => {
        const m = g.monthsAgo(i)

        return {
          type: 'INVOICE',
          issued: `${m.yearMonth}-01T10:00:00.000`,
          issuedTimestamp: m.startEpochMs,
          pdfUrl: `https://example.invalid/invoice/${g.id('inv')}.pdf`,
          status: 'PROCESSED',
          products: ['Marketing Hub'],
          invoiceAmount: g.money(1_000, 2_000),
          balanceDue: 0,
          dueDate: `${m.yearMonth}-01`,
          currencyCode: 'USD',
          id: g.id('INVOICE')
        }
      })
    },
    upcoming: {
      upcomingPayments: [
        {
          issueDate: ymd(nextDay),
          billingPeriodStart: ymd(nextDay),
          billingPeriodEnd: ymd(g.dayString(0)),
          amount: g.money(1_500, 2_200),
          currencyCode: 'USD',
          paymentMethodType: 'CREDIT_CARD',
          isProcessing: false
        }
      ]
    },
    paymentMethods: {
      paymentMethods: [
        {
          paymentMethodType: 'CREDIT_CARD',
          lastFour: g.last4(),
          creditCardVariant: 'visa',
          cardHolderName: g.person().name,
          creditCardExpirationMonth: g.int(1, 12),
          creditCardExpirationYear: 2029,
          expired: false
        }
      ]
    },
    paidProducts: samplePaidProducts(g),
    delinquency: { customerDelinquencyStatus: false, customerDelinquentInvoiceIds: [] }
  }
}

export const sampleHubspotUsage = (g: SampleGen, config: SampleConfig): RawHubspotUsageBundle => {
  const days = Math.max(1, Math.min(config.days, 60))
  const limit = 10_000

  const marketable: RawMarketableContactsResponse = {
    contactsTier: limit,
    latestCountForBilling: {
      date: g.dayString(1),
      marketableContactsCount: g.int(5_000, 9_000),
      marketableContactsLimit: limit
    },
    realTimeCount: {
      date: g.dayString(0),
      marketableContactsCount: g.int(5_000, 9_000),
      marketableContactsLimit: limit
    },
    usageByResolution: {
      resolution: 'DAILY',
      usage: g.repeat(days, (i) => ({
        date: g.dayString(days - i),
        marketableContactsCount: g.int(5_000, 9_000),
        marketableContactsLimit: limit
      }))
    }
  }

  const used = g.int(100, 800)

  return {
    paidProducts: samplePaidProducts(g),
    seatInfo: [{ maxAssignableSeats: 5, currentAssignedSeats: g.int(1, 5), seatName: 'core' }],
    marketable,
    credits: {
      type: 'data',
      data: {
        startDate: g.dayString(30),
        endDate: g.dayString(0),
        creditsUsed: used,
        totalCredits: 1000,
        grantedCredits: 0,
        overages: 0,
        percentageOfTotalCreditsUsed: Math.round((used / 1000) * 100)
      }
    }
  }
}

export const sampleHubspotMembers = (g: SampleGen, config: SampleConfig): RawHubspotUsersResponse => ({
  results: g.people(config.users).map((p, i) => ({
    id: g.int(100, 9999),
    email: p.email,
    firstName: p.firstName,
    lastName: p.lastName,
    ...(i === 0 ? { superAdmin: true } : { primaryRoleName: g.pick(['Sales', 'Marketing', 'Support']) }),
    roleIds: [g.int(1, 50)]
  }))
})

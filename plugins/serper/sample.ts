// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live
// collector uses. The `documents`/`users` knobs scale the history/key counts.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type {
  RawSerperApiKey,
  RawSerperDailyUsage,
  RawSerperDashboard,
  RawSerperPayment,
  RawSerperPaymentDetails
} from './main.js'

export const sampleSerperBilling = (
  g: SampleGen,
  config: SampleConfig
): { payments: RawSerperPayment[]; details: RawSerperPaymentDetails } => ({
  payments: g.repeat(Math.min(config.documents, 36), (i) => ({
    amount: g.money(40, 80).toFixed(2),
    currency: 'usd',
    date: `${g.monthsAgo(i).yearMonth}-01T00:00:00Z`,
    receiptUrl: `https://example.invalid/receipts/${g.id('rcpt')}`
  })),
  details: {
    paymentMethod: 'card',
    cardType: g.pick(['visa', 'mastercard', 'amex']),
    lastFourDigits: g.last4(),
    expiryDate: '12/2030'
  }
})

export const sampleSerperUsage = (
  g: SampleGen,
  config: SampleConfig
): { dashboard: RawSerperDashboard; daily: RawSerperDailyUsage } => ({
  dashboard: { creditBalance: g.int(5_000, 25_000), usageToday: g.int(100, 800), usageLastMonth: g.int(5_000, 18_000) },
  daily: {
    data: g.repeat(config.days, (i) => ({ start: `${g.dayString(config.days - i)}T00:00:00Z`, count: g.int(200, 900) }))
  }
})

export const sampleSerperKeys = (g: SampleGen, config: SampleConfig): { keys: RawSerperApiKey[] } => ({
  keys: g.repeat(Math.min(config.users, 6), (i) => ({
    id: String(i + 1),
    key: `${g.id('sk')}${g.id('')}`,
    name: g.pick(['production', 'staging', 'development', 'ci']),
    createdAt: g.pastDate(400),
    revokedAt: g.maybe(g.pastDate(100), 0.25) ?? null
  }))
})

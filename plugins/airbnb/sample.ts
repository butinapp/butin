// Synthetic sample GENERATORS for the demo seed — each builds a raw Airbnb payload purely from the seeded
// toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector uses.
// The `documents`/`window` knobs scale the transaction history.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { RawAirbnbSummary, RawProductTransaction, RawTaxDocument } from './main.js'

// Major-unit number → a micros (millionths) string, the wire form the collector reads back.
const micros = (major: number): string => String(Math.round(major * 1_000_000))

export const sampleAirbnbSummary = (g: SampleGen, _config: SampleConfig): RawAirbnbSummary => ({
  stats: {
    reconciledGrossEarningsTotal: [{ amountMicros: micros(g.money(8_000, 16_000)), currency: 'CAD' }],
    payoutTransactionsTotal: [{ amountMicros: micros(g.money(6_000, 12_000)), currency: 'CAD' }],
    futureTransactionsTotal: [{ amountMicros: micros(g.money(1_000, 5_000)), currency: 'CAD' }],
    reconciledServiceFeesTotal: [{ amountMicros: micros(-g.money(100, 600)), currency: 'CAD' }],
    reconciledOccupancyTaxesTotal: [{ amountMicros: micros(g.money(200, 900)), currency: 'CAD' }]
  },
  // A rolling 12-month window ending at the reference month — the monthly earnings chart.
  months: g.repeat(12, (i) => {
    const m = g.monthsAgo(11 - i)

    return { startDate: `${m.yearMonth}-01T00:00:00.000Z`, completedTotal: g.money(0, 3_000), upcomingTotal: 0 }
  })
})

export const sampleAirbnbTransactions = (g: SampleGen, config: SampleConfig): RawProductTransaction[] =>
  g.repeat(config.documents, (i) => {
    const guest = g.person(i)
    const day = g.day(g.int(1, config.window))

    return {
      token: g.id('txn'),
      startDate: day.date,
      nights: g.int(1, 7),
      guestNames: [guest.name],
      hostingName: `${g.pick(['Chalet', 'Loft', 'Cottage', 'Studio'])} ${g.pick(['sur le lac', 'en ville', 'du parc'])}`,
      productConfirmationCode: g.seqId('HM', i + 1, 8),
      currencyAmount: { nativeCurrencyAmountFormatted: { amountMicros: micros(g.money(200, 1_500)), currency: 'CAD' } },
      transactionStatus: { localizedStatus: g.pick(['Completed', 'Scheduled', 'Released']), status: 'COMPLETED' }
    }
  })

export const sampleAirbnbTaxDocuments = (g: SampleGen, config: SampleConfig): RawTaxDocument[] =>
  g.repeat(Math.min(3, Math.max(1, Math.floor(config.documents / 8))), (i) => ({
    metadata: { title: 'Canada Income Summary', taxYear: 2025 - i, regulatoryAuthority: 'ca' }
  }))

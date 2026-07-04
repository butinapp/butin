// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live
// collector uses. The `documents`/`users` knobs scale the period/author/key/member counts.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { GreptileBillingRaw, GreptileUsageRaw, RawApiKeyList, RawSearchPeople } from './main.js'

// Money is Stripe CENTS everywhere a `*Cents` field appears; dates are ISO. The first period is the open
// current period (no invoiceId → synthesized into the projected row); the rest are finalized months.
export const sampleGreptileBilling = (g: SampleGen, config: SampleConfig): GreptileBillingRaw => {
  const months = Math.max(2, Math.min(config.documents, 36))
  const periodStart = g.midnightIso(30)
  const periodEnd = g.midnightIso(0)

  const periods = g.repeat(months, (i) => {
    const start = `${g.monthsAgo(i + 1).yearMonth}-01T00:00:00.000Z`
    const end = `${g.monthsAgo(i).yearMonth}-01T00:00:00.000Z`

    if (i === 0) {
      return {
        id: `open:${start}`,
        startTime: start,
        period: { startTime: start, endTime: end, label: 'Current period', invoiceId: null },
        invoice: null
      }
    }

    const invoiceId = g.id('in')
    const seats = g.amountCents(250, 400)
    const overage = g.amountCents(50, 150)

    return {
      id: invoiceId,
      startTime: start,
      period: { startTime: start, endTime: end, label: 'Billing period', invoiceId },
      invoice: {
        periodStart: start,
        total: seats + overage,
        currency: 'usd',
        status: 'paid',
        hostedInvoiceUrl: g.url('invoice', invoiceId),
        lines: [
          { description: 'Seats', amount: seats },
          { description: 'Overage', amount: overage }
        ]
      }
    }
  })

  return {
    periods,
    sub: {
      codeReview: {
        model: 'metered',
        status: 'active',
        seatPriceCents: 3000,
        overagePriceCents: 50,
        includedReviewsPerDev: 100,
        periodStart,
        periodEnd
      }
    },
    costs: {
      codeReview: {
        totalCents: g.amountCents(300, 450),
        seatCostCents: 30_000,
        overageCostCents: g.amountCents(50, 120),
        activeDevs: g.int(5, 15),
        overageCount: g.int(80, 220)
      },
      api: { totalCents: g.amountCents(5, 25) }
    },
    flex: {
      creditBalanceCents: g.amountCents(0, 100),
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      flexUsageReviewCount: g.int(80, 220),
      projectedNetFlexUsageChargeCents: g.amountCents(50, 120)
    }
  }
}

export const sampleGreptileUsage = (g: SampleGen, config: SampleConfig): GreptileUsageRaw => {
  const days = Math.max(1, Math.min(config.days, 60))
  const periodStart = g.midnightIso(days)
  const periodEnd = g.midnightIso(0)

  return {
    daily: {
      daily: g.repeat(days, (i) => ({
        date: g.midnightIso(days - i),
        codeReview: g.int(10, 40),
        cliReview: g.int(4, 14)
      })),
      authors: g.people(config.users).map((p) => ({
        authorId: p.id,
        authorLogin: p.firstName.toLowerCase(),
        webReviewCount: g.int(80, 160),
        webFlexCount: g.int(5, 45),
        cliReviewCount: g.int(10, 40),
        cliFlexCount: g.int(0, 10),
        seatPeriods: 1
      }))
    },
    flex: {
      creditBalanceCents: g.amountCents(0, 100),
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      flexUsageReviewCount: g.int(80, 220),
      projectedNetFlexUsageChargeCents: g.amountCents(50, 120)
    }
  }
}

export const sampleGreptileKeys = (g: SampleGen, config: SampleConfig): RawApiKeyList => {
  const n = Math.min(config.documents, 36)

  return {
    items: g.repeat(n, () => ({
      id: g.id('key'),
      name: g.pick(['ci', 'production', 'local-dev', 'staging']),
      createdAt: g.pastDate(400)
    })),
    total: n
  }
}

export const sampleGreptilePeople = (g: SampleGen, config: SampleConfig): RawSearchPeople => ({
  items: g.people(config.users).map((p, i) => ({
    type: i === 0 ? 'invite' : 'member',
    email: p.email,
    role: i === 1 ? 'Admin' : 'Member'
  }))
})

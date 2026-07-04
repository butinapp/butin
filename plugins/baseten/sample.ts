// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector
// uses. Money units differ per field (cents vs dollar-strings, matching the wire). `documents` caps invoices,
// `days` the per-model usage series, `users` the roster.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { BasetenBillingRaw, BasetenKeysRaw, BasetenMembersRaw, BasetenUsageRaw } from './main.js'

// Model / instance / category labels are structural (a stable serving taxonomy, not personal data).
const MODELS = [
  { name: 'model-a', oracle: 'Model A 70B', instance: 'H100', env: 'production' },
  { name: 'model-b', oracle: 'Model B Large', instance: 'A100', env: 'staging' },
  { name: 'model-c', oracle: 'Model C v3', instance: 'L4', env: 'production' }
] as const

// Dedicated-usage days for one model: a cost dollar-string + a request count string per day.
const usageDays = (g: SampleGen, days: number) =>
  g.repeat(days, (i) => ({
    date: g.dayString(days - i),
    cost: g.moneyStr(12, 95),
    requests: String(g.int(8_000, 70_000))
  }))

// Invoices: amount is CENTS, dated by period_end (period_start ~2 months earlier). Newest first.
export const sampleBasetenBilling = (g: SampleGen, config: SampleConfig): BasetenBillingRaw => ({
  invoices: g.repeat(Math.min(config.documents, 36), (i) => {
    const end = g.monthsAgo(i)
    const start = g.monthsAgo(i + 2)

    return {
      created: `${start.yearMonth}-01T00:00:00.000Z`,
      periodStart: `${start.yearMonth}-01`,
      periodEnd: `${end.yearMonth}-01`,
      amount: g.amountCents(600_000, 900_000),
      status: 'PAID',
      pdfLink: `https://example.invalid/invoices/${g.id('inv')}.pdf`
    }
  }),
  paymentMethod: {
    brand: g.pick(['visa', 'mastercard', 'amex']),
    last4: g.last4(),
    paymentMethodTitle: 'Card',
    paymentMethodSubtitle: `•••• ${g.last4()}`
  },
  // currentNetSpend.* are DOLLAR strings.
  orgBudget: {
    organization: {
      currentNetSpend: {
        netSpendDollars: g.moneyStr(1_500, 3_000),
        creditsUsedDollars: g.moneyStr(10, 80)
      }
    }
  },
  // monetary credits are CENTS.
  credits: {
    organization: {
      creditGranted: g.amountCents(500_00, 1_500_00),
      creditBalance: g.amountCents(50_00, 400_00),
      paymentMethodStatus: 'valid'
    }
  }
})

export const sampleBasetenUsage = (g: SampleGen, config: SampleConfig): BasetenUsageRaw => {
  const days = Math.min(config.days, 28)
  const start = g.day(days)
  const end = g.day(0)

  return {
    period: { start: start.iso, end: end.iso },
    usage: {
      usageSummaryForDateRange: {
        dedicatedUsage: {
          currentPeriodTotal: g.moneyStr(1_500, 3_000),
          startDate: start.iso,
          endDate: end.iso,
          productCategoryUsages: [
            {
              category: 'MODEL_INFERENCE',
              items: MODELS.slice(0, 2).map((m) => ({
                minutes: g.int(8_000, 20_000),
                cost: g.moneyStr(700, 1_400),
                requests: String(g.int(400_000, 1_100_000)),
                entity: { name: m.name, oracle: { name: m.oracle } },
                billingEntity: { instanceType: m.instance, environmentName: m.env },
                usagePerDay: usageDays(g, days)
              }))
            },
            {
              category: 'TRANSCRIPTION',
              items: [
                {
                  minutes: g.int(2_000, 6_000),
                  cost: g.moneyStr(150, 400),
                  requests: String(g.int(100_000, 300_000)),
                  entity: { name: MODELS[2]!.name, oracle: { name: MODELS[2]!.oracle } },
                  billingEntity: { instanceType: MODELS[2]!.instance, environmentName: MODELS[2]!.env },
                  usagePerDay: usageDays(g, days)
                }
              ]
            }
          ]
        },
        trainingUsage: { minutes: String(g.int(100, 500)), cost: g.moneyStr(10, 30) }
      }
    }
  }
}

export const sampleBasetenKeys = (g: SampleGen, config: SampleConfig): BasetenKeysRaw => ({
  orgKeys: g.repeat(Math.min(config.documents, 4), (i) => ({ id: g.id('org_key'), revoked: i === 2 })),
  userKeys: [{ id: g.id('user_key'), revoked: false }]
})

export const sampleBasetenMembers = (g: SampleGen, config: SampleConfig): BasetenMembersRaw => {
  const people = g.people(config.users)

  return {
    users: people.map((p, i) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      username: p.firstName.toLowerCase(),
      roleName: i === 0 ? 'admin' : 'member',
      status: 'APPROVED'
    })),
    invited: [
      { id: g.id('invite'), email: g.person(20).email, roleName: 'member', invited: true },
      // Already a member (the first roster email) → dropped by build.
      { id: g.id('invite'), email: people[0]?.email ?? '', roleName: 'admin', invited: true }
    ]
  }
}

// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector
// uses. Billing money is Stripe CENTS and dates are epoch seconds; usage quota figures are strings. `documents`
// caps invoices, `days` the request-volume series, `users` the roster.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type {
  CerebrasBillingRaw,
  CerebrasUsageRaw,
  RawCerebrasApiKey,
  RawCerebrasMember,
  RawGraphPoint
} from './main.js'

// Model labels are structural (a stable inference catalog, not personal data).
const MODELS = [
  { id: 'model-70b', name: 'Model 70B', deprecated: false },
  { id: 'model-32b', name: 'Model 32B', deprecated: false },
  { id: 'model-legacy', name: 'Model 8B (legacy)', deprecated: true }
] as const

// Billing money is Stripe CENTS; dates are epoch seconds drawn off generated days.
export const sampleCerebrasBilling = (g: SampleGen, config: SampleConfig): CerebrasBillingRaw => {
  const recent = g.day(60)

  return {
    invoices: g.repeat(Math.min(config.documents, 36), (i) => {
      const m = g.monthsAgo(i)

      return {
        created: m.startEpochSec,
        status: 'paid',
        total: g.amountCents(60_000, 90_000),
        currency: 'usd',
        number: `CB-${m.yearMonth}`,
        hosted_invoice_url: g.url('invoices', g.id('cb')),
        invoice_pdf: g.url('invoices', `${g.id('cb')}.pdf`)
      }
    }),
    upcoming: [
      { amount: g.amountCents(25_000, 40_000), description: 'model-70b-input' },
      { amount: g.amountCents(15_000, 30_000), description: 'model-70b-output' },
      { amount: g.amountCents(5_000, 15_000), description: 'model-32b-input' }
    ],
    balance: { available: g.amountCents(100_000, 300_000), ledger: g.amountCents(400_000, 600_000) },
    customer: { balance: -g.amountCents(1_000, 8_000), email: g.person(0).email, delinquent: false, currency: 'usd' },
    grants: [
      {
        name: 'Purchased credits',
        category: 'paid',
        amount: 500_000,
        available: g.amountCents(100_000, 300_000),
        currency: 'usd',
        effective_at: recent.epochSec,
        expires_at: null
      },
      {
        name: 'Onboarding credits',
        category: 'promotional',
        amount: 50_000,
        available: 0,
        currency: 'usd',
        effective_at: recent.epochSec,
        expires_at: g.pastEpochSec(0)
      }
    ]
  }
}

// Request-volume window: a count per day, ramping with mild variation. timeWindow is an ISO timestamp.
const graph = (g: SampleGen, days: number): RawGraphPoint[] =>
  g.repeat(days, (i) => ({
    timeWindow: g.midnightIso(days - i),
    requestCount: g.int(15_000, 35_000)
  }))

// Usage quota figures are STRINGS; counts (requestCount) are numbers.
export const sampleCerebrasUsage = (g: SampleGen, config: SampleConfig): CerebrasUsageRaw => {
  const days = Math.min(config.days, 30)
  const points = graph(g, days)

  return {
    totalRequests: points.reduce((sum, p) => sum + (p.requestCount ?? 0), 0),
    graph: points,
    quotas: [
      {
        modelId: 'model-70b',
        requestsPerMinute: String(g.int(800, 1_500)),
        tokensPerMinute: String(g.int(400_000, 800_000)),
        requestsPerDay: String(g.int(80_000, 150_000)),
        maxCompletionTokens: '8192'
      },
      {
        modelId: 'model-32b',
        requestsPerMinute: String(g.int(500, 1_000)),
        tokensPerMinute: String(g.int(300_000, 500_000)),
        requestsPerDay: String(g.int(60_000, 100_000)),
        maxCompletionTokens: '16384'
      }
    ],
    models: MODELS.map((m) => ({ ...m })),
    periodStart: g.dayString(days),
    periodEnd: g.dayString(0)
  }
}

// `secretKey` is the full secret — masked to `csk-…last4` by the build.
export const sampleCerebrasKeys = (g: SampleGen, config: SampleConfig): RawCerebrasApiKey[] =>
  g.repeat(Math.min(config.documents, 36), (i) => ({
    id: g.id('key'),
    name: g.pick(['production', 'staging', 'development', 'ci']),
    secretKey: `csk-${g.id('')}${g.last4()}`,
    projectName: 'Inference',
    projectId: g.id('proj'),
    state: i === 2 ? 'DELETED' : 'ACTIVE',
    createdAt: g.midnightIso(400 - i * 30),
    lastUsedAt: i === 0 ? g.midnightIso(1) : null
  }))

export const sampleCerebrasMembers = (g: SampleGen, config: SampleConfig): RawCerebrasMember[] =>
  g.people(config.users).map((p, i) => ({
    user: { id: p.id, name: p.name, email: p.email },
    role: i === 0 ? 'ADMIN' : 'MEMBER'
  }))

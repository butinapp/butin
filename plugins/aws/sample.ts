// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector
// uses. `documents` caps the monthly-bucket count; `users` drives the Identity Center roster.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { AwsBillingRaw, CeResultByTime, IdentityUserLike } from './main.js'

// Service / account labels are structural (a stable cloud-cost taxonomy, not personal data).
const SERVICES = [
  'Amazon Elastic Compute Cloud',
  'Amazon Relational Database Service',
  'Amazon Simple Storage Service',
  'Amazon CloudFront'
] as const
const ACCOUNT_LABELS = ['production', 'staging', 'sandbox'] as const

// A monthly Cost Explorer bucket: the per-key amounts as USD dollar STRINGS (the wire unit — build parses, no /100).
const ceMonth = (start: string, groups: Array<[string, string]>): CeResultByTime => ({
  TimePeriod: { Start: start, End: start },
  Groups: groups.map(([key, amount]) => ({ Keys: [key], Metrics: { UnblendedCost: { Amount: amount, Unit: 'USD' } } }))
})

// Trailing monthly buckets (newest at i=0 is the current partial month) with spend ramping toward the present so
// the chart + MTD read true; build sorts ascending. Stable 12-digit account ids are drawn from the seed.
export const sampleAwsBilling = (g: SampleGen, config: SampleConfig): AwsBillingRaw => {
  const n = Math.max(2, Math.min(config.documents, 36))
  const accountIds = ACCOUNT_LABELS.map(() => String(g.int(100_000_000_000, 999_999_999_999)))

  const serviceResults = g.repeat(n, (i) => {
    const factor = 1 - (n - 1 - i) * 0.04

    return ceMonth(
      `${g.monthsAgo(i).yearMonth}-01`,
      SERVICES.map((svc) => [svc, (g.money(100, 900) * factor).toFixed(2)] as [string, string])
    )
  })

  const accountResults = g.repeat(n, (i) => {
    const factor = 1 - (n - 1 - i) * 0.04

    return ceMonth(
      `${g.monthsAgo(i).yearMonth}-01`,
      accountIds.map((id) => [id, (g.money(150, 1_100) * factor).toFixed(2)] as [string, string])
    )
  })

  const accountNames: Record<string, string> = {}

  accountIds.forEach((id, i) => {
    accountNames[id] = ACCOUNT_LABELS[i]!
  })

  return { serviceResults, accountResults, accountNames }
}

// IAM Identity Center users — most enabled, one disabled to exercise the suspended badge. The shared cast keeps
// the same fabricated people across services; emails are always @example.invalid.
export const sampleAwsMembers = (g: SampleGen, config: SampleConfig): IdentityUserLike[] =>
  g.people(config.users).map((p, i) => ({
    UserId: p.id,
    UserName: `${p.firstName}.${p.lastName}`.toLowerCase(),
    DisplayName: p.name,
    Emails: [{ Value: p.email, Primary: true }],
    UserStatus: i === 2 ? 'DISABLED' : 'ENABLED'
  }))

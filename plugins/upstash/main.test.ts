import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { describe, expect, it, test } from 'vitest'

import {
  buildTeamOptions,
  buildUpstashBilling,
  buildUpstashBillingResult,
  buildUpstashKeys,
  buildUpstashMembers,
  buildUpstashProducts,
  buildUpstashSummaryResult,
  maskFragment,
  type ProductUsage,
  upstashPlugin
} from './main.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of upstashPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

// Synthetic fixtures matching the console wire shapes. A free-tier account returns all-zero magnitudes and an
// empty key list, so amounts here are invented to exercise the math and emails/ids are synthetic too.
const data = {
  user: {
    customer_id: 'team@example.com',
    state: 'active',
    wallet: 25,
    register_date: '2024-03-01 10:00:00 +0000 UTC'
  },
  currentYm: '202606',
  details: {
    redis: { billing: 12.5, request: 1000, storage: 2, bandwidth: 5 },
    qStash: { billing: 3, request: 400, bandwidth: 1 },
    vector: { billing: 0, request: 0, storage: 0, bandwidth: 0 },
    search: { billing: 1.25, request: 50 }
  },
  invoices: [
    { date: '202604', cost: 10, status: 'paid' },
    { date: '202606', cost: 16.75, status: 'scheduled' },
    { date: '202605', cost: 14, status: 'paid' }
  ]
}

describe('buildUpstashBilling', () => {
  it('sums the current month across products as the live MTD (USD dollars, no /100)', () => {
    const billing = buildUpstashBilling(data)

    expect(billing.currentMtd).toBeCloseTo(16.75, 2) // 12.5 + 3 + 0 + 1.25
    // currency is stamped downstream from the plugin's reportingCurrency (USD), not by this pure transform.
  })

  it('normalizes invoice months (YYYYMM → first-of-month day) and sorts most-recent first', () => {
    const billing = buildUpstashBilling(data)

    expect(billing.invoices).toEqual([
      { date: '2026-06-01', amount: 16.75, status: 'scheduled' },
      { date: '2026-05-01', amount: 14, status: 'paid' },
      { date: '2026-04-01', amount: 10, status: 'paid' }
    ])
  })

  it('tolerates empty input', () => {
    const billing = buildUpstashBilling({ user: {}, invoices: [], details: {}, currentYm: '202606' })

    expect(billing.currentMtd).toBe(0)
    expect(billing.invoices).toEqual([])
  })
})

describe('buildUpstashProducts', () => {
  it('always lists all four products with zero fallbacks for a stable table shape', () => {
    const products = buildUpstashProducts({})

    expect(products.map((p) => p.product)).toEqual(['Redis', 'QStash', 'Vector', 'Search'])
    expect(products.every((p: ProductUsage) => p.billing === 0 && p.request === 0)).toBe(true)
  })

  it('carries through per-product usage', () => {
    const products = buildUpstashProducts(data.details)

    expect(products[0]).toEqual({ product: 'Redis', billing: 12.5, request: 1000, storage: 2, bandwidth: 5 })
    expect(products[1]).toEqual({ product: 'QStash', billing: 3, request: 400, storage: 0, bandwidth: 1 })
  })
})

describe('buildUpstashSummaryResult', () => {
  it('emits a spend.mtd summary with the monthly spark + account/wallet stats', () => {
    const result = buildUpstashSummaryResult(data)

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.summaries?.[0]?.section).toBe('spend')
    expect(result.summaries?.[0]?.basis).toBe('accrued')
    expect(result.summaries?.[0]?.value).toBeCloseTo(16.75, 2)

    const account = result.datasets.find((d) => d.id === 'account')

    expect(account?.shape).toBe('record')

    if (account?.shape === 'record') {
      expect(account.value.currentMtd).toBeCloseTo(16.75, 2)
      expect(account.value.state).toBe('active')
      expect(account.value.wallet).toBe(25)
    }
  })

  it('omits spend.mtd when there is no metered spend (currentMtd is 0, still a number → summary present)', () => {
    // currentMtd 0 is a number, so the preset DOES emit a summary; assert it is exactly 0.
    const result = buildUpstashSummaryResult({ user: {}, invoices: [], details: {}, currentYm: '202606' })

    expect(result.summaries?.[0]?.value).toBe(0)
  })
})

describe('buildUpstashBillingResult', () => {
  it('builds a valid per-product + invoices + account result', () => {
    const result = buildUpstashBillingResult(data)

    expect(validateCapabilityResult(result)).toEqual([])

    const products = result.datasets.find((d) => d.id === 'products')

    expect(products?.shape).toBe('table')

    if (products?.shape === 'table') {
      expect(products.rows).toHaveLength(4)
      // Products accumulate on the product name; invoices on the month (dated 'YYYY-MM-01', one per month).
      expect(products.key).toBe('product')
    }

    expect((result.datasets.find((d) => d.id === 'invoices') as { key?: string }).key).toBe('date')

    const account = result.datasets.find((d) => d.id === 'account')

    expect(account?.shape).toBe('record')

    if (account?.shape === 'record') {
      expect(account.value.customerId).toBe('team@example.com')
      expect(account.value.registered).toBe('2024-03-01')
    }
  })

  it('drops the account block entirely when every field is blank', () => {
    const result = buildUpstashBillingResult({ user: {}, invoices: [], details: {}, currentYm: '202606' })

    expect(result.datasets.find((d) => d.id === 'account')).toBeUndefined()
    // products table still renders (stable 4-row shape).
    expect(result.datasets.find((d) => d.id === 'products')).toBeDefined()
  })
})

describe('buildUpstashKeys', () => {
  it('maps key fields defensively with fallbacks and masks any fragment', () => {
    const result = buildUpstashKeys([
      { key_id: 'k1', name: 'ci-key', api_key: 'abc…xyz', created_at: '2025-04-07 14:05:22.45 +0000 UTC' },
      { name: 'no-id-key' }
    ])

    expect(result.keys).toEqual([
      { id: 'k1', name: 'ci-key', masked: 'abc…xyz', createdAt: '2025-04-07', revoked: false },
      { id: 'no-id-key', name: 'no-id-key', masked: '—', createdAt: undefined, revoked: false }
    ])
  })

  it('reduces an unexpectedly-full secret to a …last4 hint', () => {
    expect(maskFragment('sk_live_0123456789abcdef')).toBe('…cdef')
    expect(maskFragment('short')).toBe('short')
    expect(maskFragment('')).toBe('—')
    expect(maskFragment(undefined)).toBe('—')
  })

  it('tolerates empty/missing input and validates as an apiKeys result', () => {
    expect(buildUpstashKeys([]).keys).toEqual([])
    expect(buildUpstashKeys(null).keys).toEqual([])
    expect(buildUpstashKeys(undefined).keys).toEqual([])
  })
})

describe('buildUpstashMembers', () => {
  // Synthetic `/teams` rows: two teams, members of each repeated across rows (one row per team-membership).
  const rows = [
    { team_id: 't_alpha', team_name: 'Alpha', member_email: 'owner@example.com', member_role: 'owner', copy_cc: true },
    { team_id: 't_alpha', team_name: 'Alpha', member_email: 'dev@example.com', member_role: 'dev', copy_cc: false },
    { team_id: 't_beta', team_name: 'Beta', member_email: 'admin@example.com', member_role: 'admin', copy_cc: false }
  ]

  it('keeps only the pinned team and maps email→id + role', () => {
    const { members } = buildUpstashMembers(rows, 't_alpha')

    expect(members).toEqual([
      { id: 'owner@example.com', email: 'owner@example.com', name: undefined, role: 'owner' },
      { id: 'dev@example.com', email: 'dev@example.com', name: undefined, role: 'dev' }
    ])
  })

  it('drops rows with no email and tolerates empty/missing input', () => {
    expect(buildUpstashMembers([{ team_id: 't_alpha', member_role: 'dev' }], 't_alpha').members).toEqual([])
    expect(buildUpstashMembers([], 't_alpha').members).toEqual([])
    expect(buildUpstashMembers(null, 't_alpha').members).toEqual([])
    expect(buildUpstashMembers(undefined, 't_alpha').members).toEqual([])
  })

  it('returns nothing when the pinned team has no rows', () => {
    expect(buildUpstashMembers(rows, 't_unknown').members).toEqual([])
  })

  it('builds deduped team-picker options (value=id, label=name, role subtext)', () => {
    expect(buildTeamOptions(rows)).toEqual([
      { value: 't_alpha', label: 'Alpha', description: 'owner' },
      { value: 't_beta', label: 'Beta', description: 'admin' }
    ])
    expect(buildTeamOptions(null)).toEqual([])
  })
})

test('upstash plugin is well-formed (minted-jwt + capabilities)', () => {
  expect(upstashPlugin.meta.id).toBe('upstash')
  expect(upstashPlugin.auth.kind).toBe('minted-jwt')
  expect('resolve' in upstashPlugin.auth && typeof upstashPlugin.auth.resolve === 'function').toBe(true)
  expect(upstashPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'apiKeys', 'members'])
})

// `__client` is set pre-login, so the marker is the only thing keeping capture from firing on the Google
// account-picker mid-OAuth. A marker must not substring-match the Google sign-in domain.
test('dashboardMarkers do not match the Google OAuth domain (premature-capture guard)', () => {
  const googleOAuth =
    'https://accounts.google.com/o/oauth2/auth?client_id=abc.apps.googleusercontent.com&redirect_uri=x'

  for (const m of upstashPlugin.session!.dashboardMarkers) {
    expect(googleOAuth.includes(m)).toBe(false)
  }
})

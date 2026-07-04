import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { describe, expect, test } from 'vitest'

import {
  buildFeeRows,
  buildStripeFeesBreakdownResult,
  buildStripeFeesSummaryResult,
  currentMonthSpec,
  recentCompleteMonths,
  type StripeMonthFees,
  stripePlugin
} from './main.js'

// Core stamps the plugin's reportingCurrency onto money values at the edge; resolve it before validating so the
// build's currency-less money columns match what ships.
const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of stripePlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

// SYNTHETIC fixture mirroring the all_fees Sigma results page: a named column list + positional rows. The
// `amount` column is a decimal STRING already in major USD units (the report's native unit), with extra
// precision and currency casing exercised on purpose.
const sigma = {
  columns: [
    { name: 'suite' },
    { name: 'product' },
    { name: 'feature_name' },
    { name: 'feature_description' },
    { name: 'amount' },
    { name: 'tax' },
    { name: 'currency' }
  ],
  data: [
    {
      row: [
        'Payments',
        'Payment Processing',
        'Card payments - Stripe fee',
        'Stripe fee for card transactions.',
        '10409.010000000000000000',
        '0',
        'usd'
      ]
    },
    {
      row: [
        'Revenue management',
        'Billing',
        'Invoicing - Plus',
        'Fees for Invoicing Plus.',
        '1838.335000000000000000',
        '0',
        'usd'
      ]
    },
    {
      row: [
        'Payments',
        'Payment Processing',
        'Payments - refund fee',
        'Flat fee per refund.',
        '0.500000000000000000',
        '0',
        'USD'
      ]
    }
  ]
}

const monthFees = (key: string, label: string, total: number, fees: StripeMonthFees['fees'] = []): StripeMonthFees => ({
  key,
  label,
  startSec: 0,
  endSec: 0,
  total,
  fees
})

describe('buildFeeRows', () => {
  test('maps named columns → normalized USD fee lines (decimal string → major units)', () => {
    const rows = buildFeeRows(sigma)

    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      suite: 'Payments',
      product: 'Payment Processing',
      feature: 'Card payments - Stripe fee',
      amount: 10409.01,
      currency: 'USD'
    })
    // The over-precise '1838.335…' rounds to 2 places; lowercase currency is upcased.
    expect(rows[1].amount).toBe(1838.34)
    expect(rows[2].currency).toBe('USD')
  })

  test('tolerates a reordered column list (reads by name, not position)', () => {
    const reordered = {
      columns: [
        { name: 'amount' },
        { name: 'currency' },
        { name: 'feature_name' },
        { name: 'product' },
        { name: 'suite' }
      ],
      data: [{ row: ['42.00', 'usd', 'Sigma - monthly fee', 'Sigma and Data Pipeline', 'Revenue management'] }]
    }
    const [fee] = buildFeeRows(reordered)

    expect(fee).toEqual({
      suite: 'Revenue management',
      product: 'Sigma and Data Pipeline',
      feature: 'Sigma - monthly fee',
      amount: 42,
      currency: 'USD'
    })
  })

  test('empty / nullish input yields no rows', () => {
    for (const input of [{ columns: [], data: [] }, null, undefined]) {
      expect(buildFeeRows(input)).toEqual([])
    }
  })
})

describe('recentCompleteMonths', () => {
  test('returns the n complete months ending at the month before now, ascending', () => {
    const specs = recentCompleteMonths(3, new Date(Date.UTC(2026, 5, 17))) // June 2026 → last complete is May

    expect(specs.map((s) => s.key)).toEqual(['2026-03', '2026-04', '2026-05'])
    expect(specs.at(-1)?.label).toBe('May 2026')
    // The interval is [month-start, next-month-start) in epoch seconds.
    expect(specs.at(-1)?.startSec).toBe(Math.floor(Date.UTC(2026, 4, 1) / 1000))
    expect(specs.at(-1)?.endSec).toBe(Math.floor(Date.UTC(2026, 5, 1) / 1000))
  })

  test('crosses the year boundary correctly', () => {
    const specs = recentCompleteMonths(2, new Date(Date.UTC(2026, 0, 10))) // January 2026 → Nov, Dec 2025

    expect(specs.map((s) => s.key)).toEqual(['2025-11', '2025-12'])
  })
})

describe('currentMonthSpec', () => {
  test('spans [month-start, now) so the report returns month-to-date fees', () => {
    const now = new Date(Date.UTC(2026, 5, 17, 12, 0, 0)) // June 17 2026, midday
    const spec = currentMonthSpec(now)

    expect(spec.key).toBe('2026-06')
    expect(spec.label).toBe('June 2026')
    expect(spec.startSec).toBe(Math.floor(Date.UTC(2026, 5, 1) / 1000))
    expect(spec.endSec).toBe(Math.floor(now.getTime() / 1000)) // now, NOT the month end
  })
})

describe('buildStripeFeesSummaryResult', () => {
  const completeMonths = [
    monthFees('2026-03', 'March 2026', 9000),
    monthFees('2026-04', 'April 2026', 11000),
    monthFees('2026-05', 'May 2026', 12500)
  ]
  // The current month so far (MTD) — its fees are the breakdown source + the Largest-fee card.
  const current = monthFees('2026-06', 'June 2026', 12247.85, buildFeeRows(sigma))

  test('headline = this month-to-date fees, with a spend.mtd summary on an accrued basis', () => {
    const result = buildStripeFeesSummaryResult(completeMonths, current)

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.summaries?.[0]?.section).toBe('spend')
    expect(result.summaries?.[0]?.role).toBe('money')
    expect(result.summaries?.[0]?.value).toBe(12247.85) // current MTD, not the last complete month
    expect(result.summaries?.[0]?.basis).toBe('accrued')

    const account = result.datasets.find((d) => d.id === 'account')

    if (account?.shape === 'record') {
      expect(account.value.currentMtd).toBe(12247.85)
      // The last complete month is a neutral comparison card; the largest current fee is its own card.
      expect(account.value.lastMonth).toBe(12500)
      expect(account.value.topFee).toBe(10409.01)
    }
  })

  test('the monthly-fees chart carries one point per COMPLETE month (the partial current month is not a bar)', () => {
    const result = buildStripeFeesSummaryResult(completeMonths, current)
    const monthly = result.datasets.find((d) => d.id === 'monthly')

    expect(monthly?.shape === 'table' && monthly.rows).toHaveLength(3)
  })

  test('tolerates an empty window (zeroed headline, no crash)', () => {
    const result = buildStripeFeesSummaryResult([], undefined)

    expect(validateCapabilityResult(result)).toEqual([])
    expect(result.summaries?.[0]?.value).toBe(0)
  })
})

describe('buildStripeFeesBreakdownResult', () => {
  test('builds a fee table sorted largest-first, titled with the month', () => {
    const result = buildStripeFeesBreakdownResult(monthFees('2026-05', 'May 2026', 12247.85, buildFeeRows(sigma)))

    expect(validateCapabilityResult(result)).toEqual([])

    const fees = result.datasets.find((d) => d.id === 'fees')

    if (fees?.shape === 'table') {
      expect(fees.rows.map((r) => r.amount)).toEqual([10409.01, 1838.34, 0.5])
      expect(fees.rows[0].feature).toBe('Card payments - Stripe fee')
    }

    const view = result.views?.find((v) => v.type === 'table')

    expect(view?.type === 'table' && view.title).toBe('Fees — May 2026')
  })

  test('tolerates an absent month', () => {
    const result = buildStripeFeesBreakdownResult(undefined)

    expect(validateCapabilityResult(result)).toEqual([])
    const fees = result.datasets.find((d) => d.id === 'fees')

    expect(fees?.shape === 'table' && fees.rows).toEqual([])
  })
})

test('stripe plugin descriptor is well-formed (minted-jwt: cookie → uk_ session key Bearer)', () => {
  expect(stripePlugin.meta.id).toBe('stripe')
  expect(stripePlugin.auth.kind).toBe('minted-jwt')
  expect(stripePlugin.transport?.baseUrl).toBe('https://dashboard.stripe.com')
  expect(stripePlugin.session?.loginUrl).toBe('https://dashboard.stripe.com/login')
  // Scoped to the queried host (not the stripe.com suffix) so sibling subdomains' host-locked __Host- cookies
  // don't flatten into conflicting duplicates in the replayed jar.
  expect(stripePlugin.session?.cookieDomains).toEqual(['dashboard.stripe.com'])
  // Finicky SPA + no named requiredCookie yet → manual capture only, so a partial jar isn't auto-grabbed.
  expect(stripePlugin.session?.manualCaptureOnly).toBe(true)
  // Stripe's Fetch-Metadata CSRF gate requires native headers — the capture window must not rewrite them.
  expect(stripePlugin.transport?.nativeBrowserHeaders).toBe(true)
  // The marker must not be '/dashboard' — that substring matches the login host (dashboard.stripe.com/login).
  expect(stripePlugin.session?.dashboardMarkers).not.toContain('/dashboard')
  expect(stripePlugin.session?.dashboardMarkers).toContain('/acct_')
  expect(stripePlugin.session?.captureFromUrl).toContainEqual({ pattern: '/(acct_[A-Za-z0-9]+)', storeAs: 'accountId' })
  expect(stripePlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'fees'])
  // No pasted secret — auth is the cookie-minted uk_ session key.
  expect(stripePlugin.config?.fields.some((f) => f.key === 'apiKey')).toBe(false)
})

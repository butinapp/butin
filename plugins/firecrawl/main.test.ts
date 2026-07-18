import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { currentMonthKey } from '@butinapp/sdk/util'
import { expect, test } from 'vitest'

import {
  buildFirecrawlBilling,
  buildFirecrawlBillingResult,
  buildFirecrawlKeys,
  firecrawlPlugin,
  maskKey
} from './main.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of firecrawlPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

// Synthetic fixtures in Firecrawl's dashboard JSON shape (Stripe invoices in CENTS, `created` in unix
// seconds; /api/user/team's apiKeys carry full secrets), with invented ids / keys / amounts. No real values.

const TEAM = {
  teamId: 'team-synthetic',
  apiKey: 'fc-aaaa1111bbbb2222cccc3333dddd4444',
  apiKeys: [
    { id: 1383670, name: 'desk', key: 'fc-aaaa1111bbbb2222cccc3333dddd4444' },
    { id: 810043, name: 'ci', key: 'fc-eeee5555ffff6666gggg7777hhhh8888' },
    { id: 7958, name: 'Default', key: 'fc-iiii9999jjjj0000kkkk1111llll2222' }
  ]
}

const INVOICES = [
  {
    id: 'in_new',
    created: 1776559246, // 2026-04-19 (UTC)
    total: 684000, // $6,840.00
    amount_due: 684000,
    amount_paid: 684000,
    status: 'paid',
    billing_reason: 'subscription_cycle',
    number: 'AAAA0001-0027',
    currency: 'usd',
    hosted_invoice_url: 'https://invoice.stripe.example/i/1',
    invoice_pdf: 'https://invoice.stripe.example/i/1/pdf',
    charge: { payment_method_details: { type: 'link' } },
    lines: {
      data: [
        {
          description: '1 × Scale Tier (at $6,840.00 / every 3 months)',
          amount: 684000,
          plan: { nickname: 'Scale, Quarterly' }
        },
        { description: '1 × Concurrency (at $0.00 / every 3 months)', amount: 0, plan: null }
      ]
    }
  },
  {
    id: 'in_old',
    created: 1744416662, // 2025-04-12 (UTC)
    total: 9900, // $99.00
    amount_paid: 9900,
    status: 'paid',
    billing_reason: 'subscription_create',
    number: 'AAAA0001-0007',
    currency: 'usd',
    hosted_invoice_url: 'https://invoice.stripe.example/i/2',
    invoice_pdf: 'https://invoice.stripe.example/i/2/pdf',
    charge: { payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } } },
    lines: { data: [{ description: 'Standard', amount: 9900, price: { nickname: 'Standard Monthly' } }] }
  }
]

test('maskKey reduces secrets to an fc-…last4 hint', () => {
  expect(maskKey('fc-aaaa1111bbbb2222cccc3333dddd4444')).toBe('fc-…4444')
  expect(maskKey('sk_live_synthetic9999')).toBe('…9999')
  expect(maskKey('')).toBe('—')
  expect(maskKey(undefined)).toBe('—')
})

test('buildFirecrawlKeys masks every key and never surfaces a usable secret', () => {
  const { keys } = buildFirecrawlKeys(TEAM)

  expect(keys).toEqual([
    { id: '1383670', name: 'desk', masked: 'fc-…4444' },
    { id: '810043', name: 'ci', masked: 'fc-…8888' },
    { id: '7958', name: 'Default', masked: 'fc-…2222' }
  ])

  // No masked hint leaks the full secret.
  for (const k of keys) {
    expect(k.masked).not.toContain('aaaa1111')
    expect(k.masked?.length).toBeLessThanOrEqual('fc-…0000'.length)
  }
})

test('buildFirecrawlKeys tolerates empty / missing input', () => {
  expect(buildFirecrawlKeys(undefined).keys).toEqual([])
  expect(buildFirecrawlKeys(null).keys).toEqual([])
  expect(buildFirecrawlKeys({}).keys).toEqual([])
  expect(buildFirecrawlKeys({ apiKeys: [{ id: 1 }] }).keys[0]).toEqual({ id: '1', name: '(unnamed)', masked: '—' })
})

test('buildFirecrawlBilling normalizes cents → dollars, newest-first, with plan + payment method', () => {
  const billing = buildFirecrawlBilling(INVOICES)

  expect(billing.invoices.map((i) => ({ date: i.date, amount: i.amount, number: i.number }))).toEqual([
    { date: '2026-04-19', amount: 6840, number: 'AAAA0001-0027' },
    { date: '2025-04-12', amount: 99, number: 'AAAA0001-0007' }
  ])
  // 684000 / 100 === 6840 dollars (cents unit), 9900 / 100 === 99.
  expect(billing.invoices[0]?.amount).toBe(6840)
  expect(billing.invoices[1]?.amount).toBe(99)
  // Plan + payment method come from the newest invoice; currency uppercased.
  expect(billing.plan).toBe('Scale, Quarterly')
  expect(billing.paymentMethod).toBe('link')
  expect(billing.currency).toBe('USD')
})

test('buildFirecrawlBilling renders a card payment method as "brand •••• last4"', () => {
  // Only the card invoice → it becomes the newest.
  const billing = buildFirecrawlBilling([INVOICES[1]!])

  expect(billing.paymentMethod).toBe('visa •••• 4242')
})

test('buildFirecrawlBilling computes current-month MTD by structure (date-independent)', () => {
  const ym = currentMonthKey()
  const thisMonthDay = `${ym}-15`
  const seconds = Math.floor(new Date(`${thisMonthDay}T00:00:00.000Z`).getTime() / 1000)

  const billing = buildFirecrawlBilling([
    { created: seconds, total: 5000, status: 'paid', currency: 'usd' }, // $50 this month
    ...INVOICES // older months
  ])

  // currentMtd is the sum of this-month invoices only (the older fixtures fall outside the current month).
  expect(billing.currentMtd).toBe(50)
})

test('buildFirecrawlBilling tolerates empty / missing input', () => {
  for (const empty of [[], undefined, null]) {
    const billing = buildFirecrawlBilling(empty)

    expect(billing.invoices).toEqual([])
    expect(billing.currentMtd).toBe(0)
    expect(billing.plan).toBeUndefined()
    expect(billing.paymentMethod).toBeUndefined()
    expect(billing.currency).toBe('USD')
  }
})

test('buildFirecrawlBillingResult keys the invoice table by the Stripe invoice id', () => {
  const result = buildFirecrawlBillingResult(INVOICES)
  const invoices = result.datasets.find((d) => d.id === 'invoices')

  // The Stripe invoice id rides hidden as the accumulation key (number is nullable).
  expect(invoices?.shape === 'table' && invoices.key).toBe('id')
  expect(invoices?.shape === 'table' && invoices.rows[0]?.id).toBe('in_new')
})

test('firecrawl plugin is well-formed', () => {
  expect(firecrawlPlugin.meta.id).toBe('firecrawl')
  expect(firecrawlPlugin.auth.kind).toBe('cookie')
  expect(firecrawlPlugin.capabilities.map((c) => c.id)).toEqual(['billing', 'apiKeys'])
})

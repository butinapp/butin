import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { expect, test } from 'vitest'

import {
  buildUnleashBilling,
  buildUnleashBillingTab,
  buildUnleashKeys,
  buildUnleashMembers,
  buildUnleashSummaryResult,
  computeRecurringFee,
  maskSecret,
  parseDollarAmount,
  unleashPlugin
} from './main.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

// All fixtures below are SYNTHETIC — invented shapes that mirror the wire format, no real account data,
// no real token secrets (the hashes are placeholder runs of a single character).

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of unleashPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

// ── descriptor ──────────────────────────────────────────────────────────────────────

test('unleash replays the SSO dashboard cookie verbatim on plain node transport', () => {
  expect(unleashPlugin.auth.kind).toBe('cookie')
  expect(unleashPlugin.transport?.engine).toBe('node')
  expect(unleashPlugin.transport?.requiresBrowserEngine).toBeUndefined()
  // Scoped to *.app.unleash-hosted.com so the analytics cookies on .unleash-hosted.com don't bloat the jar.
  expect(unleashPlugin.session?.cookieDomains).toContain('app.unleash-hosted.com')
  expect(unleashPlugin.session?.requiredCookie).toBe('unleash-auth')
})

test('unleash auto-captures the instance slug from the dashboard URL and exposes a Settings override', () => {
  // The control-plane API is scoped under the instance slug; the slug is captured off the settled URL into
  // the `instance` credential and overridable via the same-named config field.
  const cap = unleashPlugin.session?.captureFromUrl?.find((c) => c.storeAs === 'instance')

  expect(cap).toBeDefined()
  expect(new RegExp(cap!.pattern).exec('https://us.app.unleash-hosted.com/acme/personal')?.[1]).toBe('acme')
  expect(unleashPlugin.config?.fields.some((f) => f.key === 'instance')).toBe(true)
})

// ── billing: parseDollarAmount ────────────────────────────────────────────────────

test('parseDollarAmount reads the dollar value out of the pre-formatted string', () => {
  expect(parseDollarAmount('US $464.00')).toBe(464)
  expect(parseDollarAmount('US $3,232.00')).toBe(3232)
  expect(parseDollarAmount('US $1,234,567.89')).toBeCloseTo(1234567.89, 2)
})

test('parseDollarAmount returns 0 for missing/unparseable input', () => {
  expect(parseDollarAmount(undefined)).toBe(0)
  expect(parseDollarAmount('n/a')).toBe(0)
})

// ── billing: computeRecurringFee ─────────────────────────────────────────────────────

const prices = { pro: { base: 90, seat: 17, traffic: 5 }, payg: { seat: 75, traffic: 5 } }
const status = {
  plan: 'Pro',
  billing: 'subscription',
  seats: 26,
  minSeats: 5,
  state: 'ACTIVE',
  automaticallyPayForTraffic: true
}

test('computeRecurringFee is base + per-seat over the included minSeats', () => {
  expect(computeRecurringFee(prices, status)).toBe(447) // 90 + (26 − 5) × 17
})

test('computeRecurringFee treats a missing minSeats as zero included seats', () => {
  expect(computeRecurringFee(prices, { seats: 10 })).toBe(90 + 10 * 17)
})

test('computeRecurringFee never drops below base when seats are within the included count', () => {
  expect(computeRecurringFee(prices, { seats: 3, minSeats: 5 })).toBe(90)
})

test('computeRecurringFee returns null when prices or seats are unavailable', () => {
  expect(computeRecurringFee(null, status)).toBeNull()
  expect(computeRecurringFee(prices, null)).toBeNull()
  expect(computeRecurringFee({ pro: { base: 90 } }, status)).toBeNull() // no seat rate
})

// ── billing: buildUnleashBilling ─────────────────────────────────────────────────────

const invoices = {
  invoices: [
    {
      amountFormatted: 'US $464.00',
      paid: true,
      created: '2026-05-24T19:58:31.000Z',
      status: 'paid',
      invoiceURL: 'https://invoice.example.com/i/1',
      invoicePDF: 'https://pay.example.com/i/1/pdf'
    },
    {
      amountFormatted: 'US $3,232.00',
      paid: true,
      created: '2025-08-24T19:56:12.000Z',
      status: 'paid',
      invoiceURL: 'https://invoice.example.com/i/2'
    },
    { amountFormatted: 'US $685.00', paid: false, created: '2026-03-24T19:56:27.000Z', status: 'open' }
  ]
}
const adminStats = { users: 26, licensedUsers: 37, activeUsers: { last7: 8, last30: 19, last60: 23, last90: 32 } }

test('buildUnleashBilling parses amounts, sorts newest-first, sums totalBilled, keeps formatted text', () => {
  const b = buildUnleashBilling(invoices, prices, status, adminStats)

  expect(b.invoices.map((i) => i.date)).toEqual(['2026-05-24', '2026-03-24', '2025-08-24'])
  expect(b.invoices[0]).toEqual({
    date: '2026-05-24',
    amount: 464,
    amountFormatted: 'US $464.00',
    status: 'paid',
    paid: true,
    hostedUrl: 'https://invoice.example.com/i/1',
    pdfUrl: 'https://pay.example.com/i/1/pdf'
  })
  expect(b.totalBilled).toBeCloseTo(4381, 2)
})

test('buildUnleashBilling sets currentMtd to the recurring subscription fee (USD dollars, not cents)', () => {
  expect(buildUnleashBilling(invoices, prices, status, adminStats).currentMtd).toBe(447)
})

test('buildUnleashBilling builds the subscription summary from status + admin stats', () => {
  const b = buildUnleashBilling(invoices, prices, status, adminStats)

  expect(b.subscription).toEqual({
    plan: 'Pro',
    billingMode: 'subscription',
    state: 'ACTIVE',
    seats: 26,
    minSeats: 5,
    licensedUsers: 37,
    activeUsers30d: 19,
    automaticallyPayForTraffic: true,
    recurringFee: 447
  })
})

test('buildUnleashBilling degrades gracefully without status/stats → no subscription, no MTD', () => {
  const b = buildUnleashBilling(invoices, prices)

  expect(b.subscription).toBeNull()
  expect(b.currentMtd).toBeNull()
})

test('buildUnleashBilling tolerates empty/missing input', () => {
  const b = buildUnleashBilling(null)

  expect(b.invoices).toEqual([])
  expect(b.totalBilled).toBe(0)
  expect(b.currentMtd).toBeNull()
  expect(b.subscription).toBeNull()
})

// ── Summary tab (the lean overview the Overview rolls up) ─────────────────────────────

test('buildUnleashSummaryResult is lean: spend.mtd summary + monthly spark, no detail tables', () => {
  const result = buildUnleashSummaryResult(buildUnleashBilling(invoices, prices, status, adminStats))

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries?.[0]?.section).toBe('spend')
  expect(result.summaries?.[0]?.value).toBe(447)
  expect(result.summaries?.[0]?.basis).toBe('flat')
  // The summary's spark binds to the monthly-spend series.
  expect(result.datasets.some((d) => d.shape === 'table' && d.id === 'monthly')).toBe(true)
  // Lean: no Billing-detail datasets bleed onto the Summary tab.
  expect(result.datasets.some((d) => d.id === 'subscription')).toBe(false)
  expect(result.datasets.some((d) => d.id === 'invoices')).toBe(false)
})

test('buildUnleashSummaryResult emits no spend.mtd summary when currentMtd is null', () => {
  const result = buildUnleashSummaryResult(buildUnleashBilling(invoices, null))

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries).toBeUndefined()
})

// ── Billing tab (the financial detail) ────────────────────────────────────────────────

test('buildUnleashBillingTab emits the subscription record + invoice list, no spend.mtd summary', () => {
  const result = buildUnleashBillingTab(buildUnleashBilling(invoices, prices, status, adminStats))

  expect(validateCapabilityResult(result)).toEqual([])
  // No rollup on the detail tab — the spend.mtd headline + chart belong to Summary.
  expect(result.summaries).toBeUndefined()
  // The detail datasets: the subscription account record + the invoice list.
  const subscription = result.datasets.find((d) => d.id === 'subscription' && d.shape === 'record')

  expect(subscription).toBeDefined()
  expect(subscription?.shape === 'record' && subscription.value.recurringFee).toBe(447)
  expect(result.datasets.some((d) => d.id === 'invoices' && d.shape === 'table')).toBe(true)
})

test('buildUnleashBillingTab downloads invoices as PDFs when a PDF URL exists', () => {
  const result = buildUnleashBillingTab(buildUnleashBilling(invoices, prices, status, adminStats))
  const invoiceView = result.views?.find((v) => v.type === 'table' && v.dataset === 'invoices')

  // The first synthetic invoice carries an invoicePDF → the list is a fileTable sourced off the PDF column.
  expect(invoiceView?.type === 'table' && invoiceView.files?.source).toEqual({ url: 'pdfUrl' })
  expect(invoiceView?.type === 'table' && invoiceView.files?.ext).toBe('pdf')
})

test('buildUnleashBillingTab degrades to a plain invoice table when no PDF URL exists', () => {
  const noPdf = {
    invoices: [
      {
        amountFormatted: 'US $464.00',
        paid: true,
        created: '2026-05-24T00:00:00Z',
        status: 'paid',
        invoiceURL: 'https://invoice.example.com/i/1'
      }
    ]
  }
  const result = buildUnleashBillingTab(buildUnleashBilling(noPdf, prices, status, adminStats))
  const invoiceView = result.views?.find((v) => v.type === 'table' && v.dataset === 'invoices')

  expect(validateCapabilityResult(result)).toEqual([])
  // No PDF → no file download; the hosted-URL column is the only link out.
  expect(invoiceView?.type === 'table' && invoiceView.files).toBeUndefined()
})

test('buildUnleashBillingTab drops the subscription section when status is unavailable', () => {
  const result = buildUnleashBillingTab(buildUnleashBilling(invoices, null))

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.datasets.some((d) => d.id === 'subscription')).toBe(false)
  // The invoice list still renders.
  expect(result.datasets.some((d) => d.id === 'invoices')).toBe(true)
})

// ── apiKeys: maskSecret ──────────────────────────────────────────────────────────────

test('maskSecret keeps the project:env prefix + last 4 of the hash, masking the middle', () => {
  expect(maskSecret('cdm:development.aaaaaaaaaaaa5f2e')).toBe('cdm:development.****5f2e')
  expect(maskSecret('app:production.bbbbbbbbbbbb750f')).toBe('app:production.****750f')
})

test('maskSecret masks a dotless secret and handles empty input', () => {
  expect(maskSecret('abcdef1234')).toBe('****1234')
  expect(maskSecret('abc')).toBe('****')
  expect(maskSecret(undefined)).toBe('—')
})

// ── apiKeys: buildUnleashKeys ────────────────────────────────────────────────────────

const tokens = {
  tokens: [
    {
      secret: 'cdm:development.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5f2e',
      tokenName: 'cdm-dev',
      type: 'client',
      project: 'cdm',
      projects: ['cdm'],
      environment: 'development',
      expiresAt: null,
      createdAt: '2022-01-13T17:19:53.949Z',
      alias: null,
      seenAt: '2026-06-10T20:16:53.053Z'
    },
    {
      secret: 'app:production.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb750f',
      tokenName: 'frontend-prod',
      type: 'frontend',
      project: 'app',
      projects: ['app', 'frontend'],
      environment: 'production',
      expiresAt: null,
      createdAt: '2026-01-22T19:19:50.025Z',
      alias: null,
      seenAt: null
    }
  ]
}

test('buildUnleashKeys masks secrets, carries type/scope in the name, maps created/last-used dates', () => {
  const result = buildUnleashKeys(tokens)

  expect(result.keys).toHaveLength(2)
  expect(result.keys[0].masked).toBe('cdm:development.****5f2e')
  expect(result.keys[0].name).toBe('cdm-dev · client (cdm/development)')
  expect(result.keys[0].createdAt).toBe('2022-01-13T17:19:53.949Z')
  expect(result.keys[0].lastUsedAt).toBe('2026-06-10T20:16:53.053Z')
  expect(result.keys[1].name).toBe('frontend-prod · frontend (app,frontend/production)')
  // Never-used token → no last-used.
  expect(result.keys[1].lastUsedAt).toBeUndefined()
})

test('buildUnleashKeys never leaks a raw secret', () => {
  const result = buildUnleashKeys(tokens)

  for (const k of result.keys) {
    expect(k.masked).not.toContain('aaaa')
    expect(k.masked).not.toContain('bbbb')
    expect(k.masked).toContain('****')
  }
})

test('buildUnleashKeys flags an expired token as revoked', () => {
  const expired = {
    tokens: [
      {
        secret: 'p:env.cccc0001',
        tokenName: 'old',
        type: 'client',
        environment: 'env',
        expiresAt: '2000-01-01T00:00:00Z'
      }
    ]
  }

  expect(buildUnleashKeys(expired).keys[0].revoked).toBe(true)
})

test('buildUnleashKeys tolerates empty input', () => {
  expect(buildUnleashKeys({}).keys).toEqual([])
  expect(buildUnleashKeys(null).keys).toEqual([])
})

// ── members: buildUnleashMembers ──────────────────────────────────────────────────────

// SYNTHETIC roster — invented users, no real names/emails/ids.
const roster = {
  users: [
    { id: 1, name: 'Ada Placeholder', email: 'ada@example.com', rootRole: 1 },
    { id: 2, username: 'sample-editor', email: 'editor@example.com', rootRole: 2 },
    { id: 3, name: 'View Only', email: 'viewer@example.com', rootRole: 3 }
  ]
}

test('buildUnleashMembers maps id/name/email + resolves the numeric rootRole to its label', () => {
  const result = buildUnleashMembers(roster)

  expect(result.members).toEqual([
    { id: '1', name: 'Ada Placeholder', email: 'ada@example.com', role: 'Admin' },
    { id: '2', name: 'sample-editor', email: 'editor@example.com', role: 'Editor' },
    { id: '3', name: 'View Only', email: 'viewer@example.com', role: 'Viewer' }
  ])
})

test('buildUnleashMembers prefers a human rootRoleName and falls back to "Role <id>" for custom roles', () => {
  const result = buildUnleashMembers({
    users: [
      { id: 9, email: 'named@example.com', rootRole: 2, rootRoleName: 'Owner' },
      { id: 10, email: 'custom@example.com', rootRole: 42 }
    ]
  })

  expect(result.members[0].role).toBe('Owner')
  expect(result.members[1].role).toBe('Role 42')
})

test('buildUnleashMembers falls back to the index when an id is missing and omits an absent role', () => {
  const result = buildUnleashMembers({ users: [{ email: 'noid@example.com' }] })

  expect(result.members[0].id).toBe('0')
  expect(result.members[0].role).toBeUndefined()
})

test('buildUnleashMembers tolerates empty/missing input', () => {
  expect(buildUnleashMembers({}).members).toEqual([])
  expect(buildUnleashMembers(null).members).toEqual([])
})

test('unleash descriptor leads with Summary then Billing, then apiKeys + members', () => {
  expect(unleashPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'apiKeys', 'members'])

  const summary = unleashPlugin.capabilities.find((c) => c.id === 'summary')

  expect(summary?.label).toBe('Summary')
  expect(unleashPlugin.capabilities.find((c) => c.id === 'members')?.label).toBe('Members')
})

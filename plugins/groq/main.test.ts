import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { billing, keys, members } from '@butinapp/sdk/presets'
import { expect, test } from 'vitest'

import {
  buildGroqAccount,
  buildGroqBilling,
  buildGroqBillingResult,
  buildGroqKeys,
  buildGroqMembers,
  buildGroqSummaryResult,
  buildGroqUsage,
  buildGroqUsageResult,
  cookieValue,
  extractGroqPlan,
  groqPlugin,
  jwtSecondsLeft
} from './main.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

const makeJwt = (exp: number): string => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of groqPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

// --- auth helpers ---

// A dead-but-present Stytch session still loads the console SPA, so a reconnect must drop the pair
// before capture or it re-grabs the dead session before sign-in.
test('groq clears the Stytch session pair before capture', () => {
  expect(groqPlugin.session?.clearCookiesBeforeCapture).toEqual(['stytch_session', 'stytch_session_jwt'])
})

// No org-list endpoint and no org id in the URL — the org id is auto-captured from the SPA's
// Groq-Organization request header, so the config field is an optional override.
test('groq auto-captures the org id from the Groq-Organization request header', () => {
  expect(groqPlugin.session?.captureFromHeader).toContainEqual({
    header: 'Groq-Organization',
    storeAs: 'orgId',
    on: 'request'
  })
  expect(groqPlugin.config?.fields.find((f) => f.key === 'orgId')?.required).toBeFalsy()
})

test('cookieValue extracts a named cookie from a Cookie header', () => {
  expect(cookieValue('a=1; stytch_session_jwt=ey.j.wt; b=2', 'stytch_session_jwt')).toBe('ey.j.wt')
  expect(cookieValue('a=1', 'missing')).toBeUndefined()
})

test('jwtSecondsLeft reads exp; future is positive, past is negative, junk is 0', () => {
  const now = Math.floor(Date.now() / 1000)

  expect(jwtSecondsLeft(makeJwt(now + 300))).toBeGreaterThan(60)
  expect(jwtSecondsLeft(makeJwt(now - 10))).toBeLessThan(0)
  expect(jwtSecondsLeft('not-a-jwt')).toBe(0)
})

// --- billing ---

test('billing converts invoice cents→USD, ms→date, newest first; current is the MTD', () => {
  const r = buildGroqBilling(
    {
      data: [
        {
          id: 'a',
          created_at: Date.UTC(2026, 3, 10),
          total_amount_cents: 2500,
          payment_status: 'succeeded',
          file_url: 'https://x/a.pdf'
        },
        { id: 'b', created_at: Date.UTC(2026, 4, 12), total_amount_cents: 1999, status: 'finalized' }
      ]
    },
    { total_amount_cents: 777, currency: 'usd' }
  )

  expect(r.currentMtd).toBe(7.77)
  expect(r.currency).toBe('USD')
  expect(r.invoices[0]).toMatchObject({ date: '2026-05-12', amount: 19.99, status: 'finalized', pdfUrl: null })
  expect(r.invoices[1]).toMatchObject({
    date: '2026-04-10',
    amount: 25,
    status: 'succeeded',
    pdfUrl: 'https://x/a.pdf'
  })
})

test('billing tolerates empty responses and maps to a valid result', () => {
  const r = buildGroqBilling({}, {})

  expect(r).toMatchObject({ currentMtd: 0, invoices: [] })
  expect(validateCapabilityResult(billing.result(r))).toEqual([])
})

// --- usage ---

test('usage aggregates activity rows per model (requests + tokens + dollar cost), costliest first', () => {
  const r = buildGroqUsage(
    {
      data: [
        {
          model: 'llama-70b',
          timestamp: 1780358400,
          num_requests: 10,
          n_context_tokens_total: 100,
          n_generated_tokens_total: 40,
          cost: 1.5
        },
        {
          model: 'llama-70b',
          timestamp: 1780444800,
          num_requests: 5,
          n_context_tokens_total: 50,
          n_generated_tokens_total: 20,
          cost: 0.5
        },
        { model: 'whisper', timestamp: 1780358400, num_requests: 2, cost: 3.25 }
      ]
    },
    { from_datetime: '2026-06-01T00:00:00Z', to_datetime: '2026-06-13T00:00:00Z' }
  )

  expect(r.periodStart).toBe('2026-06-01')
  expect(r.periodEnd).toBe('2026-06-13')
  expect({
    requests: r.totalRequests,
    input: r.totalInputTokens,
    output: r.totalOutputTokens,
    cost: r.totalCost
  }).toEqual({
    requests: 17,
    input: 150,
    output: 60,
    cost: 5.25
  })
  expect(r.models[0]).toEqual({ model: 'whisper', requests: 2, inputTokens: 0, outputTokens: 0, cost: 3.25 })
  expect(r.models[1]).toEqual({ model: 'llama-70b', requests: 15, inputTokens: 150, outputTokens: 60, cost: 2 })
  // Two distinct activity days, ascending, cost summed per day.
  expect(r.daily).toEqual([
    { date: '2026-06-02', cost: 4.75 },
    { date: '2026-06-03', cost: 0.5 }
  ])
})

test('usage result headlines spend as usage.primary with a daily spark; empty activity → no summary', () => {
  const result = buildGroqUsageResult(
    buildGroqUsage({ data: [{ model: 'm', timestamp: 1780358400, num_requests: 1, cost: 4 }] }, {})
  )

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries?.[0]).toMatchObject({
    section: 'other',
    value: 4,
    role: 'money',
    spark: { dataset: 'daily', x: 'date', y: 'cost' }
  })
  expect(buildGroqUsageResult(buildGroqUsage({}, {})).summaries).toBeUndefined()
})

// --- apiKeys ---

test('apiKeys maps pre-masked secret, ms→date; never-used last_use degrades to undefined', () => {
  const r = buildGroqKeys({
    data: [
      {
        id: 'k1',
        name: 'prod',
        secret_key: 'gsk_****abcd',
        created: Date.UTC(2026, 0, 2),
        last_use: Date.UTC(2026, 2, 4)
      },
      { id: 'k2', secret_key: 'gsk_****wxyz', created: Date.UTC(2026, 1, 1), last_use: 0 }
    ]
  })

  expect(r.keys[0]).toMatchObject({
    name: 'prod',
    masked: 'gsk_****abcd',
    createdAt: '2026-01-02',
    lastUsedAt: '2026-03-04'
  })
  expect(r.keys[1]).toMatchObject({ name: '(unnamed)', createdAt: '2026-02-01' })
  expect(r.keys[1].lastUsedAt).toBeUndefined()
  expect(validateCapabilityResult(keys.result(buildGroqKeys({ data: [{ id: '1', secret_key: 'gsk_x' }] })))).toEqual([])
})

// --- members ---

test('members unnests the per-row identity (id/name/email) and keeps the org role', () => {
  const r = buildGroqMembers({
    members: {
      data: [
        { role: 'owner', user: { id: 'user_a', name: 'Ada Lovelace', email: 'ada@example.com' } },
        { role: 'member', user: { id: 'user_b', name: 'Bo Tester', email: 'bo@example.com' } }
      ]
    }
  })

  expect(r.members[0]).toMatchObject({ id: 'user_a', name: 'Ada Lovelace', email: 'ada@example.com', role: 'owner' })
  expect(r.members[1]).toMatchObject({ id: 'user_b', role: 'member' })
  expect(validateCapabilityResult(members.result(r))).toEqual([])
})

test('members falls back to an index id and tolerates an empty roster', () => {
  expect(buildGroqMembers({ members: { data: [{ role: 'owner' }] } }).members[0].id).toBe('0')
  expect(buildGroqMembers({}).members).toEqual([])
})

// --- plan + account ---

test('extractGroqPlan reads the matching org billing_plan off the profile and title-cases the tier', () => {
  const profile = {
    user: {
      orgs: {
        data: [
          { id: 'org_other', billing_plan: 'free' },
          { id: 'org_me', billing_plan: 'developer_early_access_monthly' }
        ]
      }
    }
  }

  expect(extractGroqPlan(profile, 'org_me')).toBe('Developer')
  expect(extractGroqPlan(profile, 'org_other')).toBe('Free')
  expect(extractGroqPlan(profile, 'org_missing')).toBeNull()
  expect(extractGroqPlan(null, 'org_me')).toBeNull()
})

test('account record carries the plan + billing identity, joins emails, blanks → null', () => {
  const account = buildGroqAccount(
    {
      name: 'Acme Inc',
      customer_type: 'company',
      country: 'CA',
      emails: ['billing@example.com', 'ap@example.com'],
      tax_identification_number: '123456789RT0001'
    },
    'Developer'
  )

  expect(account.dataset.shape).toBe('record')
  expect(account.dataset.value).toMatchObject({
    plan: 'Developer',
    name: 'Acme Inc',
    customerType: 'company',
    country: 'CA',
    billingEmail: 'billing@example.com, ap@example.com',
    taxId: '123456789RT0001'
  })
  expect(buildGroqAccount({}).dataset.value.plan).toBeNull()
})

// --- Summary ---

test('buildGroqSummaryResult: headline MTD + plan + invoice count + monthly spark; no invoices table', () => {
  const result = buildGroqSummaryResult(
    {
      data: [
        { id: 'a', created_at: Date.UTC(2026, 3, 10), total_amount_cents: 2500, payment_status: 'succeeded' },
        { id: 'b', created_at: Date.UTC(2026, 4, 12), total_amount_cents: 1999, status: 'finalized' }
      ]
    },
    { total_amount_cents: 777, currency: 'usd' },
    'Developer'
  )

  expect(validateCapabilityResult(result)).toEqual([])
  const account = result.datasets.find((d) => d.id === 'account')

  expect((account as { value: Record<string, unknown> }).value).toMatchObject({
    currentMtd: 7.77,
    plan: 'Developer',
    invoiceCount: 2
  })
  expect(result.summaries?.[0]).toMatchObject({
    section: 'spend',
    value: 7.77,
    basis: 'accrued',
    spark: { dataset: 'monthly' }
  })
  expect(result.datasets.some((d) => d.id === 'monthly')).toBe(true)
  expect(result.datasets.some((d) => d.id === 'invoices')).toBe(false)
})

test('billing result is the invoices table (no account stat / monthly — those live on Summary)', () => {
  const r = buildGroqBillingResult(
    { data: [{ id: 'a', created_at: Date.UTC(2026, 4, 12), total_amount_cents: 1999, status: 'finalized' }] },
    { total_amount_cents: 500, currency: 'usd' },
    null,
    null
  )

  expect(r.datasets.some((d) => d.id === 'invoices')).toBe(true)
  expect(r.datasets.some((d) => d.id === 'account')).toBe(false)
  expect(r.datasets.some((d) => d.id === 'monthly')).toBe(false)
  // the invoices table is downloadable (per-row invoice PDF)
  const view = r.views?.find((v) => v.type === 'table' && v.dataset === 'invoices') as { files?: unknown }

  expect(view.files).toMatchObject({ source: { url: 'pdfUrl' }, name: 'name', ext: 'pdf' })
  expect(validateCapabilityResult(r)).toEqual([])
})

test('billing result folds the account keyvalue (plan + identity) into the Billing tab', () => {
  const r = buildGroqBillingResult({}, { total_amount_cents: 500, currency: 'usd' }, { name: 'Acme Inc' }, 'Developer')

  expect(r.views).toContainEqual({ type: 'keyvalue', dataset: 'accountInfo', title: 'Account' })
  expect(r.datasets.some((d) => d.id === 'accountInfo')).toBe(true)
  expect(validateCapabilityResult(r)).toEqual([])
})

test('billing result omits the account block when there is no info and no plan', () => {
  const r = buildGroqBillingResult({}, {}, null, null)

  expect(r.datasets.some((d) => d.id === 'accountInfo')).toBe(false)
  expect(r.views?.some((v) => v.dataset === 'accountInfo')).toBe(false)
  expect(validateCapabilityResult(r)).toEqual([])
})

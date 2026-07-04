import { resolveCurrencies, validateCapabilityResult } from '@butinapp/sdk/data'
import { members } from '@butinapp/sdk/presets'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import {
  aggregateSpendByModelFamily,
  buildClaudeAnalytics,
  buildClaudeBillingReport,
  buildClaudeBillingTab,
  buildClaudeMembers,
  buildClaudeSummaryResult,
  buildOrgOptions,
  type ClaudeBillingReport,
  classifyInvoice,
  claudePlugin,
  modelDailyRows,
  monthlyCategoryRows,
  type RawAnalyticsBundle,
  type RawBillingBundle,
  resolveOrgId,
  seatBreakdownCaption,
  seatMixCaption,
  seatRecommendation,
  seatTierLabel
} from './main.js'

const bundle = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/billing-bundle.json'), 'utf8')
) as RawBillingBundle

test('classifyInvoice: seats when num_seats present, usage for large non-sub, null for void', () => {
  expect(classifyInvoice(bundle.invoices[0])).toBe('seats')
  expect(classifyInvoice(bundle.invoices[1])).toBe('usage')
  expect(classifyInvoice(bundle.invoices[2])).toBeNull()
})

test('buildClaudeBillingReport normalizes cents→USD and splits seats vs usage', () => {
  const report = buildClaudeBillingReport(bundle, '2026-06-12T00:00:00Z')

  expect(report.currency).toBe('CAD')
  expect(report.invoices).toHaveLength(2)
  expect(report.currentMtd).toBe(1234)
  expect(report.monthly.some((m) => m.usage === 2000)).toBe(true)
  expect(report.seatSubtotal).toBe(90)
})

test('buildClaudeSummaryResult: kind-billing headline (MTD + prepaid + invoice count) + monthly spark', () => {
  const report = buildClaudeBillingReport(bundle, '2026-06-12T00:00:00Z')
  const result = buildClaudeSummaryResult(report)

  expect(validateCapabilityResult(result)).toEqual([])
  const account = result.datasets.find((d) => d.id === 'account') as unknown as { value: Record<string, unknown> }

  expect(account.value).toMatchObject({ currentMtd: 1234, invoiceCount: report.invoices.length })
  expect(result.summaries?.[0]).toMatchObject({
    section: 'spend',
    value: 1234,
    basis: 'accrued',
    spark: { dataset: 'monthly' }
  })
  expect(result.datasets.some((d) => d.id === 'monthly')).toBe(true)
  // invoices live on the Billing detail tab, not Summary
  expect(result.datasets.some((d) => d.id === 'invoices')).toBe(false)
})

test('buildClaudeBillingTab: a seats/usage breakdown + the invoices table (no Summary headline stat/total)', () => {
  const report = buildClaudeBillingReport(bundle, '2026-06-12T00:00:00Z')
  const result = buildClaudeBillingTab(report)

  expect(validateCapabilityResult(result)).toEqual([])
  // the stacked breakdown + the invoices detail — but NOT the Summary's `account` stat or `monthly` total
  expect(result.datasets.map((d) => d.id).sort()).toEqual(['invoices', 'monthlyByCategory'])
  const invoicesDs = result.datasets.find((d) => d.id === 'invoices') as unknown as { rows: unknown[] }

  expect(invoicesDs.rows).toHaveLength(report.invoices.length)
  // the invoices table is downloadable (per-row invoice PDF)
  const view = result.views?.find((v) => v.type === 'table' && v.dataset === 'invoices') as { files?: unknown }

  expect(view.files).toMatchObject({ source: { url: 'pdfUrl' }, name: 'name', ext: 'pdf' })
})

test('claude leads with a Summary tab (kind billing, first) ahead of the invoicing Billing tab', () => {
  expect(claudePlugin.capabilities[0]).toMatchObject({ id: 'summary' })
  expect(claudePlugin.capabilities.some((c) => c.id === 'billing')).toBe(true)
})

test('resolveOrgId: single org auto-resolves; zero or several → a deliberate-pick error', () => {
  expect(resolveOrgId([{ uuid: 'org-123' }])).toEqual({ ok: true, orgId: 'org-123' })
  expect(resolveOrgId([])).toMatchObject({ ok: false })

  const many = resolveOrgId([{ uuid: 'a' }, { uuid: 'b' }])

  expect(many.ok).toBe(false)
  expect(many.ok === false && many.error).toContain('2 Claude organizations')
})

test('buildOrgOptions: name label + uuid subtext, recommends the team/billing org when there is a choice', () => {
  const opts = buildOrgOptions([
    { uuid: 'p', name: 'Personal', capabilities: ['chat', 'claude_pro'] },
    { uuid: 't', name: 'Acme Team', capabilities: ['chat', 'claude_team'] }
  ])

  expect(opts).toEqual([
    { value: 'p', label: 'Personal', description: 'p', recommended: false },
    { value: 't', label: 'Acme Team', description: 't', recommended: true }
  ])
})

test('buildOrgOptions: a single org gets no recommended flag and falls back to its uuid as label', () => {
  expect(buildOrgOptions([{ uuid: 'solo' }])).toMatchObject([{ value: 'solo', label: 'solo', recommended: false }])
})

const analyticsBundle: RawAnalyticsBundle = {
  counts: { total: 3, by_seat_tier: { team_standard: 2, team_tier_1: 1 }, pending_invites_total: 1 },
  limit: { seat_tier_quantities: { team_standard: 3, team_tier_1: 2 } },
  subscription: { status: 'active', currency: 'USD', next_charge_date: '2026-07-01' },
  rankings: {
    users: [
      { account_uuid: 'a1', email_address: 'a@example.test', seat_tier: 'team_standard', value: 210 },
      { account_uuid: 'a2', email_address: 'b@example.test', seat_tier: 'team_tier_1', value: 250 },
      { account_uuid: 'a3', email_address: 'c@example.test', seat_tier: 'team_standard', value: 10 }
    ]
  },
  spendTs: {
    currency: 'USD',
    data_points: [
      { date: '2026-06-01', value: 100 },
      { date: '2026-06-02', value: 50.5 }
    ]
  },
  spendByModel: {
    models: [
      { model_family: 'Opus', data_points: [{ date: '2026-06-01', value: 60 }] },
      { model_family: 'Opus', data_points: [{ date: '2026-06-02', value: 30 }] },
      { model_family: 'Sonnet', data_points: [{ date: '2026-06-01', value: 40 }] }
    ]
  },
  // claude.ai reports utilization/stickiness as whole-number percents (66 = 66%), not 0..1 fractions.
  activity: { dau: { value: 2 }, wau: { value: 3 }, mau: { value: 3 }, utilization: { value: 66 }, stickiness: 50 }
}

test('aggregateSpendByModelFamily collapses per-version rows to one per family, sorted desc', () => {
  expect(aggregateSpendByModelFamily(analyticsBundle.spendByModel.models ?? [])).toEqual([
    { model: 'Opus', spend: 90 },
    { model: 'Sonnet', spend: 40 }
  ])
})

test('seatRecommendation: standard over a premium seat → upgrade; heavy premium → monitor; else OK', () => {
  expect(seatRecommendation('team_standard', 210)).toBe('Upgrade to Premium')
  expect(seatRecommendation('team_tier_1', 250)).toBe('Monitor usage limits')
  expect(seatRecommendation('team_standard', 10)).toBe('OK')
})

test('buildClaudeAnalytics produces a valid result with MTD summary, seats, members, activity', () => {
  const result = buildClaudeAnalytics(analyticsBundle)

  expect(validateCapabilityResult(result)).toEqual([])
  expect(result.summaries?.[0]).toMatchObject({ section: 'other', value: 150.5, role: 'money' })

  const overview = result.datasets.find((d) => d.id === 'overview') as unknown as { value: Record<string, unknown> }

  expect(overview.value).toMatchObject({ seatsUsed: 3, seatsPurchased: 5, pendingInvites: 1, mtdSpend: 150.5 })

  const members = result.datasets.find((d) => d.id === 'members') as unknown as {
    key?: string
    rows: Array<Record<string, unknown>>
    columns: Array<{ key: string; accrual?: string; resetPeriod?: string }>
  }

  expect(members.rows[0]).toMatchObject({ email: 'a@example.test', suggestion: 'Upgrade to Premium' })

  // members is keyed by email + spend is a monthly-resetting cumulative column, so the ledger can difference
  // each member's MTD readings into a per-member daily-usage trend.
  expect(members.key).toBe('email')
  expect(members.columns.find((c) => c.key === 'spend')).toMatchObject({
    accrual: 'cumulative',
    resetPeriod: 'monthly'
  })

  const activity = result.datasets.find((d) => d.id === 'activity') as unknown as { value: Record<string, unknown> }

  // whole-number percents from the API (66, 50) normalized to 0..1 fractions for the percent role
  expect(activity.value).toMatchObject({ utilization: 0.66, stickiness: 0.5 })
})

test('seatBreakdownCaption: total seats + per-line count×unit price; undefined when empty', () => {
  expect(
    seatBreakdownCaption([
      { tier: 'team_standard', description: 'Standard', count: 56, unitPrice: 34, total: 1904 },
      { tier: 'team_tier_1', description: 'Premium', count: 20, unitPrice: 171, total: 3420 }
    ])
  ).toBe('76 seats · 56×$34 · 20×$171')
  expect(seatBreakdownCaption([])).toBeUndefined()
})

test('seatTierLabel: known tiers map to Anthropic labels; others title-case; empty → Unknown', () => {
  expect(seatTierLabel('team_tier_1')).toBe('Premium')
  expect(seatTierLabel('team_standard')).toBe('Standard')
  expect(seatTierLabel('team_enterprise')).toBe('Team Enterprise')
  expect(seatTierLabel('')).toBe('Unknown')
})

test('seatMixCaption: per-tier count with friendly tier names; undefined when no seats', () => {
  expect(seatMixCaption({ team_standard: 56, team_tier_1: 20 })).toBe('56 Standard · 20 Premium')
  expect(seatMixCaption({ team_standard: 0, team_tier_1: 0 })).toBeUndefined()
  expect(seatMixCaption(undefined)).toBeUndefined()
})

test('Members Seat column renders pretty tier badges (Premium/Standard), not raw tier ids', () => {
  const result = buildClaudeAnalytics(analyticsBundle)
  const members = result.datasets.find((d) => d.id === 'members') as unknown as {
    columns: Array<{ key: string; role: string; badges?: Record<string, string> }>
    rows: Array<Record<string, unknown>>
  }
  const tierCol = members.columns.find((c) => c.key === 'tier')

  // Seat tier is categorical (Premium/Standard have no sentiment) — the renderer assigns distinct hues, so
  // the column declares no `badges` map.
  expect(tierCol?.role).toBe('category')
  expect(tierCol?.badges).toBeUndefined()
  // rows carry the pretty label, not 'team_standard'/'team_tier_1'
  expect(members.rows.map((r) => r.tier)).toEqual(['Standard', 'Premium', 'Standard'])
})

test('Usage overview combines seats (used / purchased + progress) and captions Spend (MTD) with its currency', () => {
  const result = buildClaudeAnalytics(analyticsBundle)
  const stat = result.views?.find((v) => v.type === 'stat' && v.dataset === 'overview')
  const fields = stat?.type === 'stat' ? stat.fields : undefined

  // seatsPurchased (5) is the denominator of the seats card; the per-tier mix is the caption — no standalone
  // "Seats purchased" card.
  expect(fields).toContainEqual({ key: 'seatsUsed', max: 5, caption: '2 Standard · 1 Premium' })
  expect(fields).toContainEqual({ key: 'mtdSpend', caption: 'usage meter · USD' })
  expect(fields).not.toContain('seatsPurchased')
})

const richBillingReport: ClaudeBillingReport = {
  capturedAt: '2026-06-16T00:00:00Z',
  currency: 'CAD',
  currentMtd: 10350,
  limitEnabled: true,
  monthlyLimit: 20000,
  usedThisPeriod: 10350,
  prepaidBalance: 558.84,
  autoReload: { enabled: true, threshold: 100, reloadTo: 5100 },
  stripeBalance: 0,
  seatLines: [
    { tier: 'team_standard', description: 'Standard', count: 56, unitPrice: 34, total: 1904 },
    { tier: 'team_tier_1', description: 'Premium', count: 20, unitPrice: 171, total: 3420 }
  ],
  seatSubtotal: 5324,
  seatTotalWithTax: 5614,
  nextChargeDate: '2026-06-28',
  monthly: [],
  invoices: []
}

test('Summary emits rich billing cards: usage-limit progress, recurring-seats breakdown, prepaid auto-reload, next charge', () => {
  const r = buildClaudeSummaryResult(richBillingReport)
  const stat = r.views?.find((v) => v.type === 'stat' && v.dataset === 'account')
  const fields = stat?.type === 'stat' ? stat.fields : undefined

  expect(fields).toContainEqual({ key: 'currentMtd', caption: 'invoiced · CAD' })
  expect(fields).toContainEqual({ key: 'usageLimit', max: 20000, caption: '52% of monthly cap' })
  expect(fields).toContainEqual({ key: 'recurringSeats', unit: '/mo', caption: '76 seats · 56×$34 · 20×$171' })
  expect(fields).toContainEqual({ key: 'prepaidBalance', caption: 'auto-reload ≤ $100 → $5,100' })
  expect(fields).toContainEqual({ key: 'nextCharge', caption: 'seats $5,614 incl. tax' })
})

test('monthlyCategoryRows fans each month into long-format Seats + Usage rows', () => {
  expect(
    monthlyCategoryRows([
      { month: '2026-04', seats: 2000, usage: 8000 },
      { month: '2026-05', seats: 2100, usage: 9000 }
    ])
  ).toEqual([
    { month: '2026-04', category: 'Seats', amount: 2000 },
    { month: '2026-04', category: 'Usage', amount: 8000 },
    { month: '2026-05', category: 'Seats', amount: 2100 },
    { month: '2026-05', category: 'Usage', amount: 9000 }
  ])
})

test('Billing tab leads with a stacked seats/usage breakdown bound to monthlyByCategory', () => {
  const report = buildClaudeBillingReport(bundle, '2026-06-12T00:00:00Z')
  const result = buildClaudeBillingTab(report)
  const view = result.views?.find((v) => v.type === 'timeseries')

  expect(view).toMatchObject({ type: 'timeseries', dataset: 'monthlyByCategory', stackBy: 'category', y: 'amount' })
  expect(validateCapabilityResult(result)).toEqual([])
})

test('modelDailyRows collapses model versions onto one (date, family) cell, summing same-day values', () => {
  expect(
    modelDailyRows([
      { model_family: 'Opus', data_points: [{ date: '2026-06-01', value: 60 }] },
      { model_family: 'Opus', data_points: [{ date: '2026-06-01', value: 30 }] }, // same family+day → summed
      { model_family: 'Sonnet', data_points: [{ date: '2026-06-01', value: 40 }] }
    ])
  ).toEqual([
    { date: '2026-06-01', model: 'Opus', value: 90 },
    { date: '2026-06-01', model: 'Sonnet', value: 40 }
  ])
})

test('Usage tab adds a stacked daily Spend-by-model chart bound to byModelDaily', () => {
  const result = buildClaudeAnalytics(analyticsBundle)
  const view = result.views?.find((v) => v.type === 'timeseries' && v.dataset === 'byModelDaily')

  expect(view).toMatchObject({ type: 'timeseries', stackBy: 'model', x: 'date', y: 'value' })
  expect(validateCapabilityResult(result)).toEqual([])
})

test('claude exposes a usage capability', () => {
  expect(claudePlugin.capabilities.some((c) => c.id === 'usage')).toBe(true)
})

test('claude exposes a members capability', () => {
  expect(claudePlugin.capabilities.some((c) => c.id === 'members')).toBe(true)
})

test('buildClaudeMembers normalizes a nested-account roster (the { members } envelope)', () => {
  const input = buildClaudeMembers({
    members: [
      { account: { uuid: 'u1', email_address: 'a@example.test', full_name: 'Ada Lovelace' }, role: 'admin' },
      { account: { uuid: 'u2', email_address: 'b@example.test' }, role: 'member' }
    ]
  })

  expect(input.members).toEqual([
    { id: 'u1', name: 'Ada Lovelace', email: 'a@example.test', role: 'admin' },
    { id: 'u2', name: undefined, email: 'b@example.test', role: 'member' }
  ])

  expect(validateCapabilityResult(members.result(input))).toEqual([])
})

test('buildClaudeMembers handles a bare-array, flattened-identity roster and falls back for missing ids', () => {
  expect(
    buildClaudeMembers([{ email_address: 'c@example.test', name: 'Carol', role: 'billing' }, { role: 'developer' }])
      .members
  ).toEqual([
    { id: 'c@example.test', name: 'Carol', email: 'c@example.test', role: 'billing' },
    { id: '1', name: undefined, email: undefined, role: 'developer' }
  ])
})

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of claudePlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(resolveCurrencies(cap.sample!(), 'USD')), cap.id).toEqual([])
  }
})

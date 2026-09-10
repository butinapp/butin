import { resultValidator, validateSamples } from '@butinapp/sdk/testing'
import { expect, test } from 'vitest'

import {
  anthropicPlugin,
  buildAnthropicAnalytics,
  buildAnthropicApiKeysResult,
  buildOrgOptions,
  buildAnthropicBillingReport,
  buildAnthropicBillingTab,
  buildAnthropicMembers,
  buildAnthropicSummaryResult,
  buildAnthropicUsageResult,
  flattenKeys,
  monthLabel,
  recentMonths,
  resolveOrgId,
  servicePeriodMonth
} from './main.js'

const validateCapabilityResult = resultValidator('USD')

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(anthropicPlugin)).toEqual([])
})

test('anthropic plugin is well-formed', () => {
  expect(anthropicPlugin.meta.id).toBe('anthropic-console')
  expect(anthropicPlugin.meta.vendor).toBe('Anthropic')
  expect(anthropicPlugin.auth.kind).toBe('cookie')
  expect(anthropicPlugin.transport?.requiresBrowserEngine).toBe(true)
  expect(anthropicPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'usage', 'api-keys', 'members'])
})

test('servicePeriodMonth parses the start month, null on garbage', () => {
  expect(servicePeriodMonth('May 01 2026 - May 31 2026')).toBe('2026-05')
  expect(servicePeriodMonth('Dec 01 2025 - Dec 31 2025')).toBe('2025-12')
  expect(servicePeriodMonth(null)).toBeNull()
  expect(servicePeriodMonth('not a period')).toBeNull()
})

test('resolveOrgId: single → ok, none/many → friendly error', () => {
  expect(resolveOrgId([{ uuid: 'org_1' }])).toEqual({ ok: true, orgId: 'org_1' })
  expect(resolveOrgId([]).ok).toBe(false)
  const many = resolveOrgId([{ uuid: 'a' }, { uuid: 'b' }])

  expect(many.ok).toBe(false)
  expect(many.ok === false && many.error).toContain('2 Anthropic organizations')
})

test('buildOrgOptions: name as label, uuid as value/subtext, first recommended when multiple', () => {
  const opts = buildOrgOptions([
    { uuid: 'org_a', name: 'Acme' },
    { uuid: 'org_b', name: '' },
    { name: 'no uuid — dropped' }
  ])

  expect(opts).toEqual([
    { value: 'org_a', label: 'Acme', description: 'org_a', recommended: true },
    { value: 'org_b', label: 'org_b', description: undefined, recommended: false }
  ])
  // A single org needs no recommended flag (nothing to choose).
  expect(buildOrgOptions([{ uuid: 'org_only', name: 'Solo' }])[0]?.recommended).toBe(false)
})

test('recentMonths + monthLabel: newest first, formatted', () => {
  const months = recentMonths(new Date('2026-06-14T00:00:00Z'), 4)

  expect(months.map((m) => m.start)).toEqual(['2026-06-01', '2026-05-01', '2026-04-01', '2026-03-01'])
  expect(monthLabel('2026-06-01')).toBe('Jun 2026')
})

const billingBundle = {
  invoices: [
    {
      type: 'usage_invoice',
      invoice_status: 'paid',
      effective_at: '2026-06-01T00:00:00Z',
      amount: 123_45, // $123.45
      service_period: 'May 01 2026 - May 31 2026',
      download_url: 'https://pay.example/inv_may.pdf',
      hosted_invoice_url: 'https://pay.example/inv_may'
    },
    {
      type: 'usage_invoice',
      invoice_status: 'paid',
      effective_at: '2026-05-01T00:00:00Z',
      amount: 100_00,
      service_period: 'Apr 01 2026 - Apr 30 2026',
      download_url: null,
      hosted_invoice_url: null
    },
    {
      type: 'prepaid_credits',
      invoice_status: 'paid',
      effective_at: '2026-03-15T00:00:00Z',
      amount: 500_00,
      service_period: null,
      download_url: null,
      hosted_invoice_url: null
    }
  ],
  currentSpend: { amount: 42_00, resets_at: '2026-07-01T00:00:00Z' },
  spendLimits: { spend_limits: [{ limit_usd: 1_000_00, limit_action: 'notify_and_pause' }] },
  paymentMethod: { brand: 'visa', last4: '4242' },
  billingEmails: { primary_email: 'billing@example.com' },
  currency: 'USD'
}

test('buildAnthropicBillingReport: USD normalization, arrears dating, cap %', () => {
  const report = buildAnthropicBillingReport(billingBundle, '2026-06-14T00:00:00Z')

  expect(report.currentSpend).toBe(42)
  expect(report.pauseLimit).toBe(1000)
  expect(report.pauseLimitPct).toBe(4) // 42 / 1000 → 4%
  expect(report.paymentMethod).toEqual({ brand: 'visa', last4: '4242' })

  // Newest effective_at first; usage invoices dated by their SERVICE period month.
  expect(report.invoices[0]).toMatchObject({ date: '2026-05-01', kind: 'usage', amount: 123.45 })
  expect(report.invoices[1]).toMatchObject({ date: '2026-04-01', kind: 'usage', amount: 100 })
  // Credits dated by effective_at.
  expect(report.invoices[2]).toMatchObject({ date: '2026-03-15', kind: 'credits', amount: 500 })
})

test('buildAnthropicSummaryResult: spend.mtd summary + usage-only monthly chart', () => {
  const result = buildAnthropicSummaryResult(buildAnthropicBillingReport(billingBundle, 'now'))

  expect(result.summaries?.[0]).toMatchObject({ section: 'spend', value: 42, role: 'money', basis: 'accrued' })
  const monthly = result.datasets.find((d) => d.id === 'monthly')

  // Two usage months (May, Apr); the $500 credit purchase is excluded from the trend.
  expect(monthly?.shape === 'table' && monthly.rows.map((r) => r.month)).toEqual(['2026-04', '2026-05'])

  // The headline clarifies the figure is a running open-period total (with the reset date); the pause-cap card
  // carries how much of it is consumed.
  const statView = result.views?.find((v) => v.type === 'stat')
  const fields = statView && 'fields' in statView ? statView.fields : []

  expect(fields).toContainEqual({ key: 'currentMtd', caption: 'accrued so far · resets Jul 1' })
  expect(fields).toContainEqual(expect.objectContaining({ key: 'pauseLimit', caption: '4% used' }))
})

test('buildAnthropicBillingTab: account record + downloadable invoice table', () => {
  const result = buildAnthropicBillingTab(buildAnthropicBillingReport(billingBundle, 'now'))

  const invoices = result.datasets.find((d) => d.id === 'invoices')

  expect(invoices?.shape === 'table' && invoices.rows.length).toBe(3)
  // Keyed by a stable per-invoice id so the ledger accumulates invoices past the fetched window; ids are unique.
  expect(invoices?.shape === 'table' && invoices.key).toBe('id')
  const ids = invoices?.shape === 'table' ? invoices.rows.map((r) => r.id) : []

  expect(new Set(ids).size).toBe(3)
  const tableView = result.views?.find((v) => v.type === 'table')

  expect(tableView && 'files' in tableView && tableView.files?.ext).toBe('pdf')
})

const analyticsBundle = {
  members: [
    { id: 'u_alice', email: 'alice@example.com', name: 'Alice', role: 'developer' },
    { id: 'u_bob', email: 'bob@example.com', name: 'Bob', role: 'billing' }
  ],
  apiKeys: [
    {
      id: 'k_a1',
      name: 'alice-prod',
      workspace_id: null,
      created_at: '2026-01-05T00:00:00Z',
      status: 'active',
      expires_at: null,
      partial_key_hint: 'sk-ant-…a1a1',
      created_by: { id: 'u_alice' }
    },
    {
      id: 'k_b1',
      name: 'bob-ci',
      workspace_id: 'ws_1',
      created_at: '2026-02-10T00:00:00Z',
      status: 'active',
      expires_at: null,
      partial_key_hint: 'sk-ant-…b1b1',
      created_by: { id: 'u_bob' }
    }
  ],
  keyUsage: { api_keys: [{ id: 'k_a1', last_used_at: '2026-06-10T00:00:00Z' }] },
  monthlyCosts: [
    {
      periodStart: '2026-06-01',
      label: 'Jun 2026',
      cost: {
        costs: {
          d1: [
            { key_id: 'k_a1', total: 30_00 },
            { key_id: 'k_unknown', total: 5_00 }
          ]
        }
      }
    },
    { periodStart: '2026-05-01', label: 'May 2026', cost: { costs: { d1: [{ key_id: 'k_b1', total: 10_00 }] } } }
  ],
  orgCurrentSpendCents: 35_00
}

test('buildAnthropicAnalytics: per-creator spend + unattributed bucket', () => {
  const report = buildAnthropicAnalytics(analyticsBundle, 'now')

  expect(report.orgCurrentSpend).toBe(35)
  // Sorted by current (Jun) spend desc → Alice ($30), then unattributed ($5), then Bob ($0 this month).
  const alice = report.rows.find((r) => r.email === 'alice@example.com')

  expect(alice?.currentSpend).toBe(30)
  expect(alice?.apiKeyCount).toBe(1)
  expect(alice?.lastUsed).toBe('2026-06-10T00:00:00Z')
  const unattributed = report.rows.find((r) => r.creatorId === 'unattributed')

  expect(unattributed?.currentSpend).toBe(5)
  expect(unattributed?.isMember).toBe(false)
})

test('buildAnthropicAnalytics: attaches per-member key details incl. this-month spend', () => {
  const report = buildAnthropicAnalytics(analyticsBundle, 'now')
  const alice = report.rows.find((r) => r.email === 'alice@example.com')

  expect(alice?.keys).toHaveLength(1)
  expect(alice?.keys[0]).toMatchObject({
    id: 'k_a1',
    name: 'alice-prod',
    partialKeyHint: 'sk-ant-…a1a1',
    status: 'active',
    workspaceId: null,
    currentSpend: 30
  })
  // The unknown key surfaces on the unattributed bucket as a synthesized (name-less) detail with its spend.
  const unattributed = report.rows.find((r) => r.creatorId === 'unattributed')

  expect(unattributed?.keys).toEqual([
    expect.objectContaining({ id: 'k_unknown', name: '', currentSpend: 5, createdAt: null })
  ])
})

test('flattenKeys: owner-attributed rows; orphan keys → Unattributed', () => {
  const rows = flattenKeys(buildAnthropicAnalytics(analyticsBundle, 'now'))
  const alice = rows.find((r) => r.id === 'k_a1')

  expect(alice).toMatchObject({
    owner: 'alice@example.com',
    creatorId: 'u_alice',
    workspace: 'default',
    currentSpend: 30
  })
  expect(rows.find((r) => r.id === 'k_b1')?.workspace).toBe('ws_1')
  expect(rows.find((r) => r.id === 'k_unknown')?.owner).toBe('Unattributed')
})

test('buildAnthropicUsageResult: usage.primary summary + member table + Role badge + key detail', () => {
  const result = buildAnthropicUsageResult(buildAnthropicAnalytics(analyticsBundle, 'now'))

  expect(result.summaries?.[0]).toMatchObject({ section: 'other', value: 35, role: 'money' })
  const members = result.datasets.find((d) => d.id === 'members')

  expect(members?.shape === 'table' && members.columns.find((c) => c.key === 'current')?.label).toBe('Jun 2026')
  // Role is a category badge, not plain text.
  expect(members?.shape === 'table' && members.columns.find((c) => c.key === 'role')?.role).toBe('category')

  // The members table expands into the memberKeys child, joined on creatorId.
  const membersView = result.views?.find((v) => v.type === 'table' && v.dataset === 'members')

  expect(membersView && 'detail' in membersView && membersView.detail).toEqual({
    dataset: 'memberKeys',
    on: 'creatorId'
  })
  expect(result.datasets.some((d) => d.id === 'memberKeys')).toBe(true)
  expect(validateCapabilityResult(result)).toEqual([])
})

test('buildAnthropicApiKeysResult: one flat table, spend-desc, orphans included', () => {
  const result = buildAnthropicApiKeysResult(buildAnthropicAnalytics(analyticsBundle, 'now'))
  const keys = result.datasets.find((d) => d.id === 'apiKeys')

  if (keys?.shape !== 'table') {
    throw new Error('expected apiKeys table')
  }

  // Every key present (2 members + 1 orphan), highest this-month spend first.
  expect(keys.rows.map((r) => r.id)).toEqual(['k_a1', 'k_unknown', 'k_b1'])
  expect(keys.columns.some((c) => c.key === 'owner')).toBe(true)
  expect(validateCapabilityResult(result)).toEqual([])
})

test('buildAnthropicMembers: maps roster onto the members preset input', () => {
  const input = buildAnthropicMembers([{ id: 'u1', email: 'a@b.com', name: 'A', role: 'developer' }])

  expect(input.members).toEqual([{ id: 'u1', name: 'A', email: 'a@b.com', role: 'developer' }])
  expect(buildAnthropicMembers(null).members).toEqual([])
})

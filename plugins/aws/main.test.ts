import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { expect, test } from 'vitest'

import {
  awsBillingResult,
  awsMembersResult,
  awsPlugin,
  awsSummaryResult,
  buildBillingReport,
  clientConfig,
  mapIdentityUser,
  type CeResultByTime,
  type IdentityUserLike
} from './main.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'USD'))

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of awsPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

// --- plugin shape ---

test('aws is an external, sessionless plugin (no Magic Login)', () => {
  expect(awsPlugin.auth.kind).toBe('external')
  expect(awsPlugin.session).toBeUndefined()
  expect(awsPlugin.capabilities.map((c) => c.id)).toEqual(['summary', 'billing', 'members'])
  expect((awsPlugin.config?.fields ?? []).map((f) => f.key)).toEqual([
    'authMode',
    'profile',
    'accessKeyId',
    'secretAccessKey',
    'region',
    'identityStoreId'
  ])
  // the access-key fields only show in IAM mode
  const keyField = awsPlugin.config?.fields.find((f) => f.key === 'accessKeyId')

  expect(keyField?.showWhen).toEqual({ field: 'authMode', equals: 'iam' })
})

// --- client config (auth mode) ---

test('clientConfig honors authMode: iam → keys, profile → named profile, blank → ambient', () => {
  expect(clientConfig({ authMode: 'iam', accessKeyId: 'AKIA', secretAccessKey: 's' }, 'us-east-1')).toEqual({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIA', secretAccessKey: 's' }
  })
  expect(clientConfig({ authMode: 'profile', profile: 'prod' }, 'eu-west-1')).toEqual({
    region: 'eu-west-1',
    profile: 'prod'
  })
  // profile mode with a blank profile → ambient default chain (region only)
  expect(clientConfig({ authMode: 'profile' }, 'us-east-1')).toEqual({ region: 'us-east-1' })
  // iam mode but missing keys → does not fabricate credentials
  expect(clientConfig({ authMode: 'iam' }, 'us-east-1')).toEqual({ region: 'us-east-1' })
})

// --- billing ---

const ce = (start: string, groups: Array<[string, string]>): CeResultByTime => ({
  TimePeriod: { Start: start, End: start },
  Groups: groups.map(([key, amount]) => ({ Keys: [key], Metrics: { UnblendedCost: { Amount: amount, Unit: 'USD' } } }))
})

const serviceResults: CeResultByTime[] = [
  ce('2026-04-01', [
    ['Amazon EC2', '100.00'],
    ['Amazon S3', '20.00']
  ]),
  ce('2026-05-01', [
    ['Amazon EC2', '150.00'],
    ['Amazon S3', '30.50']
  ])
]
const accountResults: CeResultByTime[] = [
  ce('2026-04-01', [
    ['111122223333', '90.00'],
    ['444455556666', '30.00']
  ]),
  ce('2026-05-01', [
    ['111122223333', '120.50'],
    ['444455556666', '60.00']
  ])
]
const accountNames = { '111122223333': 'prod', '444455556666': 'staging' }

test('buildBillingReport sums by month/service/account and parses dollar strings (no /100)', () => {
  const r = buildBillingReport(serviceResults, accountResults, accountNames)

  expect(r.currency).toBe('USD')
  expect(r.byMonth).toEqual([
    { month: '2026-04', amount: 120 },
    { month: '2026-05', amount: 180.5 }
  ])
  expect(r.thisMonth).toBe(180.5)
  expect(r.lastMonth).toBe(120)
  expect(r.grandTotal).toBe(300.5)
  // by-service, descending
  expect(r.byService).toEqual([
    { service: 'Amazon EC2', amount: 250 },
    { service: 'Amazon S3', amount: 50.5 }
  ])
  // by-account resolves ids → names, descending
  expect(r.byAccount).toEqual([
    { accountId: '111122223333', accountName: 'prod', amount: 210.5 },
    { accountId: '444455556666', accountName: 'staging', amount: 90 }
  ])
})

test('buildBillingReport headlines the reporting-zone month, not Cost Explorer last (UTC) bucket', () => {
  // Near the month boundary CE's window already carries the next UTC month as a near-$0 partial, while the user
  // is still in 2026-05. "This month" must read the 2026-05 bar, not the tiny 2026-06 partial.
  const withUtcPartial: CeResultByTime[] = [...serviceResults, ce('2026-06-01', [['Amazon EC2', '2.00']])]
  const r = buildBillingReport(withUtcPartial, accountResults, accountNames, '2026-05')

  expect(r.thisMonth).toBe(180.5)
  expect(r.lastMonth).toBe(120)
})

test('buildBillingReport falls back to the bare account id when no name is known', () => {
  const r = buildBillingReport([], [ce('2026-05-01', [['999988887777', '5.00']])], {})

  expect(r.byAccount).toEqual([{ accountId: '999988887777', accountName: '999988887777', amount: 5 }])
})

test('awsSummaryResult is the lean rollup: headline cards + monthly spark + spend.mtd summary, no tables', () => {
  const r = awsSummaryResult(buildBillingReport(serviceResults, accountResults, accountNames))

  expect(validateCapabilityResult(r)).toEqual([])
  // Summary carries only the headline stat record + the monthly chart — the breakdown tables live on Billing.
  expect(r.datasets.map((d) => d.id)).toEqual(['account', 'monthly'])
  expect(r.summaries?.[0]).toMatchObject({
    section: 'spend',
    value: 180.5,
    role: 'money',
    currency: 'USD',
    basis: 'accrued'
  })
  expect(r.summaries?.[0]?.spark).toEqual({ dataset: 'monthly', x: 'month', y: 'amount' })
})

test('awsBillingResult is the spend detail: by-service + by-account tables, no chart or rollup summary', () => {
  const r = awsBillingResult(buildBillingReport(serviceResults, accountResults, accountNames))

  expect(validateCapabilityResult(r)).toEqual([])
  expect(r.datasets.map((d) => d.id)).toEqual(['byService', 'byAccount'])
  expect(r.summaries ?? []).toEqual([])
})

// --- members ---

test('mapIdentityUser pulls the primary email, full name, and active/suspended status', () => {
  const enabled: IdentityUserLike = {
    UserId: 'u-1',
    UserName: 'ada',
    DisplayName: 'Ada Lovelace',
    Emails: [{ Value: 'alt@x.io' }, { Value: 'ada@x.io', Primary: true }],
    UserStatus: 'ENABLED'
  }
  const disabled: IdentityUserLike = {
    UserId: 'u-2',
    UserName: 'bob',
    Name: { GivenName: 'Bob', FamilyName: 'Stone' },
    Emails: [{ Value: 'bob@x.io' }],
    UserStatus: 'DISABLED'
  }

  expect(mapIdentityUser(enabled)).toEqual({
    id: 'u-1',
    name: 'Ada Lovelace',
    email: 'ada@x.io',
    status: 'active',
    username: 'ada'
  })
  expect(mapIdentityUser(disabled)).toEqual({
    id: 'u-2',
    name: 'Bob Stone',
    email: 'bob@x.io',
    status: 'suspended',
    username: 'bob'
  })
})

test('awsMembersResult is a valid members table with status badges', () => {
  const r = awsMembersResult([
    { id: 'u-1', name: 'Ada', email: 'ada@x.io', status: 'active', username: 'ada' },
    { id: 'u-2', name: null, email: null, status: 'suspended', username: null }
  ])

  expect(validateCapabilityResult(r)).toEqual([])
  const members = r.datasets[0]

  if (members.shape !== 'table') {
    throw new Error('members should be a table')
  }

  const statusCol = members.columns.find((c) => c.key === 'status')

  // active/suspended auto-tone in the renderer's lexicon, so the column carries no `badges` map.
  expect(statusCol?.role).toBe('status')
  expect(statusCol?.badges).toBeUndefined()
  expect(members.rows[1]).toMatchObject({ name: null, email: null, status: 'suspended' })
})

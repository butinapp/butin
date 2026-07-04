import { CostExplorerClient, GetCostAndUsageCommand, GetDimensionValuesCommand } from '@aws-sdk/client-cost-explorer'
import { IdentitystoreClient, ListUsersCommand, type User as IdentityStoreUser } from '@aws-sdk/client-identitystore'
import {
  GetInvoicePDFCommand,
  InvoicingClient,
  ListInvoiceSummariesCommand,
  type InvoiceSummary
} from '@aws-sdk/client-invoicing'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { defineCapability, defineConfigSchema, definePlugin, type CollectContext, type ConfigOf } from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { DateTime } from '@butinapp/sdk/libs'
import { currentMonthKey, isoDay, round2 } from '@butinapp/sdk/util'

import { sampleAwsBilling, sampleAwsInvoices, sampleAwsMembers } from './sample.js'

// AWS — an `external` plugin: it authenticates ITSELF with the AWS SDK (a named profile, an access-key pair,
// or the ambient default credential chain) from values typed into Settings. There's no browser session to
// capture, so `session` is omitted and core attaches nothing. Four read tabs:
//   summary → the cross-service Overview rollup (spend.mtd): the headline cards (this/last month, window
//             total) + the monthly-spend trend chart. No tables.
//   billing → the consolidated issued invoices (Invoicing ListInvoiceSummaries), each a downloadable PDF
//             (GetInvoicePDF, resolved per row on demand). Fetched INCREMENTALLY: core keeps a keyed union of
//             invoices on disk, so each refresh only re-queries the recent months (an issued invoice is
//             immutable). Best-effort — a missing invoicing:ListInvoiceSummaries permission just leaves the tab
//             empty, it never fails.
//   usage   → the spend detail, CONSOLIDATED across the Organizations management account's linked accounts: the
//             per-service and per-linked-account breakdown tables. No chart, no rollup.
//   members → IAM Identity Center (Identity Store ListUsers): who has an SSO identity + active/suspended.
// Summary + Usage share one Cost Explorer fetch (the query cache dedupes the reads).
//
// MONEY: Cost Explorer returns amounts as USD dollar STRINGS ("123.45"), not cents — parsed straight to
// floats, no /100.

// Single source of truth for AWS settings: declare the fields once via `defineConfigSchema`, then DERIVE both the
// settings schema (the plugin's `config` below) and the typed config `collect()` reads (AwsConfig, via
// `ConfigOf`) from them — no hand-maintained parallel type, and `definePlugin` infers its `TConfig` from the
// schema. `authMode` picks the credential source: 'profile' (a named ~/.aws profile) or 'iam' (an explicit
// access-key pair); its literal `options` flow through to `AwsConfig['authMode']`. region + identityStoreId
// are shared (the latter only for the Users tab); every other field is an optional string.
export const awsConfigSchema = defineConfigSchema([
  {
    key: 'authMode',
    label: 'Authentication',
    kind: 'select',
    options: [
      { value: 'profile', label: 'AWS profile' },
      { value: 'iam', label: 'IAM access keys' }
    ],
    help: 'How to authenticate: a named profile from ~/.aws, or an explicit access-key pair.'
  },
  {
    key: 'profile',
    label: 'Profile name',
    kind: 'text',
    placeholder: 'default',
    showWhen: { field: 'authMode', equals: 'profile' },
    help: 'A named profile from ~/.aws/config. Leave blank to use the ambient credential chain.'
  },
  {
    key: 'accessKeyId',
    label: 'Access key ID',
    kind: 'secret',
    placeholder: 'AKIA…',
    showWhen: { field: 'authMode', equals: 'iam' }
  },
  {
    key: 'secretAccessKey',
    label: 'Secret access key',
    kind: 'secret',
    showWhen: { field: 'authMode', equals: 'iam' }
  },
  {
    key: 'region',
    label: 'Region',
    kind: 'text',
    placeholder: 'us-east-1',
    required: false,
    help: 'Optional. Region for Identity Center; defaults to us-east-1 when blank (Cost Explorer is always us-east-1).'
  },
  {
    key: 'identityStoreId',
    label: 'Identity Store ID',
    kind: 'text',
    placeholder: 'd-1234567890',
    help: 'Required for the Users tab. IAM Identity Center → Settings.'
  }
])

export type AwsConfig = ConfigOf<typeof awsConfigSchema>

// The billing-plane services (Cost Explorer, Invoicing, STS) are global and pinned to us-east-1 regardless of
// the configured region.
const BILLING_REGION = 'us-east-1'

// How many trailing calendar months to chart (including the current partial month).
const MONTHS_BACK = 11

// --- pure builders (fixture-tested; no AWS calls) -------------------------------------------------

// The minimal Cost Explorer row shape this plugin reads — decoupled from the @aws-sdk types so the pure
// builder is testable with plain fixtures.
export interface CeGroup {
  Keys?: string[]
  Metrics?: Record<string, { Amount?: string; Unit?: string }>
}
export interface CeResultByTime {
  TimePeriod?: { Start?: string; End?: string }
  Groups?: CeGroup[]
}

export interface AwsMonthRow {
  month: string // 'YYYY-MM'
  amount: number
}
export interface AwsServiceRow {
  service: string
  amount: number
}
export interface AwsAccountRow {
  accountId: string
  accountName: string
  amount: number
}

export interface AwsBillingReport {
  currency: string
  grandTotal: number // spend across the whole window
  thisMonth: number // current (partial) month — the live MTD
  lastMonth: number // previous full month
  byMonth: AwsMonthRow[]
  byService: AwsServiceRow[] // descending
  byAccount: AwsAccountRow[] // descending
}

// The minimal Invoicing `InvoiceSummary` shape this plugin reads — decoupled from @aws-sdk (and with the SDK's
// `Date` fields flattened to ISO strings by `fetchInvoices`) so the pure builder is testable with plain fixtures.
export interface RawInvoiceSummary {
  InvoiceId?: string
  InvoiceType?: string // 'INVOICE' | 'CREDIT_MEMO' | 'PAYMENT_RECEIPT'
  IssuedDate?: string // ISO
  DueDate?: string // ISO
  BillingPeriod?: { Month?: number; Year?: number }
  Entity?: { InvoicingEntity?: string }
  BaseCurrencyAmount?: { TotalAmount?: string; CurrencyCode?: string }
}

export interface AwsInvoiceRow {
  billingPeriod: string // 'YYYY-MM'
  invoiceId: string
  invoiceType: string
  entity: string | null
  issuedDate: string | null // 'YYYY-MM-DD'
  dueDate: string | null
  amount: number
  name: string // the downloaded PDF's basename (hidden column)
}

// The invoice list plus its billing currency — set only when it differs from the plugin's reported USD, so the
// amount column can override the stamped default for a foreign-billed payer account (all of one payer's invoices
// share one currency).
export interface AwsInvoicesReport {
  rows: AwsInvoiceRow[]
  currency?: string
}

// The raw Cost Explorer bundle Summary + Usage share — the two grouped GetCostAndUsage result sets plus the
// account-id→name map, straight off the wire. `buildBillingReport` folds it into a normalized report.
export interface AwsBillingRaw {
  serviceResults: CeResultByTime[]
  accountResults: CeResultByTime[]
  accountNames: Record<string, string>
}

const parseAmount = (raw: string | undefined): number => {
  const n = Number.parseFloat(raw ?? '')

  return Number.isFinite(n) ? n : 0
}

// UnblendedCost (Amount + Unit) off a CE group's metric bag, defensively.
const groupCost = (group: CeGroup): { amount: number; unit?: string } => {
  const metric = group.Metrics?.UnblendedCost ?? Object.values(group.Metrics ?? {})[0]

  return { amount: parseAmount(metric?.Amount), unit: metric?.Unit }
}

// Fold the two monthly GetCostAndUsage result sets (one grouped by SERVICE, one by LINKED_ACCOUNT) +
// the account-id→name map into a normalized report. Pure.
export const buildBillingReport = (
  serviceResults: CeResultByTime[],
  accountResults: CeResultByTime[],
  accountNames: Record<string, string>,
  nowMonth = currentMonthKey()
): AwsBillingReport => {
  let currency = 'USD'

  const byMonth: AwsMonthRow[] = []
  const serviceMap = new Map<string, number>()

  for (const period of serviceResults) {
    const month = (period.TimePeriod?.Start ?? '').slice(0, 7)
    let monthSum = 0

    for (const group of period.Groups ?? []) {
      const { amount, unit } = groupCost(group)

      if (unit) {
        currency = unit
      }

      monthSum += amount
      const name = group.Keys?.[0] ?? 'unknown'

      serviceMap.set(name, (serviceMap.get(name) ?? 0) + amount)
    }

    if (month) {
      byMonth.push({ month, amount: round2(monthSum) })
    }
  }

  const accountMap = new Map<string, number>()

  for (const period of accountResults) {
    for (const group of period.Groups ?? []) {
      const { amount } = groupCost(group)
      const id = group.Keys?.[0] ?? 'unknown'

      accountMap.set(id, (accountMap.get(id) ?? 0) + amount)
    }
  }

  byMonth.sort((a, b) => a.month.localeCompare(b.month))

  // "This month" is the user's current calendar month (the reporting-zone month), not Cost Explorer's last
  // bucket — CE's window is UTC, so near the month boundary its last bucket is already the next UTC month (a
  // near-$0 partial) while the user is still in the prior month. Pick that month's bar and the one before it, so
  // the headline agrees with the cross-service Overview and rolls at the user's local midnight. Fall back to the
  // last two buckets when the reporting-zone month isn't in the window (e.g. mid-month UTC and local agree).
  const curIdx = byMonth.findIndex((m) => m.month === nowMonth)
  const cur = curIdx >= 0 ? curIdx : byMonth.length - 1

  const byService: AwsServiceRow[] = [...serviceMap.entries()]
    .map(([service, amount]) => ({ service, amount: round2(amount) }))
    .sort((a, b) => b.amount - a.amount)

  const byAccount: AwsAccountRow[] = [...accountMap.entries()]
    .map(([accountId, amount]) => ({
      accountId,
      accountName: accountNames[accountId] ?? accountId,
      amount: round2(amount)
    }))
    .sort((a, b) => b.amount - a.amount)

  return {
    currency,
    grandTotal: round2(byMonth.reduce((sum, m) => sum + m.amount, 0)),
    thisMonth: byMonth[cur]?.amount ?? 0,
    lastMonth: byMonth[cur - 1]?.amount ?? 0,
    byMonth,
    byService,
    byAccount
  }
}

// Stat record row type for the billing headline (thisMonth / lastMonth / grandTotal).
interface AwsAccountStatRow {
  thisMonth: number
  lastMonth: number
  grandTotal: number
}

// Summary tab — the cross-service Overview rollup (spend.mtd): the headline stat cards (this month, last
// month, window total) + the monthly-spend trend chart (also the spark). The by-service / by-linked-account
// detail lives on Billing, not here.
export const awsSummaryResult = (r: AwsBillingReport): CapabilityResult => {
  const account = record<AwsAccountStatRow>({
    id: 'account',
    fields: [
      { key: 'thisMonth', label: 'This month', role: 'money', currency: r.currency },
      { key: 'lastMonth', label: 'Last month', role: 'money', currency: r.currency },
      { key: 'grandTotal', label: 'Window total', role: 'money', currency: r.currency }
    ],
    value: { thisMonth: r.thisMonth, lastMonth: r.lastMonth, grandTotal: r.grandTotal }
  })

  // Cost Explorer granularity is MONTHLY (GetCostAndUsageCommand uses Granularity: 'MONTHLY'). The series
  // includes the current partial month as its last bar, so it doubles as the live MTD.
  const monthly = table<AwsMonthRow>({
    id: 'monthly',
    columns: [
      { key: 'month', label: 'Month', role: 'timestamp' },
      { key: 'amount', label: 'Spend', role: 'money', currency: r.currency }
    ],
    rows: r.byMonth
  })

  const summary = monthly.summary({
    section: 'spend',
    label: 'This month',
    value: r.thisMonth,
    role: 'money',
    currency: r.currency,
    // Cost Explorer's consolidated cloud spend accrues live over the month.
    basis: 'accrued',
    x: 'month',
    y: 'amount'
  })

  return capabilityResult({
    sections: [
      account.stat(),
      monthly.timeseries({ x: 'month', y: 'amount', granularity: 'monthly', title: 'Monthly spend' })
    ],
    summaries: [summary]
  })
}

// Fold the issued-invoice summaries into a normalized, newest-first list + the payer's billing currency. Pure.
// The billing period comes from the structured Month/Year (always present on an AWS invoice); the issued month is
// a fallback. Currency is reported only when it isn't the plugin's USD default, so the amount column overrides it.
export const buildInvoices = (raw: RawInvoiceSummary[]): AwsInvoicesReport => {
  const rows: AwsInvoiceRow[] = raw
    .map((s) => {
      const issuedDate = isoDay(s.IssuedDate) ?? null
      const billingPeriod =
        s.BillingPeriod?.Year && s.BillingPeriod?.Month
          ? `${s.BillingPeriod.Year}-${String(s.BillingPeriod.Month).padStart(2, '0')}`
          : (issuedDate ?? '').slice(0, 7)

      return {
        billingPeriod,
        invoiceId: s.InvoiceId ?? '',
        invoiceType: s.InvoiceType ?? 'INVOICE',
        entity: s.Entity?.InvoicingEntity ?? null,
        issuedDate,
        dueDate: isoDay(s.DueDate) ?? null,
        amount: parseAmount(s.BaseCurrencyAmount?.TotalAmount),
        name: `AWS ${billingPeriod} invoice ${s.InvoiceId ?? ''}`.trim()
      }
    })
    .sort(
      (a, b) => b.billingPeriod.localeCompare(a.billingPeriod) || (b.issuedDate ?? '').localeCompare(a.issuedDate ?? '')
    )

  const code = raw.find((s) => s.BaseCurrencyAmount?.CurrencyCode)?.BaseCurrencyAmount?.CurrencyCode

  return { rows, currency: code && code !== 'USD' ? code : undefined }
}

// Billing tab — the consolidated issued-invoice list, newest first, each a downloadable PDF (the `files`
// descriptor → per-row Download + a Size column; the bytes come from `fetchAwsInvoicePdf` on demand). A receipts
// table: Period · Invoice · Type · Entity · Issued · Due · Amount. No rollup summary — Summary owns the spend
// dollars; this is the durable record of each bill. Keyed by invoiceId so the incremental ledger accumulates.
export const awsBillingResult = (raw: RawInvoiceSummary[]): CapabilityResult => {
  const { rows, currency } = buildInvoices(raw)

  const invoices = table<AwsInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'billingPeriod', label: 'Period', role: 'timestamp' },
      { key: 'invoiceId', label: 'Invoice', role: 'identifier' },
      { key: 'invoiceType', label: 'Type', role: 'category' },
      { key: 'entity', label: 'Entity', role: 'text', truncate: true },
      { key: 'issuedDate', label: 'Issued', role: 'timestamp' },
      { key: 'dueDate', label: 'Due', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money', currency },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows,
    key: 'invoiceId'
  }).fileTable({ title: 'Invoices', name: 'name', source: { fetch: true }, ext: 'pdf', category: 'Invoices' })

  return capabilityResult({ sections: [invoices] })
}

// Usage tab — the spend detail (the headline cards + chart + rollup live on Summary): the per-service and
// per-linked-account breakdown tables, descending by spend.
export const awsUsageResult = (r: AwsBillingReport): CapabilityResult => {
  const byService = table<AwsServiceRow>({
    id: 'byService',
    columns: [
      { key: 'service', label: 'Service', role: 'label' },
      { key: 'amount', label: 'Spend', role: 'money', currency: r.currency }
    ],
    rows: r.byService
  })

  const byAccount = table<AwsAccountRow>({
    id: 'byAccount',
    columns: [
      { key: 'accountName', label: 'Account', role: 'label' },
      { key: 'accountId', label: 'ID', role: 'identifier' },
      { key: 'amount', label: 'Spend', role: 'money', currency: r.currency }
    ],
    rows: r.byAccount
  })

  return capabilityResult({
    sections: [byService.table({ title: 'Spend by service' }), byAccount.table({ title: 'Spend by linked account' })]
  })
}

// The minimal Identity Store user shape this plugin reads — decoupled from @aws-sdk for testability.
export interface IdentityUserLike {
  UserId?: string
  UserName?: string
  DisplayName?: string
  Name?: { GivenName?: string; FamilyName?: string }
  Emails?: Array<{ Value?: string; Primary?: boolean }>
  UserStatus?: string
}

export interface AwsMember {
  id: string
  name: string | null
  email: string | null
  status: string // 'active' | 'suspended'
  username: string | null
}

export const mapIdentityUser = (u: IdentityUserLike): AwsMember => {
  const primaryEmail = u.Emails?.find((e) => e.Primary)?.Value ?? u.Emails?.[0]?.Value ?? null
  const fullName = [u.Name?.GivenName, u.Name?.FamilyName].filter(Boolean).join(' ')

  return {
    id: u.UserId ?? '',
    name: u.DisplayName ?? (fullName || null),
    email: primaryEmail,
    status: u.UserStatus === 'DISABLED' ? 'suspended' : 'active',
    username: u.UserName ?? null
  }
}

// Row type for the Identity Center users table (mapped subset of AwsMember — id is not displayed).
interface AwsMemberRow {
  name: string | null
  email: string | null
  status: string
  username: string | null
}

// Identity Center has no per-user role attribute (access flows from group/permission-set assignments),
// so the meaningful state is active vs suspended — surfaced as a status badge alongside name/email/username.
export const awsMembersResult = (members: AwsMember[]): CapabilityResult => {
  const members_ = table<AwsMemberRow>({
    id: 'members',
    columns: [
      { key: 'name', label: 'Name', role: 'label' },
      { key: 'email', label: 'Email', role: 'identifier' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'username', label: 'Username', role: 'text' }
    ],
    rows: members.map((m) => ({ name: m.name, email: m.email, status: m.status, username: m.username }))
  })

  return capabilityResult({ sections: [members_.table({ title: 'Identity Center users' })] })
}

// --- AWS SDK wiring (thin; the credential resolution is the SDK's, not Butin's) -------------------

interface AwsClientConfig {
  region: string
  profile?: string
  credentials?: { accessKeyId: string; secretAccessKey: string }
}

// Build the SDK client config from the chosen authMode: 'iam' → the explicit key pair; 'profile' → the
// named profile (or, blank, the SDK's ambient default chain — AWS_* env vars / default shared profile).
// With authMode unset, falls back to explicit keys when present, else the ambient chain.
export const clientConfig = (cfg: AwsConfig, region: string): AwsClientConfig => {
  const hasKeys = Boolean(cfg.accessKeyId && cfg.secretAccessKey)

  if (cfg.authMode === 'iam' && hasKeys) {
    return {
      region,
      credentials: { accessKeyId: cfg.accessKeyId as string, secretAccessKey: cfg.secretAccessKey as string }
    }
  }

  if (cfg.profile) {
    return { region, profile: cfg.profile }
  }

  if (hasKeys) {
    return {
      region,
      credentials: { accessKeyId: cfg.accessKeyId as string, secretAccessKey: cfg.secretAccessKey as string }
    }
  }

  return { region }
}

const billingPeriod = (now: Date): { start: string; end: string } => {
  const thisMonth = DateTime.fromJSDate(now, { zone: 'utc' }).startOf('month')

  // [first-of-month MONTHS_BACK ago, first-of-next-month) — CE's End is exclusive, so this yields
  // MONTHS_BACK+1 monthly buckets including the current partial month.
  return {
    start: thisMonth.minus({ months: MONTHS_BACK }).toFormat('yyyy-MM-dd'),
    end: thisMonth.plus({ months: 1 }).toFormat('yyyy-MM-dd')
  }
}

const costByMonth = async (
  client: CostExplorerClient,
  period: { start: string; end: string },
  dimension: string
): Promise<CeResultByTime[]> => {
  const out = await client.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: period.start, End: period.end },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: dimension }]
    })
  )

  return out.ResultsByTime ?? []
}

// account id → human name (CE returns it in Attributes.description). Best-effort: an empty map on
// failure (no Organizations / missing permission) so the report still shows bare ids.
const linkedAccountNames = async (
  client: CostExplorerClient,
  period: { start: string; end: string }
): Promise<Record<string, string>> => {
  const map: Record<string, string> = {}

  try {
    const out = await client.send(
      new GetDimensionValuesCommand({
        TimePeriod: { Start: period.start, End: period.end },
        Dimension: 'LINKED_ACCOUNT'
      })
    )

    for (const v of out.DimensionValues ?? []) {
      if (v.Value) {
        map[v.Value] = v.Attributes?.description ?? v.Value
      }
    }
  } catch {
    // permission gap or no Organizations — fall back to bare ids
  }

  return map
}

type Log = CollectContext<AwsConfig>['log']

// The payer/management account id, resolved from the active credentials (STS GetCallerIdentity needs no
// permission). Null on failure so the invoice fetch simply yields nothing.
const callerAccountId = async (cfg: AwsConfig, log: Log): Promise<string | null> => {
  try {
    const out = await new STSClient(clientConfig(cfg, BILLING_REGION)).send(new GetCallerIdentityCommand({}))

    return out.Account ?? null
  } catch (err) {
    log('aws: could not resolve account id (STS GetCallerIdentity failed) — skipping invoices', {
      error: (err as Error).message
    })

    return null
  }
}

// The trailing billing periods (`{ year, month }`) to list invoices for — the same span as the spend chart,
// oldest first.
const billingMonths = (now: Date): Array<{ year: number; month: number }> => {
  const thisMonth = DateTime.fromJSDate(now, { zone: 'utc' }).startOf('month')

  return Array.from({ length: MONTHS_BACK + 1 }, (_, i) => {
    const m = thisMonth.minus({ months: MONTHS_BACK - i })

    return { year: m.year, month: m.month }
  })
}

// The issued invoices for one billing period, paginated. A month with no invoice returns an empty list.
const invoicesForMonth = async (
  client: InvoicingClient,
  accountId: string,
  period: { year: number; month: number }
): Promise<InvoiceSummary[]> => {
  const out: InvoiceSummary[] = []
  let nextToken: string | undefined

  do {
    const page = await client.send(
      new ListInvoiceSummariesCommand({
        Selector: { ResourceType: 'ACCOUNT_ID', Value: accountId },
        Filter: { BillingPeriod: { Month: period.month, Year: period.year } },
        NextToken: nextToken
      })
    )

    out.push(...(page.InvoiceSummaries ?? []))
    nextToken = page.NextToken
  } while (nextToken)

  return out
}

// The billing periods to query this fetch. `since` (the incremental watermark, a 'YYYY-MM-DD') trims the full
// window to the months that could still hold new or updated invoices — an invoice for billing month M is issued
// in M or early M+1, so include the month before `since`'s month. No watermark (first run / forced) → the full
// window.
const monthsToFetch = (since: string | undefined, now: Date): Array<{ year: number; month: number }> => {
  const all = billingMonths(now)

  if (!since) {
    return all
  }

  const cutoff = DateTime.fromISO(since, { zone: 'utc' }).minus({ months: 1 }).toFormat('yyyy-MM')

  return all.filter(({ year, month }) => `${year}-${String(month).padStart(2, '0')}` >= cutoff)
}

// The incremental `fetch` for the Invoices tab: the consolidated issued invoices keyed to the payer account.
// ListInvoiceSummaries caps a query at one billing period, so each month in the window is fetched separately and
// merged; core keeps the keyed union on disk (by InvoiceId), so a refresh only re-queries the recent months
// (`ctx.since`) yet `build` still renders every invoice ever fetched. Best-effort: a failed month is logged
// (once) but doesn't blank the others, and a total-count line makes an empty table diagnosable. The SDK's `Date`
// fields are flattened to ISO strings so the pure `buildInvoices` stays fixture-testable.
const fetchInvoices = async (ctx: CollectContext<AwsConfig>): Promise<RawInvoiceSummary[]> => {
  const { config: cfg, log, since } = ctx
  const accountId = await callerAccountId(cfg, log)

  if (!accountId) {
    return []
  }

  const client = new InvoicingClient(clientConfig(cfg, BILLING_REGION))
  const months = monthsToFetch(since, new Date())
  const results = await Promise.allSettled(months.map((m) => invoicesForMonth(client, accountId, m)))
  const summaries = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  const failure = results.find((r) => r.status === 'rejected')

  if (failure) {
    // no invoicing:ListInvoiceSummaries permission, wrong partition, or a rejected filter — surface why the
    // list may be short. The AWS error name + message go in the line itself (the `extra` isn't always shown).
    const e = failure.reason as Error

    log(
      `aws: ListInvoiceSummaries failed for one or more months — the invoice list may be incomplete: ${e.name}: ${e.message}`,
      { error: e.message }
    )
  }

  log(`aws: fetched ${summaries.length} invoice(s) across ${months.length} month(s) for account ${accountId}`)

  return summaries.map((s) => ({
    InvoiceId: s.InvoiceId,
    InvoiceType: s.InvoiceType,
    IssuedDate: s.IssuedDate?.toISOString(),
    DueDate: s.DueDate?.toISOString(),
    BillingPeriod: s.BillingPeriod,
    Entity: s.Entity,
    BaseCurrencyAmount: s.BaseCurrencyAmount
  }))
}

// One invoice's PDF, resolved on demand (never up front): GetInvoicePDF mints a short-lived signed DocumentUrl
// for the row's InvoiceId, then the bytes are downloaded and verified to really be a PDF. Each step logs to the
// Logs view so a failed download says why (no id / no URL / not a PDF). `invoicing:GetInvoicePDF` is a distinct
// permission from ListInvoiceSummaries, so a row can list yet fail to download if only the list is granted.
const fetchAwsInvoicePdf = async (
  ctx: CollectContext<AwsConfig>,
  row: Record<string, unknown>
): Promise<Uint8Array> => {
  const invoiceId = String(row.invoiceId ?? '')

  if (!invoiceId) {
    throw new Error('AWS: no invoice id on this row')
  }

  const client = new InvoicingClient(clientConfig(ctx.config, BILLING_REGION))
  const out = await client.send(new GetInvoicePDFCommand({ InvoiceId: invoiceId }))
  const url = out.InvoicePDF?.DocumentUrl

  if (!url) {
    throw new Error(`AWS ${invoiceId}: GetInvoicePDF returned no document URL`)
  }

  const res = await ctx.client.request<ArrayBuffer>({
    url,
    responseType: 'arraybuffer',
    headers: { Accept: 'application/pdf,*/*' }
  })
  const bytes = new Uint8Array(res.data)
  // `%PDF` magic bytes — a non-PDF body (an expired-URL error page) must fail loudly, not save a corrupt file.
  const isPdf = bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46

  ctx.log(`aws: downloaded invoice ${invoiceId} (${bytes.length}b, pdf=${isPdf})`)

  if (!isPdf) {
    throw new Error(`AWS ${invoiceId}: invoice download wasn't a PDF (${bytes.length}b)`)
  }

  return bytes
}

// Summary + Usage share this one Cost Explorer fetch (the query cache dedupes the underlying reads). Returns
// the raw CE bundle; the pure `buildBillingReport` is what normalizes it.
const fetchAwsBilling = async (ctx: CollectContext<AwsConfig>): Promise<AwsBillingRaw> => {
  const client = new CostExplorerClient(clientConfig(ctx.config, BILLING_REGION))
  const period = billingPeriod(new Date())
  const [serviceResults, accountResults, accountNames] = await Promise.all([
    costByMonth(client, period, 'SERVICE'),
    costByMonth(client, period, 'LINKED_ACCOUNT'),
    linkedAccountNames(client, period)
  ])

  return { serviceResults, accountResults, accountNames }
}

// Compose the raw bundle into the report once, then feed both result builders.
const billingReportOf = (raw: AwsBillingRaw): AwsBillingReport =>
  buildBillingReport(raw.serviceResults, raw.accountResults, raw.accountNames)

// Returns the raw Identity Store users straight off the wire; the pure `mapIdentityUser` is the transform.
const fetchIdentityUsers = async (ctx: CollectContext<AwsConfig>): Promise<IdentityUserLike[]> => {
  if (!ctx.config.identityStoreId) {
    throw new Error('Set your AWS Identity Store ID (d-xxxxxxxxxx) in Settings to list Identity Center users.')
  }

  const client = new IdentitystoreClient(clientConfig(ctx.config, ctx.config.region || BILLING_REGION))
  const users: IdentityStoreUser[] = []
  let nextToken: string | undefined

  do {
    const out = await client.send(
      new ListUsersCommand({ IdentityStoreId: ctx.config.identityStoreId, NextToken: nextToken })
    )

    users.push(...(out.Users ?? []))
    nextToken = out.NextToken
  } while (nextToken)

  return users
}

// Cheap auth check: one Cost Explorer call. Validates the durable credentials both capabilities share.
const probe = async (ctx: CollectContext<AwsConfig>): Promise<void> => {
  const client = new CostExplorerClient(clientConfig(ctx.config, BILLING_REGION))
  const period = billingPeriod(new Date())

  await client.send(
    new GetDimensionValuesCommand({ TimePeriod: { Start: period.start, End: period.end }, Dimension: 'SERVICE' })
  )
}

export const awsPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'aws',
    name: 'AWS',
    vendor: 'Amazon Web Services',
    category: 'cloud',
    description: 'AWS Cost Explorer spend, issued invoices, and IAM Identity Center users.',
    color: '#FF9900',
    homepage: 'https://aws.amazon.com',
    dashboardUrl: 'https://console.aws.amazon.com'
  },
  auth: { kind: 'external' },
  // `awsConfigSchema` (from `defineConfigSchema`) is both the settings schema AND the source `definePlugin` infers
  // `AwsConfig` from — so `ctx.config` below is typed as AwsConfig with no generic and no annotation.
  config: awsConfigSchema,
  // Summary + Usage both call fetchAwsBilling; the core query cache dedupes the underlying Cost Explorer reads.
  // Billing (the invoices) fetches incrementally — core keeps a keyed union of invoices on disk (by InvoiceId) —
  // and its rows download as PDFs via fetchFile.
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchAwsBilling,
      build: (raw) => awsSummaryResult(billingReportOf(raw)),
      sample: sampleAwsBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchInvoices,
      build: awsBillingResult,
      sample: sampleAwsInvoices,
      fetchFile: fetchAwsInvoicePdf,
      // An issued invoice is immutable; core unions by InvoiceId and re-fetches only the trailing window
      // (IssuedDate watermark) so a refresh queries a couple of months, not the full year.
      incremental: { id: 'InvoiceId', timestamp: 'IssuedDate' }
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchAwsBilling,
      build: (raw) => awsUsageResult(billingReportOf(raw)),
      sample: sampleAwsBilling
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchIdentityUsers,
      build: (raw) => awsMembersResult(raw.map((u) => mapIdentityUser(u))),
      sample: sampleAwsMembers
    })
  ],
  probe
})

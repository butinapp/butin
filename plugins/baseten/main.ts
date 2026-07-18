import { defineCapability, definePlugin, type CollectContext } from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import {
  billing,
  blocks,
  keys,
  members,
  type ApiKeysInput,
  type BillingInvoiceInput,
  type MembersInput
} from '@butinapp/sdk/presets'
import { centsToMajor, currentMonthKey, isoDay, parseDecimalAmount, round2 } from '@butinapp/sdk/util'

import { sampleBasetenBilling, sampleBasetenKeys, sampleBasetenMembers, sampleBasetenUsage } from './sample.js'

// Baseten reads from app.baseten.co's dashboard GraphQL (`/graphql/?opName=<name>`) against the captured
// dashboard session cookie — Baseten exposes member/billing/usage/key data only through the dashboard, not the
// public inference API key. app.baseten.co sits behind AWS WAF (a token cookie), NOT Cloudflare, so Node's TLS
// is accepted → `node` transport (axios). The dashboard XHR also sends `Origin: https://app.baseten.co` on every
// POST, a header forbidden on Electron net.request, so node transport is required either way.
//
// MONEY UNITS DIFFER PER FIELD:
//   invoices[].amount, monetary_credit_*        → CENTS  → centsToMajor
//   currentNetSpend.*Dollars, usage `cost`      → DOLLAR strings → parseDecimalAmount
// `minutes` / `inference_requests` are plain counts (requests arrive as strings).

// ── constants ───────────────────────────────────────────────────────────────────────

const ORIGIN = 'https://app.baseten.co'

const INVOICES_QUERY = `query Invoices {
  invoices {
    created
    periodEnd: period_end
    periodStart: period_start
    amount
    status
    pdfLink: pdf_link
    __typename
  }
}`

const PAYMENT_METHOD_QUERY = `query PaymentMethod {
  stripePaymentMethod: stripe_payment_method {
    brand
    last4
    paymentMethodTitle: payment_method_title
    paymentMethodSubtitle: payment_method_subtitle
    __typename
  }
}`

const ORG_BUDGET_QUERY = `query OrgBudget {
  organization {
    id
    currentNetSpend: current_net_spend {
      netSpendDollars: net_spend_dollars
      creditsUsedDollars: credits_used_dollars
      __typename
    }
    __typename
  }
}`

const MONETARY_CREDITS_QUERY = `query MonetaryCredits {
  organization {
    id
    creditGranted: monetary_credit_granted
    creditBalance: monetary_credit_balance
    paymentMethodStatus: payment_method_status
    __typename
  }
}`

const BILLING_PERIODS_QUERY = `query AvailableBillingPeriods {
  availableBillingPeriods: available_billing_periods {
    start
    end
    isCurrent: is_current
    __typename
  }
}`

const USAGE_QUERY = `query UsageSummaryForDateRange($startDate: DateTime!, $endDate: DateTime!, $usageTypes: [UsageType!], $timezoneName: String) {
  usageSummaryForDateRange: usage_summary_for_date_range(
    start_date: $startDate
    end_date: $endDate
    usage_types: $usageTypes
    timezone_name: $timezoneName
  ) {
    dedicatedUsage: dedicated_usage {
      currentPeriodTotal: current_period_total
      startDate: start_date
      endDate: end_date
      productCategoryUsages: product_category_usages {
        category
        items {
          minutes
          cost
          requests: inference_requests
          usagePerDay: usage_per_day {
            date
            cost
            requests: inference_requests
            __typename
          }
          entity {
            ... on ModelVersionType {
              name
              oracle {
                ... on ModelType {
                  name
                  __typename
                }
                __typename
              }
              __typename
            }
            ... on ModelVersionTombstone {
              modelName: model_name
              __typename
            }
            __typename
          }
          billingEntity: billing_entity {
            instanceType: instance_type
            environmentName: environment_name
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    trainingUsage: training_usage {
      minutes
      cost
      __typename
    }
    __typename
  }
}`

const ORG_KEYS_QUERY = `query OverviewOrgApiKeys {
  orgApiKeys: org_api_keys {
    id
    revoked
    __typename
  }
}`

const USER_KEYS_QUERY = `query OverviewUserApiKeys {
  userApiKeys: user_api_keys {
    id
    revoked
    __typename
  }
}`

const USERS_QUERY = `query Users {
  users {
    id
    name
    email
    username
    roleName: role_name
    status
    __typename
  }
}`

const INVITED_USERS_QUERY = `query InvitedUsers {
  users: invited_users {
    id
    email
    roleName: role_name
    invited
    __typename
  }
}`

// ── types ─────────────────────────────────────────────────────────────────────────

// billing wire shapes
interface RawInvoice {
  created?: string | null
  periodStart?: string | null
  periodEnd?: string | null
  /** Grand total in CENTS. */
  amount?: number | null
  /** e.g. 'PAID' | 'ISSUED' | 'VOID'. */
  status?: string | null
  pdfLink?: string | null
}
interface RawPaymentMethod {
  brand?: string | null
  last4?: string | null
  paymentMethodTitle?: string | null
  paymentMethodSubtitle?: string | null
}
interface RawOrgBudget {
  organization?: {
    currentNetSpend?: { netSpendDollars?: string | null; creditsUsedDollars?: string | null } | null
  } | null
}
interface RawMonetaryCredits {
  organization?: {
    creditGranted?: number | null
    creditBalance?: number | null
    paymentMethodStatus?: string | null
  } | null
}

/** The four billing queries the Summary + Billing tabs share. */
export interface BasetenBillingRaw {
  invoices: RawInvoice[]
  paymentMethod: RawPaymentMethod | null
  orgBudget: RawOrgBudget
  credits: RawMonetaryCredits
}

export interface BasetenInvoice extends BillingInvoiceInput {
  /** Billing period start, 'YYYY-MM-DD'. */
  periodStart?: string
  /** Billing period end, 'YYYY-MM-DD'. */
  periodEnd?: string
}
interface BasetenPaymentMethod {
  brand: string
  last4: string
  title: string
  subtitle: string
}

export interface BasetenBillingReport {
  invoices: BasetenInvoice[]
  /** Net spend in the current (in-progress) billing period, USD dollars. */
  currentNetSpend: number
  /** Credits applied in the current period, USD dollars. */
  currentCreditsUsed: number
  /** Most recent invoice total, USD dollars. */
  latestAmount: number
  /** Granted monetary credit, USD dollars. */
  creditGranted: number
  /** Remaining monetary credit balance, USD dollars. */
  creditBalance: number
  paymentMethodStatus: string
  paymentMethod: BasetenPaymentMethod | null
}

// usage wire shapes
interface RawBillingPeriod {
  start?: string | null
  end?: string | null
  isCurrent?: boolean | null
}
interface RawUsagePerDay {
  date?: string | null
  /** DOLLARS string. */
  cost?: string | null
  requests?: string | null
}
interface RawEntity {
  name?: string | null
  modelName?: string | null
  oracle?: { name?: string | null } | null
}
interface RawBillItem {
  minutes?: number | null
  /** DOLLARS string. */
  cost?: string | null
  requests?: string | null
  usagePerDay?: RawUsagePerDay[] | null
  entity?: RawEntity | null
  billingEntity?: { instanceType?: string | null; environmentName?: string | null } | null
}
interface RawProductCategoryUsage {
  category?: string | null
  items?: RawBillItem[] | null
}
interface RawDedicatedUsage {
  /** DOLLARS string. */
  currentPeriodTotal?: string | null
  productCategoryUsages?: RawProductCategoryUsage[] | null
  startDate?: string | null
  endDate?: string | null
}
interface RawTrainingUsage {
  minutes?: string | number | null
  /** DOLLARS string. */
  cost?: string | null
}

export interface RawUsageSummary {
  usageSummaryForDateRange?: {
    dedicatedUsage?: RawDedicatedUsage | null
    trainingUsage?: RawTrainingUsage | null
  } | null
}

/** The usage summary plus the billing period it was scoped to (discovered before the usage query). */
export interface BasetenUsageRaw {
  usage: RawUsageSummary
  period: { start: string; end: string }
}

export interface BasetenModelUsageRow {
  category: string
  model: string
  instanceType: string
  environment: string
  minutes: number
  requests: number
  /** USD dollars. */
  cost: number
}
interface BasetenDailyCost {
  date: string
  /** USD dollars. */
  cost: number
  requests: number
}

export interface BasetenUsageReport {
  periodStart: string
  periodEnd: string
  /** Dedicated (model-serving) spend for the period, USD dollars. */
  dedicatedTotal: number
  totalMinutes: number
  totalRequests: number
  /** Training-job spend for the period, USD dollars. */
  trainingCost: number
  /** Per-model breakdown, costliest first. */
  models: BasetenModelUsageRow[]
  /** Aggregate cost per day across all models. */
  daily: BasetenDailyCost[]
}

// keys wire shape
interface RawApiKey {
  id?: string | null
  revoked?: boolean | null
}

/** Org-scoped + user-scoped key lists (the two key queries). */
export interface BasetenKeysRaw {
  orgKeys: RawApiKey[]
  userKeys: RawApiKey[]
}

// members wire shapes
interface RawBasetenUser {
  id: string
  name?: string | null
  email: string
  username?: string | null
  roleName?: string | null
  status?: string | null
}
interface RawInvitedUser {
  id: string
  email: string
  roleName?: string | null
  invited?: boolean | null
}

/** The org roster plus pending invites (the two user queries). */
export interface BasetenMembersRaw {
  users: RawBasetenUser[]
  invited: RawInvitedUser[]
}

// ── GraphQL transport ──────────────────────────────────────────────────────────────

// A dashboard GraphQL `errors` payload → the Error to throw. Baseten's dashboard runs on WorkOS with
// short-lived tokens, so an EXPIRED session comes back as an HTTP-200 GraphQL error ("The user does not have
// the authorization to perform the request"), never a 401. Tag that signature `status: 401` so core clears the
// dead session and the UI prompts Reconnect — instead of a misleading "permission" error on a service that
// still reads "connected". A non-auth GraphQL error (a bad field, a server fault) stays status-less.
export const basetenGraphqlError = (opName: string, messages: string[]): Error & { status?: number } => {
  const message = messages.join('; ')
  const err = new Error(`[baseten] ${opName} failed: ${message}`) as Error & { status?: number }

  if (/authoriz|authentic/i.test(message)) {
    err.status = 401
  }

  return err
}

// The dashboard calls `POST /graphql/?opName=<name>` with an `{ operationName, variables, query }` body — the
// built-in client.graphql sends only `{ query, variables }` and doesn't unwrap the envelope, so post directly.
// `timeout` raises the per-call ceiling for the wide usage aggregation, which the dashboard itself paginates.
const basetenGraphql = async <T>(
  ctx: CollectContext,
  opName: string,
  query: string,
  variables: Record<string, unknown> = {},
  timeout?: number
): Promise<T> => {
  const res = await ctx.client
    .request<{ data?: T; errors?: Array<{ message?: string }> }>({
      url: `${ORIGIN}/graphql/?opName=${opName}`,
      method: 'POST',
      body: { operationName: opName, variables, query },
      timeout
    })
    .then((r) => r.data)

  if (res.errors?.length) {
    throw basetenGraphqlError(
      opName,
      res.errors.map((e) => e.message ?? '')
    )
  }

  if (!res.data) {
    throw new Error(`[baseten] ${opName} returned no data`)
  }

  return res.data
}

// ── billing: invoice history + current-period net spend + payment method + credits ──────

// Raw dashboard responses → the normalized USD billing report.
export const buildBasetenBillingReport = (
  rawInvoices: RawInvoice[],
  paymentMethod: RawPaymentMethod | null,
  orgBudget: RawOrgBudget,
  credits: RawMonetaryCredits
): BasetenBillingReport => {
  const invoices: BasetenInvoice[] = (rawInvoices ?? []).map((inv) => ({
    // Date by period_end, not `created`: Baseten's invoices carry created/period_start ~2 months before
    // period_end (overlapping 2-month periods), and the dashboard dates each invoice by period_end — bucketing
    // by `created` books spend ~2 months early. Fall back to created.
    date: isoDay(inv.periodEnd) ?? isoDay(inv.created),
    status: (inv.status ?? 'unknown').toLowerCase(),
    amount: centsToMajor(inv.amount ?? 0),
    periodStart: isoDay(inv.periodStart),
    periodEnd: isoDay(inv.periodEnd),
    pdfUrl: inv.pdfLink ?? null,
    hostedUrl: inv.pdfLink ?? null
  }))

  // Newest-first so latestAmount and the table default agree.
  invoices.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

  const netSpend = orgBudget.organization?.currentNetSpend
  const org = credits.organization

  const pm: BasetenPaymentMethod | null = paymentMethod
    ? {
        brand: paymentMethod.brand ?? 'unknown',
        last4: paymentMethod.last4 ?? '',
        title: paymentMethod.paymentMethodTitle ?? '',
        subtitle: paymentMethod.paymentMethodSubtitle ?? ''
      }
    : null

  return {
    invoices,
    currentNetSpend: parseDecimalAmount(netSpend?.netSpendDollars ?? undefined),
    currentCreditsUsed: parseDecimalAmount(netSpend?.creditsUsedDollars ?? undefined),
    latestAmount: invoices[0]?.amount ?? 0,
    creditGranted: centsToMajor(org?.creditGranted ?? 0),
    creditBalance: centsToMajor(org?.creditBalance ?? 0),
    paymentMethodStatus: org?.paymentMethodStatus ?? 'unknown',
    paymentMethod: pm
  }
}

// Summary tab — its spend.mtd summary is what the cross-service Overview rolls up.
export const buildBasetenSummaryResult = (report: BasetenBillingReport): CapabilityResult =>
  billing.summary({
    currentMtd: report.currentNetSpend,
    currentMtdLabel: 'Current period',
    // Net usage spend accruing live over the open period.
    mtdBasis: 'accrued',
    // No "Δ vs last month": currentNetSpend is the live open period, while the chart bars are overlapping
    // ~2-month invoices dated by period_end, so the comparison is meaningless.
    showDelta: false,
    // Drop the invoice whose period_end lands in the open month — it's a mid-flight ~2-month total that would
    // dwarf the month, so leave that bar for the live currentNetSpend accrual (seeded via backfill). Settled
    // past-month invoices stay. The invoiceCount stat below still counts every invoice.
    invoices: report.invoices.filter((i) => !i.date || i.date.slice(0, 7) !== currentMonthKey()),
    stats: [
      { key: 'creditBalance', label: 'Credit balance', role: 'money', value: report.creditBalance },
      { key: 'invoiceCount', label: 'Invoices', role: 'count', value: report.invoices.length }
    ]
  })

// Billing tab — invoice history + credits + payment card, not the Overview rollup.

interface BasetenInvoiceRow {
  // Hidden — the Orb invoice id (the stable path of the invoice URL, minus its rotating token) rides as the
  // ledger key. Baseten reissues several invoices on the same period_end date with identical amounts, so
  // date/amount can't tell them apart; the invoice URL's path is each one's unique identity.
  id: string
  date: string | null
  amount: number
  status: string
  pdfUrl: string | null
  // Hidden — carried for the download filename, not displayed.
  name: string
}

interface BasetenCreditsRow {
  currentNetSpend: number
  currentCreditsUsed: number
  creditBalance: number
  creditGranted: number
  paymentMethodStatus: string
}

interface BasetenPaymentMethodRow {
  brand: string
  last4: string
  title: string
}

export const buildBasetenBillingTab = (report: BasetenBillingReport): CapabilityResult => {
  const invoices = table<BasetenInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'pdfUrl', label: 'PDF', role: 'url' },
      { key: 'name', role: 'label', hidden: true },
      { key: 'id', role: 'identifier', hidden: true }
    ],
    rows: report.invoices.map((i, idx) => {
      const url = i.pdfUrl ?? i.hostedUrl ?? null

      return {
        // The stable invoice-URL path (token stripped) is the Orb invoice id; a per-row synthetic backs the rare gap.
        id: url ? url.split('?')[0] : `inv-${idx}`,
        date: i.date ?? null,
        amount: i.amount,
        status: i.status,
        pdfUrl: url,
        name: `Invoice ${i.date ?? 'unknown'}`
      }
    }),
    // The invoice-URL id is each invoice's stable identity — key it so an invoice accumulates history
    // (an open invoice's status flips to paid over time) past the fetch window.
    key: 'id'
  })

  const credits = record<BasetenCreditsRow>({
    id: 'credits',
    fields: [
      { key: 'currentNetSpend', label: 'Net spend (period)', role: 'money' },
      { key: 'currentCreditsUsed', label: 'Credits used (period)', role: 'money' },
      { key: 'creditBalance', label: 'Credit balance', role: 'money' },
      { key: 'creditGranted', label: 'Credit granted', role: 'money' },
      { key: 'paymentMethodStatus', label: 'Payment status', role: 'status' }
    ],
    value: {
      currentNetSpend: report.currentNetSpend,
      currentCreditsUsed: report.currentCreditsUsed,
      creditBalance: report.creditBalance,
      creditGranted: report.creditGranted,
      paymentMethodStatus: report.paymentMethodStatus
    }
  })

  const pm = report.paymentMethod
    ? record<BasetenPaymentMethodRow>({
        id: 'paymentMethod',
        fields: [
          { key: 'brand', label: 'Card', role: 'label' },
          { key: 'last4', label: 'Last 4', role: 'label' },
          { key: 'title', label: 'Title', role: 'label' }
        ],
        value: {
          brand: report.paymentMethod.brand,
          last4: report.paymentMethod.last4,
          title: report.paymentMethod.title
        }
      })
    : null

  // Records first, the downloadable invoice table last — so the small payment-method card doesn't dangle below
  // the invoice list's download footer.
  return capabilityResult({
    sections: [
      credits.keyvalue({ title: 'Credits & spend' }),
      pm?.keyvalue({ title: 'Payment method' }),
      invoices.fileTable({
        title: 'Invoices',
        name: 'name',
        source: { url: 'pdfUrl' },
        ext: 'pdf',
        category: 'Invoices'
      })
    ]
  })
}

// Summary + Billing share the same four billing queries; both capabilities fetch this raw bundle. The core
// query cache dedupes the underlying reads across the two runs, so each endpoint is fetched once per refresh.
const fetchBasetenBilling = async (ctx: CollectContext): Promise<BasetenBillingRaw> => {
  const [invoices, payment, orgBudget, credits] = await Promise.all([
    basetenGraphql<{ invoices: RawInvoice[] }>(ctx, 'Invoices', INVOICES_QUERY),
    basetenGraphql<{ stripePaymentMethod: RawPaymentMethod | null }>(ctx, 'PaymentMethod', PAYMENT_METHOD_QUERY).catch(
      () => ({ stripePaymentMethod: null })
    ),
    basetenGraphql<RawOrgBudget>(ctx, 'OrgBudget', ORG_BUDGET_QUERY).catch(() => ({}) as RawOrgBudget),
    basetenGraphql<RawMonetaryCredits>(ctx, 'MonetaryCredits', MONETARY_CREDITS_QUERY).catch(
      () => ({}) as RawMonetaryCredits
    )
  ])

  return { invoices: invoices.invoices ?? [], paymentMethod: payment.stripePaymentMethod, orgBudget, credits }
}

// The raw billing bundle → the normalized report both tab builders consume.
const reportFromRaw = (raw: BasetenBillingRaw): BasetenBillingReport =>
  buildBasetenBillingReport(raw.invoices, raw.paymentMethod, raw.orgBudget, raw.credits)

// ── usage: per-model dedicated serving spend + a daily-cost trend + training totals ─────

/** Parse a count that may arrive as a string ("1008817") → number. */
const parseCount = (value?: string | number | null): number => {
  const n = typeof value === 'number' ? value : parseInt(value ?? '', 10)

  return Number.isFinite(n) ? n : 0
}

const modelName = (entity?: RawEntity | null): string =>
  entity?.oracle?.name ?? entity?.name ?? entity?.modelName ?? 'unknown'

// Raw usage summary → the normalized per-model report (dollars).
export const buildBasetenUsageReport = (
  raw: RawUsageSummary,
  period: { start: string; end: string }
): BasetenUsageReport => {
  const summary = raw.usageSummaryForDateRange ?? {}
  const dedicated = summary.dedicatedUsage ?? null
  const training = summary.trainingUsage ?? null

  const models: BasetenModelUsageRow[] = []
  const dailyByDate = new Map<string, { cost: number; requests: number }>()

  for (const cat of dedicated?.productCategoryUsages ?? []) {
    for (const item of cat.items ?? []) {
      models.push({
        category: cat.category ?? 'unknown',
        model: modelName(item.entity),
        instanceType: item.billingEntity?.instanceType ?? '—',
        environment: item.billingEntity?.environmentName ?? '—',
        minutes: parseCount(item.minutes),
        requests: parseCount(item.requests),
        cost: parseDecimalAmount(item.cost ?? undefined)
      })

      for (const day of item.usagePerDay ?? []) {
        if (!day.date) {
          continue
        }

        const prev = dailyByDate.get(day.date) ?? { cost: 0, requests: 0 }

        prev.cost += parseDecimalAmount(day.cost ?? undefined)
        prev.requests += parseCount(day.requests)
        dailyByDate.set(day.date, prev)
      }
    }
  }

  models.sort((a, b) => b.cost - a.cost)

  const daily: BasetenDailyCost[] = [...dailyByDate.entries()]
    .map(([date, v]) => ({ date, cost: round2(v.cost), requests: v.requests }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return {
    periodStart: isoDay(dedicated?.startDate ?? period.start) ?? '',
    periodEnd: isoDay(dedicated?.endDate ?? period.end) ?? '',
    dedicatedTotal: parseDecimalAmount(dedicated?.currentPeriodTotal ?? undefined),
    totalMinutes: models.reduce((s, m) => s + m.minutes, 0),
    totalRequests: models.reduce((s, m) => s + m.requests, 0),
    trainingCost: parseDecimalAmount(training?.cost ?? undefined),
    models,
    daily
  }
}

// The usage report → an overview record + a per-model table + a daily-cost timeseries, with a usage.primary
// summary (period spend = dedicated + training) for the rollup.

interface BasetenOverviewRow {
  dedicatedTotal: number
  trainingCost: number
  totalRequests: number
  totalMinutes: number
  period: string
}

export const buildBasetenUsageResult = (report: BasetenUsageReport): CapabilityResult => {
  const periodSpend = round2(report.dedicatedTotal + report.trainingCost)

  const overview = record<BasetenOverviewRow>({
    id: 'overview',
    fields: [
      { key: 'dedicatedTotal', label: 'Model serving', role: 'money' },
      { key: 'trainingCost', label: 'Training', role: 'money' },
      { key: 'totalRequests', label: 'Requests', role: 'count' },
      { key: 'totalMinutes', label: 'Minutes', role: 'count' },
      { key: 'period', label: 'Period', role: 'text' }
    ],
    value: {
      dedicatedTotal: report.dedicatedTotal,
      trainingCost: report.trainingCost,
      totalRequests: report.totalRequests,
      totalMinutes: report.totalMinutes,
      period: `${report.periodStart} → ${report.periodEnd}`
    }
  })

  const models = table<BasetenModelUsageRow>({
    id: 'models',
    columns: [
      { key: 'model', label: 'Model', role: 'label' },
      { key: 'instanceType', label: 'Instance', role: 'label' },
      { key: 'environment', label: 'Environment', role: 'label' },
      { key: 'requests', label: 'Requests', role: 'count' },
      { key: 'minutes', label: 'Minutes', role: 'count' },
      { key: 'cost', label: 'Cost', role: 'money' }
    ],
    rows: report.models,
    // Each row is one (model, instance, environment) deployment — the triple is its stable identity, so the
    // ledger accumulates a deployment's usage history across periods.
    key: ['model', 'instanceType', 'environment']
  })

  const daily = blocks.daily('daily', report.daily)

  return capabilityResult({
    sections: [overview.stat(), daily, models.table({ title: 'Usage by model' })],
    summaries: [
      {
        section: 'other',
        label: 'Period spend',
        value: periodSpend,
        role: 'money',
        spark: { dataset: 'daily', x: 'date', y: 'cost' }
      }
    ]
  })
}

// Usage is scoped to the current billing period, discovered first; the period is carried alongside the raw
// summary so build() can label and bound the report.
const fetchBasetenUsage = async (ctx: CollectContext): Promise<BasetenUsageRaw> => {
  const { availableBillingPeriods } = await basetenGraphql<{ availableBillingPeriods: RawBillingPeriod[] }>(
    ctx,
    'AvailableBillingPeriods',
    BILLING_PERIODS_QUERY
  )

  const periods = availableBillingPeriods ?? []
  const current = periods.find((p) => p.isCurrent) ?? periods[0]

  if (!current?.start || !current?.end) {
    throw new Error('[baseten] No billing period available to scope usage')
  }

  const period = { start: current.start, end: current.end }
  // The per-model, per-day usage aggregation is the heaviest query Baseten serves — give it 2 minutes before
  // the transport aborts it, well past the shared default that guards every other request.
  const usage = await basetenGraphql<RawUsageSummary>(
    ctx,
    'UsageSummaryForDateRange',
    USAGE_QUERY,
    {
      startDate: period.start,
      endDate: period.end,
      usageTypes: ['DEDICATED', 'TRAINING'],
      timezoneName: 'UTC'
    },
    120_000
  )

  return { usage, period }
}

// ── keys: org + user API-key inventory (the dashboard exposes only { id, revoked } per key) ──────

// Org + user key lists → the apiKeys preset input (scope as the name, the key id as the masked value —
// Baseten exposes no secret, name, or creation date through the overview query).
export const buildBasetenKeys = (orgKeys: RawApiKey[], userKeys: RawApiKey[]): ApiKeysInput => {
  const map = (raw: RawApiKey[] | undefined, scope: string) =>
    (raw ?? []).map((k) => ({
      id: k.id ?? 'unknown',
      name: `${scope} key`,
      masked: k.id ?? undefined,
      revoked: !!k.revoked
    }))

  return { keys: [...map(orgKeys, 'Org'), ...map(userKeys, 'User')] }
}

const fetchBasetenKeys = async (ctx: CollectContext): Promise<BasetenKeysRaw> => {
  const [org, user] = await Promise.all([
    basetenGraphql<{ orgApiKeys: RawApiKey[] }>(ctx, 'OverviewOrgApiKeys', ORG_KEYS_QUERY),
    basetenGraphql<{ userApiKeys: RawApiKey[] }>(ctx, 'OverviewUserApiKeys', USER_KEYS_QUERY)
  ])

  return { orgKeys: org.orgApiKeys ?? [], userKeys: user.userApiKeys ?? [] }
}

// ── members: the org roster + pending invites ──────────────────────────────────────────

/** APPROVED members are active in Baseten's status vocabulary. */
const isApproved = (status?: string | null): boolean => status?.toUpperCase() === 'APPROVED'

// Members + invited-user lists → the members preset input. A pending invite is added only when the email isn't
// already a member; its role is suffixed "(invited)" since the preset shows no separate status column.
export const buildBasetenMembers = (
  users: RawBasetenUser[] | undefined,
  invited: RawInvitedUser[] | undefined
): MembersInput => {
  const members = (users ?? []).map((u) => ({
    id: u.id,
    name: u.name || u.username || undefined,
    email: u.email,
    role: u.roleName ?? (isApproved(u.status) ? 'member' : 'pending')
  }))

  const seen = new Set(members.map((m) => m.email?.toLowerCase()))
  const pending = (invited ?? [])
    .filter((i) => i.invited && !seen.has(i.email.toLowerCase()))
    .map((i) => ({ id: i.id, email: i.email, role: `${i.roleName ?? 'member'} (invited)` }))

  return { members: [...members, ...pending] }
}

const fetchBasetenMembers = async (ctx: CollectContext): Promise<BasetenMembersRaw> => {
  const [{ users }, invited] = await Promise.all([
    basetenGraphql<{ users: RawBasetenUser[] }>(ctx, 'Users', USERS_QUERY),
    basetenGraphql<{ users: RawInvitedUser[] }>(ctx, 'InvitedUsers', INVITED_USERS_QUERY).catch(() => ({
      users: [] as RawInvitedUser[]
    }))
  ])

  return { users: users ?? [], invited: invited.users ?? [] }
}

// ── descriptor ──────────────────────────────────────────────────────────────────────
export const basetenPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'baseten',
    name: 'Baseten',
    vendor: 'Baseten',
    category: 'ai',
    color: '#19e76e',
    description: 'Baseten dashboard billing, per-model usage, API keys, and members — from your own logged-in session.',
    homepage: 'https://www.baseten.co',
    dashboardUrl: 'https://app.baseten.co/settings/billing'
  },
  session: {
    loginUrl: 'https://app.baseten.co/settings/members',
    dashboardMarkers: ['/settings/', '/overview', '/models'],
    cookieDomains: ['baseten.co'],
    // The Django `sessionid` lands after the WorkOS SSO redirect resolves; wait for it so capture doesn't grab
    // a pre-auth jar (the GraphQL API 403s without the session).
    requiredCookie: 'sessionid',
    // The WorkOS AuthKit session cookie. Left to persist, a stale one wedges the next sign-in into an
    // authorize ⇄ refresh-token loop (login.baseten.co never settles), and headless the expired session then
    // 403s every query. Drop it before capture so a reconnect bounces through a clean WorkOS login.
    clearCookiesBeforeCapture: ['workos_session']
  },
  auth: { kind: 'cookie' },
  // node (axios): app.baseten.co is AWS-WAF (not Cloudflare), so Node's TLS is accepted; the dashboard XHR also
  // needs an `Origin` header, forbidden on Electron net.request. UA/sec-ch-ua omitted on purpose — core injects
  // the canonical browser identity into both capture + replay.
  transport: {
    defaultHeaders: {
      Accept: '*/*',
      Origin: ORIGIN,
      Referer: `${ORIGIN}/settings/billing`,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchBasetenBilling,
      build: (raw) => buildBasetenSummaryResult(reportFromRaw(raw)),
      sample: sampleBasetenBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchBasetenBilling,
      build: (raw) => buildBasetenBillingTab(reportFromRaw(raw)),
      sample: sampleBasetenBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchBasetenUsage,
      build: (raw) => buildBasetenUsageResult(buildBasetenUsageReport(raw.usage, raw.period)),
      sample: sampleBasetenUsage
    }),
    defineCapability({
      id: 'keys',
      label: 'API keys',
      fetch: fetchBasetenKeys,
      build: (raw) => keys.result(buildBasetenKeys(raw.orgKeys, raw.userKeys)),
      sample: sampleBasetenKeys
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchBasetenMembers,
      build: (raw) => members.result(buildBasetenMembers(raw.users, raw.invited)),
      sample: sampleBasetenMembers
    })
  ],
  // The cheapest authed query — a 200 with `organization.id` proves the dashboard cookie is live.
  probe: async (ctx) => {
    await basetenGraphql(ctx, 'Probe', 'query Probe { organization { id __typename } }')
  }
})

import {
  defineCapability,
  defineConfigSchema,
  definePlugin,
  type AuthAttachment,
  type AuthContext,
  type CollectContext
} from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { DateTime } from '@butinapp/sdk/libs'
import { billing, blocks } from '@butinapp/sdk/presets'
import { byDayAsc, isoDay, microsToMajor, normalizeCurrency, round2, startCase } from '@butinapp/sdk/util'
import { createHash } from 'node:crypto'

import { sampleGoogleCloudBilling, sampleGoogleCloudUsage } from './sample.js'

// Google Cloud (console.cloud.google.com) — one Cloud Billing account's month-to-date cost, forecast, credits, and
// per-service breakdown, read from the console's own internal GraphQL gateway (cloudconsole-pa.clients6.google.com).
//
// AUTH is Google's first-party SAPISIDHASH scheme: the `.google.com` session cookies ride along, and every call
// carries `Authorization: SAPISIDHASH <ts>_<sha1("<ts> <SAPISID> <origin>")>` (plus the 1P/3P variants keyed off
// `__Secure-1PAPISID` / `__Secure-3PAPISID`). The hash is derived from a cookie value, so it is minted in resolve().
//
// QUERIES are persisted: the gateway accepts an `operationName` + its registered `querySignature` + variables, never
// a raw document. A console redeploy can retire a signature, which surfaces as a GraphQL error naming the operation —
// re-record the billing pages and refresh `QUERIES` when that happens.
//
// MONEY arrives as Google's `Money` (`units` + `nanos`, usually with an `asMicros` twin) or as `*Micros` int64
// cells, in the billing account's own currency. Costs are gross; credits are negative. "Net" = cost + credits, the
// figure the console's own overview headlines. Billing months run on US Pacific time.
//
// Invoices are not covered: the console's document center is a payments.google.com iframe flow (per-page `ebp`
// tokens + a browser-navigation PDF download), which is not replayable headless.

const CONSOLE_ORIGIN = 'https://console.cloud.google.com'
const GATEWAY = 'https://cloudconsole-pa.clients6.google.com/v3/entityServices'
// The console's public browser API key — the same for every console user, shipped in its page JS. Not a credential.
const CONSOLE_API_KEY = 'AIzaSyCI-zsRP85UVOi0DjtiCwWBwQ1djDy741g'
const CLIENT_VERSION = 'boq_cloud-boq-console-web_20261111.01_p0'
const BILLING_ZONE = 'America/Los_Angeles'
// Monthly spend history the Summary chart draws, beyond the open month.
const HISTORY_MONTHS = 5

const QUERIES = {
  listBillingAccounts: {
    endpoint: 'BillingAccountsEntityService/schemas/BILLING_ACCOUNTS_GRAPHQL',
    operationName: 'ListBillingAccounts',
    querySignature: '2/W29mkAM0A7hZe5mNIEalJ4qJmZrR8LCYJ8U/qfQfNTM='
  },
  queryUsage: {
    endpoint: 'BillingReportsEntityService/schemas/BILLING_REPORTS_GRAPHQL',
    operationName: 'QueryUsage',
    querySignature: '2/nCVezREgI34xSc7B1s/7QjQ3RwqeNkAmdSrAgabPwEo='
  },
  forecastSpend: {
    endpoint: 'BillingReportsEntityService/schemas/BILLING_REPORTS_GRAPHQL',
    operationName: 'ForecastSpend',
    querySignature: '2/GvJosvk94SGTVfcRAot4EDZMoeQ6dRcYVFTptbwVseQ='
  },
  billingData: {
    endpoint: 'BillingReportsEntityService/schemas/BILLING_REPORTS_GRAPHQL',
    operationName: 'BillingData',
    querySignature: '2/P3x4vaA9WY+xnwes1nLVFEjcmjlRDAC3DdoMSRWBi4w='
  },
  listCredits: {
    endpoint: 'BillingpricefactorsEntityService/schemas/BILLINGPRICEFACTORS_GRAPHQL',
    operationName: 'ListCredits',
    querySignature: '2/Tnj+DnwzDnsPtIISAx3z9c2Sj0ujUz7aCajSSMKowrM='
  }
} as const

// The cookie each SAPISIDHASH variant is keyed off, in the order the console sends them.
const SAPISID_COOKIES = [
  ['SAPISIDHASH', 'SAPISID'],
  ['SAPISID1PHASH', '__Secure-1PAPISID'],
  ['SAPISID3PHASH', '__Secure-3PAPISID']
] as const

// ── types ───────────────────────────────────────────────────────────────────────────

export type RawMoney = { currencyCode?: string; units?: string; nanos?: number; asMicros?: string }

export type RawUsageData = { cost?: RawMoney | null; credit?: RawMoney | null }

export type RawBillingAccount = {
  id: string
  displayName?: string
  currencyCode?: string
  creationDate?: string
  state?: { status?: string; reason?: string }
  billing3Config?: { countryCode?: string; billingMethod?: string } | null
}

export type RawQueryUsage = {
  summary?: { startTime?: string; endTime?: string; combinedTotal?: RawUsageData }
  usageResultsByUsageKey?: {
    results?: { dataWithTime?: { actualStartTime?: string | null; data?: RawUsageData | null }[] }[]
  }
}

export type RawForecastSpend = {
  forecastAvailability?: string
  forecastSummary?: { startTime?: string; endTime?: string; combinedTotal?: RawUsageData }
}

export type RawCredit = {
  name: string
  displayName?: string
  value?: RawMoney
  remainingAmount?: RawMoney
  startTime?: string
  endTime?: string
}

// A BigQuery-style result: positional typed cells named by `columnInfo`. Only the cell kinds the cost views emit.
export type RawCell = { stringValue?: string | null; int64Value?: string | null; doubleValue?: number | null }

export type RawBillingData = { columnInfo?: { column: string }[]; rows?: { values: RawCell[] }[] }

export type GoogleCloudBillingRaw = {
  // The open billing month, 'YYYY-MM' (US Pacific).
  month: string
  account: RawBillingAccount
  usage: RawQueryUsage
  forecast: RawForecastSpend | null
  credits: RawCredit[]
}

export type GoogleCloudUsageRaw = { month: string; currency?: string; usage: RawQueryUsage; services: RawBillingData }

type BatchGraphqlResponse<T> = { results?: { data?: T; errors?: { message?: string }[] }[] }[]

export type GoogleCloudDay = { date: string; cost: number; credits: number; net: number }

type ServiceRow = { service: string; usageCost: number; savings: number; subtotal: number; change: number | null }

// ── auth: SAPISIDHASH ───────────────────────────────────────────────────────────────

const cookieValue = (cookie: string, name: string): string | undefined =>
  cookie
    .split(/;\s*/)
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1)

// The Authorization value the console sends: one `<scheme> <ts>_<sha1>` token per APISID cookie present.
export const sapisidAuthorization = (cookie: string, origin: string, epochSec: number): string | undefined => {
  const tokens = SAPISID_COOKIES.flatMap(([scheme, name]) => {
    const secret = cookieValue(cookie, name)

    return secret
      ? [`${scheme} ${epochSec}_${createHash('sha1').update(`${epochSec} ${secret} ${origin}`).digest('hex')}`]
      : []
  })

  return tokens.length ? tokens.join(' ') : undefined
}

const resolveGoogleCloudAuth = async (ctx: AuthContext): Promise<AuthAttachment> => {
  const cookie = ctx.creds.get('cookie') ?? ''
  const authorization = sapisidAuthorization(cookie, CONSOLE_ORIGIN, Math.floor(Date.now() / 1000))

  if (!authorization) {
    throw new Error('Google Cloud: the captured session has no SAPISID cookie — re-run Magic Login.')
  }

  return { cookie, headers: { Authorization: authorization } }
}

// ── gateway ─────────────────────────────────────────────────────────────────────────

const runQuery = async <T>(
  ctx: CollectContext,
  query: (typeof QUERIES)[keyof typeof QUERIES],
  variables: Record<string, unknown>
): Promise<T> => {
  const response = await ctx.client.post<BatchGraphqlResponse<T>>(
    `${GATEWAY}/${query.endpoint}:batchGraphql?key=${CONSOLE_API_KEY}&prettyPrint=false`,
    {
      requestContext: {
        clientVersion: CLIENT_VERSION,
        platformMetadata: { platformType: 'RIF' },
        jurisdiction: 'global'
      },
      querySignature: query.querySignature,
      operationName: query.operationName,
      variables
    }
  )
  const result = response[0]?.results?.[0]

  if (result?.errors?.length || !result?.data) {
    const reason = result?.errors?.map((e) => e.message).join('; ') || 'empty response'

    throw new Error(`Google Cloud ${query.operationName}: ${reason}`)
  }

  return result.data
}

// ── shared: money, the billing month, the account ───────────────────────────────────

export const moneyOf = (m?: RawMoney | null): number =>
  m ? (m.asMicros != null ? microsToMajor(m.asMicros) : Number(m.units ?? 0) + (m.nanos ?? 0) / 1e9) : 0

const billingMonth = () => DateTime.now().setZone(BILLING_ZONE).startOf('month')

const usageTimeFilter = (from: DateTime, to: DateTime) => ({
  earliestUsageTime: from.toUTC().toISO({ suppressMilliseconds: true }),
  latestUsageTime: to.toUTC().toISO({ suppressMilliseconds: true }),
  invoiceNumbers: [],
  subaccountNames: [],
  accountKeyPath: [],
  projectNames: [],
  serviceNames: [],
  skuNames: [],
  creditTypes: [],
  creditIds: [],
  creditNames: [],
  locations: [],
  labels: [],
  ancestors: [],
  appHubApplications: [],
  cudEligibilities: [],
  committedUsageDiscountEligibilities: [],
  subscriptionType: [],
  walletId: []
})

const DAILY = { timeGrouping: 'GROUP_BY_DAY', detailedNotesGrouping: 'DO_NOT_GROUP_BY_DETAILED_NOTES' }

// The configured account, else the one Magic Login landed on, else the first open account the user can see.
const loadAccount = async (ctx: CollectContext): Promise<RawBillingAccount> => {
  const data = await runQuery<{ billingAccountsQuery?: { listBillingAccounts?: { data?: RawBillingAccount[] } } }>(
    ctx,
    QUERIES.listBillingAccounts,
    { pageSize: 20000, orderInventorySapOrdersEnabled: false, readDescendantsFromAccountAncestryTable: true }
  )
  const accounts = data.billingAccountsQuery?.listBillingAccounts?.data ?? []
  const wanted = (ctx.config.billingAccountId as string | undefined)?.trim() || ctx.creds.get('billingAccountId')
  const account = wanted
    ? accounts.find((a) => a.id === wanted)
    : (accounts.find((a) => a.state?.status === 'OPEN') ?? accounts[0])

  if (!account) {
    throw new Error(
      wanted
        ? `Google Cloud: billing account ${wanted} is not visible to this Google account.`
        : 'Google Cloud: this Google account has no billing account.'
    )
  }

  return account
}

const loadUsage = (ctx: CollectContext, accountId: string, month: DateTime) =>
  runQuery<{ costDetailsQuery?: { QueryUsage?: RawQueryUsage } }>(ctx, QUERIES.queryUsage, {
    billingAccountName: `billingAccounts/${accountId}`,
    filter: usageTimeFilter(month.minus({ months: HISTORY_MONTHS }), month.plus({ months: 1 })),
    grouping: DAILY
  }).then((d) => d.costDetailsQuery?.QueryUsage ?? {})

// Per-day cost, credits, and net, ascending. Days with no usage are absent from the wire and stay absent.
export const buildGoogleCloudDays = (usage: RawQueryUsage): GoogleCloudDay[] => {
  const byDay = new Map<string, GoogleCloudDay>()

  for (const point of usage.usageResultsByUsageKey?.results?.flatMap((r) => r.dataWithTime ?? []) ?? []) {
    // Day boundaries are Pacific midnight (07:00/08:00 UTC), so the UTC calendar day IS the billing day.
    const date = isoDay(point.actualStartTime)

    if (!date) {
      continue
    }

    const day = byDay.get(date) ?? { date, cost: 0, credits: 0, net: 0 }

    day.cost += moneyOf(point.data?.cost)
    day.credits += moneyOf(point.data?.credit)
    byDay.set(date, day)
  }

  return [...byDay.values()]
    .map((d) => ({ date: d.date, cost: round2(d.cost), credits: round2(d.credits), net: round2(d.cost + d.credits) }))
    .sort(byDayAsc)
}

const monthTotals = (days: GoogleCloudDay[], month: string) => {
  const inMonth = days.filter((d) => d.date.startsWith(month))
  const sum = (key: 'cost' | 'credits' | 'net') => round2(inMonth.reduce((s, d) => s + d[key], 0))

  return { cost: sum('cost'), credits: sum('credits'), net: sum('net') }
}

// ── summary ─────────────────────────────────────────────────────────────────────────

export const buildGoogleCloudSummary = (raw: GoogleCloudBillingRaw): CapabilityResult => {
  const days = buildGoogleCloudDays(raw.usage)
  const mtd = monthTotals(days, raw.month)
  const closedMonths = [...new Set(days.map((d) => d.date.slice(0, 7)))].filter((m) => m < raw.month)
  const forecast =
    raw.forecast?.forecastAvailability === 'AVAILABLE' ? raw.forecast.forecastSummary?.combinedTotal : undefined
  const currency = normalizeCurrency(raw.account.currencyCode)

  return billing.summary({
    currentMtd: mtd.net,
    currency,
    currentMtdCaption: 'after credits',
    mtdBasis: 'accrued',
    // Each closed month is one bar; the open month's bar is seeded from currentMtd (accrued basis).
    invoices: closedMonths.map((m) => ({
      id: `month:${m}`,
      date: `${m}-01`,
      status: 'closed',
      amount: monthTotals(days, m).net
    })),
    stats: [
      ...(forecast
        ? [
            {
              key: 'forecast',
              label: 'Forecast',
              role: 'money' as const,
              currency,
              value: round2(moneyOf(forecast.cost) + moneyOf(forecast.credit)),
              caption: 'month end, after credits'
            }
          ]
        : []),
      {
        key: 'credits',
        label: 'Credits applied',
        role: 'money',
        currency,
        value: mtd.credits,
        tone: 'positive',
        caption: 'this month'
      },
      {
        key: 'status',
        label: 'Account',
        role: 'status',
        value: raw.account.state?.status ?? null,
        caption: raw.account.displayName
      }
    ]
  })
}

// ── billing ─────────────────────────────────────────────────────────────────────────

export const buildGoogleCloudBilling = (raw: GoogleCloudBillingRaw): CapabilityResult => {
  const { account } = raw
  const mtd = monthTotals(buildGoogleCloudDays(raw.usage), raw.month)
  const currency = normalizeCurrency(account.currencyCode)

  const accountRecord = record({
    id: 'account',
    fields: [
      { key: 'name', label: 'Billing account', role: 'label' },
      { key: 'id', label: 'Account ID', role: 'identifier' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'method', label: 'Billing method', role: 'label' },
      { key: 'country', label: 'Country', role: 'label' },
      { key: 'currency', label: 'Currency', role: 'label' },
      { key: 'created', label: 'Opened', role: 'timestamp' }
    ],
    value: {
      name: account.displayName ?? null,
      id: account.id,
      status: account.state?.status ?? null,
      method: account.billing3Config?.billingMethod
        ? startCase(account.billing3Config.billingMethod.toLowerCase())
        : null,
      country: account.billing3Config?.countryCode ?? null,
      currency: account.currencyCode ?? null,
      created: isoDay(account.creationDate) ?? null
    }
  })

  const month = record({
    id: 'month',
    fields: [
      { key: 'cost', label: 'Usage cost', role: 'money', currency },
      { key: 'credits', label: 'Credits', role: 'money', currency },
      { key: 'net', label: 'Net cost', role: 'money', currency }
    ],
    value: mtd
  })

  const credits = table({
    id: 'credits',
    columns: [
      { key: 'name', label: 'Credit', role: 'label', truncate: true },
      { key: 'value', label: 'Value', role: 'money', currency },
      { key: 'remaining', label: 'Remaining', role: 'money', currency },
      { key: 'start', label: 'Starts', role: 'timestamp' },
      { key: 'end', label: 'Expires', role: 'timestamp' },
      { key: 'id', role: 'identifier', hidden: true }
    ],
    rows: raw.credits.map((c) => ({
      id: c.name,
      name: c.displayName ?? c.name,
      value: round2(moneyOf(c.value)),
      remaining: round2(moneyOf(c.remainingAmount)),
      start: isoDay(c.startTime) ?? null,
      end: isoDay(c.endTime) ?? null
    })),
    key: 'id'
  })

  return capabilityResult({
    sections: [
      accountRecord.keyvalue({ title: 'Account' }),
      month.keyvalue({ title: 'This month' }),
      raw.credits.length > 0 && credits.table({ title: 'Credits' })
    ]
  })
}

const fetchGoogleCloudBilling = async (ctx: CollectContext): Promise<GoogleCloudBillingRaw> => {
  const account = await loadAccount(ctx)
  const month = billingMonth()
  const name = `billingAccounts/${account.id}`

  const [usage, forecast, credits] = await Promise.all([
    loadUsage(ctx, account.id, month),
    runQuery<{ costDetailsQuery?: { ForecastSpend?: RawForecastSpend } }>(ctx, QUERIES.forecastSpend, {
      billingAccountName: name,
      filter: usageTimeFilter(month, month.plus({ months: 1 })),
      grouping: DAILY
    })
      .then((d) => d.costDetailsQuery?.ForecastSpend ?? null)
      .catch(() => null),
    runQuery<{ creditsQuery?: { listCredits?: { data?: RawCredit[] } } }>(ctx, QUERIES.listCredits, { name })
      .then((d) => d.creditsQuery?.listCredits?.data ?? [])
      .catch(() => [])
  ])

  return { month: month.toFormat('yyyy-MM'), account, usage, forecast, credits }
}

// ── usage: cost by service ──────────────────────────────────────────────────────────

// Positional cells → one object per row, keyed by the column alias the query selected.
export const billingDataRows = (data: RawBillingData): Record<string, string | number | null>[] => {
  const columns = data.columnInfo?.map((c) => c.column) ?? []

  return (data.rows ?? []).map((row) =>
    Object.fromEntries(
      columns.map((col, i) => {
        const cell = row.values[i]

        return [col, cell?.stringValue ?? cell?.int64Value ?? cell?.doubleValue ?? null]
      })
    )
  )
}

export const buildGoogleCloudUsage = (raw: GoogleCloudUsageRaw): CapabilityResult => {
  const currency = normalizeCurrency(raw.currency)
  const rows: ServiceRow[] = billingDataRows(raw.services).map((r) => ({
    service: String(r.serviceDisplayName ?? r.serviceName ?? r.serviceId ?? 'Unknown'),
    usageCost: round2(microsToMajor(r.usageCostMicros)),
    savings: round2(
      microsToMajor(r.negotiatedSavingsMicros) +
        microsToMajor(r.savingsProgramsMicros) +
        microsToMajor(r.otherSavingsMicros)
    ),
    subtotal: round2(microsToMajor(r.subtotalMicros)),
    // A whole-number percent vs the same span of the previous month; the percent role wants a fraction.
    change: typeof r.percentChange === 'number' ? r.percentChange / 100 : null
  }))

  const services = table<ServiceRow>({
    id: 'services',
    columns: [
      { key: 'service', label: 'Service', role: 'label' },
      { key: 'usageCost', label: 'Usage cost', role: 'money', currency },
      { key: 'savings', label: 'Credits & savings', role: 'money', currency },
      { key: 'subtotal', label: 'Subtotal', role: 'money', currency },
      { key: 'change', label: 'vs last month', role: 'percent' }
    ],
    rows,
    key: 'service'
  })

  const daily = buildGoogleCloudDays(raw.usage)
    .filter((d) => d.date.startsWith(raw.month))
    .map((d) => ({ date: d.date, cost: d.net }))

  return capabilityResult({
    sections: [
      rows.length > 0 && services.table({ title: 'Cost by service this month' }),
      daily.length > 0 && blocks.daily('daily', daily, { title: 'Daily net cost', valueLabel: 'Net cost', currency })
    ]
  })
}

const fetchGoogleCloudUsage = async (ctx: CollectContext): Promise<GoogleCloudUsageRaw> => {
  const account = await loadAccount(ctx)
  const month = billingMonth()
  const today = DateTime.now().setZone(BILLING_ZONE).startOf('day')
  // The console compares the open month's elapsed days against the same number of days ending last month.
  const elapsed = Math.max(1, Math.round(today.diff(month, 'days').days) + 1)
  const previousEnd = month.minus({ days: 1 })
  const day = (d: DateTime) => d.toFormat('yyyy-MM-dd')

  const [usage, services] = await Promise.all([
    loadUsage(ctx, account.id, month),
    runQuery<{ billingDataQuery?: { queryBillingData?: { billingData?: RawBillingData } } }>(ctx, QUERIES.billingData, {
      request: {
        view: 'cloud_billing_data.public.costs.v2',
        clientQueryId: 'billing_reports_costs_table_SERVICE',
        parents: [{ billingAccount: `billingAccounts/${account.id}`, resource: `billingAccounts/${account.id}` }],
        columns:
          'service_id AS serviceId, service_name AS serviceName, service_display_name AS serviceDisplayName, usage_cost AS usageCostMicros, ' +
          'negotiated_savings AS negotiatedSavingsMicros, savings_programs AS savingsProgramsMicros, other_savings AS otherSavingsMicros, ' +
          'subtotal AS subtotalMicros, percent_change AS percentChange',
        groupBy: 'all',
        filter:
          '(usage_cost != 0 OR negotiated_savings != 0 OR savings_programs != 0 OR other_savings != 0 OR subtotal != 0)',
        substitutions: [
          { target: 'FILTERING_TIME_COLUMN', stringId: 'usage_date' },
          { target: 'GROUPING_TIME_COLUMN', stringId: 'usage_date' }
        ],
        parameters: [
          { name: 'CURRENT_START', stringValue: day(month) },
          { name: 'CURRENT_END', stringValue: day(month.endOf('month')) },
          { name: 'DIMENSIONS', stringArrayValue: { stringElements: ['SERVICE'] } },
          { name: 'PREVIOUS_START', stringValue: day(previousEnd.minus({ days: elapsed - 1 })) },
          { name: 'PREVIOUS_END', stringValue: day(previousEnd) },
          { name: 'COST_TYPES', stringArrayValue: { stringElements: ['USAGE'] } },
          { name: 'LIMIT_TO_TOP', int64Value: '0' },
          { name: 'CREDIT_TYPES', stringArrayValue: { stringElements: [] } },
          { name: 'EXCLUDE_NEGOTIATED_SAVINGS', boolValue: false }
        ],
        pageSize: 100,
        skip: 0,
        orderBy: 'subtotalMicros DESC'
      }
    }).then((d) => d.billingDataQuery?.queryBillingData?.billingData ?? {})
  ])

  return { month: month.toFormat('yyyy-MM'), currency: account.currencyCode, usage, services }
}

// ── descriptor ──────────────────────────────────────────────────────────────────────

const googleCloudConfigSchema = defineConfigSchema([
  {
    key: 'billingAccountId',
    label: 'Billing account ID',
    kind: 'text',
    placeholder: '000000-000000-000000',
    help: 'Optional — defaults to the account Magic Login landed on, else the first open billing account.'
  }
])

export const googleCloudPlugin = definePlugin({
  // Money stays in the billing account's own currency; this is the fallback when the account doesn't name one.
  reportingCurrency: 'USD',
  meta: {
    id: 'google-cloud',
    name: 'Google Cloud',
    vendor: 'Google',
    category: 'cloud',
    color: '#4285f4',
    description: 'Google Cloud Billing — month-to-date cost, forecast, credits, and cost by service.',
    homepage: 'https://cloud.google.com',
    dashboardUrl: `${CONSOLE_ORIGIN}/billing`
  },
  session: {
    loginUrl: `${CONSOLE_ORIGIN}/billing`,
    dashboardMarkers: ['console.cloud.google.com/billing'],
    cookieDomains: ['google.com'],
    requiredCookie: 'SAPISID',
    captureFromUrl: [{ pattern: '/billing/([0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6})', storeAs: 'billingAccountId' }]
  },
  auth: { kind: 'cookie-csrf', resolve: resolveGoogleCloudAuth },
  transport: {
    engine: 'node',
    defaultHeaders: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: CONSOLE_ORIGIN,
      Referer: `${CONSOLE_ORIGIN}/`,
      'X-Goog-AuthUser': '0'
    }
  },
  config: googleCloudConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchGoogleCloudBilling,
      build: buildGoogleCloudSummary,
      sample: sampleGoogleCloudBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchGoogleCloudBilling,
      build: buildGoogleCloudBilling,
      sample: sampleGoogleCloudBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchGoogleCloudUsage,
      build: buildGoogleCloudUsage,
      sample: sampleGoogleCloudUsage
    })
  ],
  probe: async (ctx) => {
    await loadAccount(ctx)
  }
})

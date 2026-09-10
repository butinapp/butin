import { defineCapability, defineConfigSchema, definePlugin, type CollectContext, type ConfigOf } from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing, members, usage, type MembersInput, type UsageMetricInput } from '@butinapp/sdk/presets'
import { isoDay, monthMinus, round2, startCase } from '@butinapp/sdk/util'

import { sampleGrafanaBilling, sampleGrafanaMembers, sampleGrafanaUsage } from './sample.js'

// Grafana Cloud — two read-only data surfaces with different auths:
//
//   1. The grafana.com PORTAL API (`grafana.com/api/orgs/<slug>/...`, cookie-auth). Carries issued
//      invoices + the plan/subscription summary + aggregate per-product consumption + the per-stack
//      breakdown. Auth is the grafana.com SSO session cookie (`grafana_session` / the SSO `connect.sid`),
//      replayed verbatim → auth.kind 'cookie', plain `node` axios (grafana.com is nginx behind a Google
//      Cloud LB, not Cloudflare — Node's TLS is accepted). Clear on 401 only: a 403 here is a permission
//      signal (`/billing` 403s for non-admins even on a live session), not a dead session, so the default
//      clearOnStatuses [401] is left untouched.
//
//   2. The DATA-PLANE `<stack>.grafana.net/api` (a service-account Bearer token). The portal exposes no live
//      month-to-date spend — only issued invoices — so the live MTD comes from the stack's built-in
//      `grafanacloud-usage` Prometheus datasource: the metric `grafanacloud_org_total_overage` (instant)
//      is the current period's "Current Billable Usage Cost" in dollars. This is a different auth, so the
//      stack slug + a data-plane token are plugin config (stackSlug text + dataPlaneToken secret); the MTD
//      collect attaches `Authorization: Bearer <token>` per-request to the data-plane host. If either
//      config field is empty (or the query fails), MTD is skipped gracefully → currentMtd null, leaving the
//      cookie-sourced billing page intact.
//
// Money is dollars everywhere: invoice `amount`/`amountUnpaid` are dollar decimals (11385.69, no /100) and
// the overage metric is already dollars.

const PORTAL_ORIGIN = 'https://grafana.com'

// The built-in billing/usage Prometheus datasource provisioned on every Grafana Cloud stack; the metric is
// the current period's billable usage cost in DOLLARS ("Current Billable Usage Cost").
const USAGE_DATASOURCE_UID = 'grafanacloud-usage'
const USAGE_COST_EXPR = 'avg(grafanacloud_org_total_overage)'

// ── types (the data dictionary) ───────────────────────────────────────────────────────

export const grafanaConfigSchema = defineConfigSchema([
  {
    key: 'orgSlug',
    label: 'Org slug',
    kind: 'text',
    required: true,
    placeholder: 'my-org',
    help: 'The org slug in your grafana.com URL (grafana.com/orgs/<slug>).'
  },
  {
    key: 'stackSlug',
    label: 'Stack subdomain',
    kind: 'text',
    placeholder: 'my-stack',
    help: 'Optional — the <stack> in <stack>.grafana.net. Needed (with a token) for live month-to-date spend.'
  },
  {
    key: 'dataPlaneToken',
    label: 'Data-plane token',
    kind: 'secret',
    placeholder: 'glsa_…',
    help: 'Optional — a Grafana Cloud service-account token with datasource-query access. Powers live month-to-date spend.'
  }
])

export type GrafanaConfig = ConfigOf<typeof grafanaConfigSchema>

// billing — portal `/api/orgs/<slug>/invoices` + `/api/orgs/<slug>`
interface RawLink {
  rel?: string
  href?: string
}

export interface RawGrafanaInvoice {
  id?: string
  amount?: number // invoice grand total, DOLLARS (decimal, e.g. 11385.69)
  amountUnpaid?: number // outstanding balance, dollars; 0 = fully paid
  dateSent?: string
  dateCreated?: string
  dateDue?: string
  datePaid?: string | null
  orgSlug?: string
  links?: RawLink[]
}
export interface RawGrafanaInvoiceList {
  items?: RawGrafanaInvoice[]
}
interface RawSubscription {
  product?: string
  plan?: string
  publicName?: string
  planBillingCycle?: string
  isTrial?: boolean
  startDate?: string
}

export interface RawGrafanaOrg {
  subscriptions?: { current?: RawSubscription | null } | null
  gcloudMonthlyCost?: number // base plan fee/mo, DOLLARS (Pro's $8) — NOT the metered spend
  contractType?: string
}

export interface GrafanaInvoice {
  id: string
  date?: string // 'YYYY-MM-DD' (sent, else created, else due)
  status: string // 'open' | 'paid'
  amount: number // dollars
  amountUnpaid: number // dollars
  datePaid?: string // 'YYYY-MM-DD', if paid
  hostedUrl?: string
}
export interface GrafanaBilling {
  planName: string
  product?: string // the raw product id (e.g. 'grafana-cloud-pro')
  billingCycle?: string // 'monthly' | 'annual'
  isTrial: boolean
  startDate?: string // 'YYYY-MM-DD' the subscription began
  baseFee: number // the plan's flat monthly fee, dollars (gcloudMonthlyCost)
  invoices: GrafanaInvoice[]
  latestAmount: number // most recent invoice total, dollars
  unpaidTotal: number // sum of unpaid balances, dollars
  openInvoiceCount: number
  trailing12moTotal: number // sum of invoice totals in the trailing 12 calendar months, dollars
}

// usage — portal `/api/orgs/<slug>` (aggregate) + `/api/instances?orgSlug=<slug>` (per-stack)
export interface RawGrafanaOrgUsage {
  subscriptions?: { current?: { publicName?: string; planBillingCycle?: string } | null } | null
  hmUsage?: number // metrics active series — billable
  hmCurrentUsage?: number // metrics active series — current
  hlUsage?: number // logs ingested, GB
  hlRetentionUsage?: number // logs retention, GB
  htUsage?: number // traces ingested, GB
  hpUsage?: number // profiles ingested, GB
  smUsage?: number // synthetic-monitoring check executions
  hgUsage?: number // billable Grafana active users
  hgCurrentActiveUsers?: number // current Grafana active users (all stacks)
}
interface RawGrafanaInstance {
  name?: string
  url?: string
  status?: string
  regionPublicName?: string
  runningVersion?: string
  planName?: string
  billingActiveUsers?: number
  currentActiveUsers?: number
  currentActiveAdminUsers?: number
  currentActiveEditorUsers?: number
  currentActiveViewerUsers?: number
  dashboardCnt?: number
  alertCnt?: number
  hmInstancePromBillingUsage?: number // metrics active series — billable
  hlInstanceBillingUsage?: number // logs ingested, GB — billable
  htInstanceBillingUsage?: number // traces ingested, GB — billable
  hpInstanceBillingUsage?: number // profiles ingested, GB — billable
}

export interface RawGrafanaInstanceList {
  items?: RawGrafanaInstance[]
}

export interface GrafanaProductUsage {
  key: string
  label: string
  unit: string // 'GB' | 'active series' | 'checks' | 'users'
  billed: number // billable usage for the current period
  current?: number // live usage where the API distinguishes it from billable
}
export interface GrafanaStack {
  name: string
  url?: string
  region?: string
  status: string
  version?: string
  planName?: string
  billedUsers: number
  activeUsers: number
  adminUsers: number
  editorUsers: number
  viewerUsers: number
  dashboards: number
  alerts: number
  metricsSeries: number
  logsGb: number
  tracesGb: number
  profilesGb: number
}
export interface GrafanaUsage {
  planName: string
  billingCycle?: string
  activeUsers: number // current Grafana active users across all stacks
  billedUsers: number // billable active users summed across stacks
  products: GrafanaProductUsage[]
  stacks: GrafanaStack[]
}

// members — portal `/api/orgs/<slug>/members` (an array, or an { items } wrapper)
export interface RawGrafanaMember {
  id?: number | string
  userId?: number
  login?: string
  name?: string
  email?: string
  role?: string // 'Viewer' | 'Editor' | 'Admin'
}
export interface RawGrafanaMemberList {
  items?: RawGrafanaMember[]
}

// ── billing (portal invoices + plan; MTD folded in from the data-plane) ─────────────────

const hostedUrlFor = (inv: RawGrafanaInvoice, orgSlug: string): string | undefined => {
  const self = inv.links?.find((l) => l.rel === 'self')?.href

  if (self) {
    return `${PORTAL_ORIGIN}${self}`
  }

  return inv.id ? `${PORTAL_ORIGIN}/orgs/${orgSlug}/invoices/${inv.id}` : undefined
}

// 'YYYY-MM' shifted back `count` months.
const monthsBefore = (yearMonth: string, count: number): string => {
  const [y, m] = yearMonth.split('-').map(Number)
  const zeroBased = (y ?? 0) * 12 + ((m ?? 1) - 1) - count
  const year = Math.floor(zeroBased / 12)
  const month = (zeroBased % 12) + 1

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
}

// Money is dollars (no /100). Status is derived: amountUnpaid > 0 → 'open', else 'paid'. Sorted newest-first
// so latestAmount and the table default agree.
export const buildGrafanaBilling = (
  org: RawGrafanaOrg | null | undefined,
  invoiceList: RawGrafanaInvoiceList | null | undefined,
  orgSlug: string
): GrafanaBilling => {
  const current = org?.subscriptions?.current ?? undefined
  const planName = current?.publicName ?? 'Unknown'

  const invoices = (invoiceList?.items ?? [])
    .map((inv, i): GrafanaInvoice => {
      const amountUnpaid = inv.amountUnpaid ?? 0

      return {
        id: inv.id ?? `inv-${i}`,
        date: isoDay(inv.dateSent) ?? isoDay(inv.dateCreated) ?? isoDay(inv.dateDue),
        status: amountUnpaid > 0 ? 'open' : 'paid',
        amount: inv.amount ?? 0,
        amountUnpaid,
        datePaid: isoDay(inv.datePaid),
        hostedUrl: hostedUrlFor(inv, orgSlug)
      }
    })
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

  const unpaidTotal = round2(invoices.reduce((sum, inv) => sum + inv.amountUnpaid, 0))
  const openInvoiceCount = invoices.filter((inv) => inv.amountUnpaid > 0).length

  // Trailing 12 months relative to the most recent invoice (no Date.now — keeps the builder deterministic).
  const latest = invoices[0]
  let trailing12moTotal = 0

  if (latest?.date) {
    const cutoffYearMonth = monthsBefore(latest.date.slice(0, 7), 11)

    trailing12moTotal = round2(
      invoices
        .filter((inv) => inv.date && inv.date.slice(0, 7) >= cutoffYearMonth)
        .reduce((sum, inv) => sum + inv.amount, 0)
    )
  }

  return {
    planName,
    product: current?.product,
    billingCycle: current?.planBillingCycle,
    isTrial: current?.isTrial ?? false,
    startDate: isoDay(current?.startDate),
    baseFee: org?.gcloudMonthlyCost ?? 0,
    invoices,
    latestAmount: latest?.amount ?? 0,
    unpaidTotal,
    openInvoiceCount,
    trailing12moTotal
  }
}

// Summary tab — the overview the cross-service Overview rolls up (spend.mtd): the headline (live
// month-to-date spend, or null), the plan name, and the monthly-spend trend chart the invoices feed. The
// plan detail, totals, and the invoice list are the Billing tab's detail — not here.
export const buildGrafanaSummaryResult = (billingData: GrafanaBilling, currentMtd: number | null): CapabilityResult =>
  billing.summary({
    currentMtd,
    currentMtdLabel: 'This month so far',
    // currentMtd is the live "Current Billable Usage Cost" off the data plane — a running accrual, so the open
    // month's bar is seeded from its captured peak via backfill.
    mtdBasis: 'accrued',
    plan: billingData.planName,
    // Portal invoices are sent a day or two into the following month (prior month billed in arrears), so bucket
    // the chart by the incurred month — June's bill under June — leaving the open month for the accrual backfill.
    invoices: billingData.invoices.map((i) => ({
      date: i.date ? monthMinus(i.date, 1) : i.date,
      amount: i.amount,
      status: i.status,
      hostedUrl: i.hostedUrl ?? null
    }))
  })

// Billing tab — the financial detail (not the Overview rollup; the headline + chart live on Summary): the
// subscription account record (plan, billing cycle, trial status, start date, base fee, all-time billed) and
// the invoice history. Grafana invoices have no PDF, so the hosted portal page rides a plain url column.

interface BillingAccountRow {
  plan: string
  product: string | null
  billingCycle: string | null
  trial: string
  startDate: string | null
  baseFee: number
  totalBilled: number
}

interface BillingInvoiceRow {
  // Hidden — the invoice id rides as the ledger key so an open invoice's status/unpaid balance accumulates as
  // it's paid off past the fetch window.
  id: string
  date: string | null
  status: string
  amount: number
  amountUnpaid: number
  datePaid: string | null
  hostedUrl: string | null
}

export const buildGrafanaBillingTab = (billing: GrafanaBilling): CapabilityResult => {
  const account = record<BillingAccountRow>({
    id: 'account',
    fields: [
      { key: 'plan', label: 'Plan', role: 'label' },
      { key: 'product', label: 'Product', role: 'label' },
      { key: 'billingCycle', label: 'Billing cycle', role: 'label' },
      { key: 'trial', label: 'Trial', role: 'label' },
      { key: 'startDate', label: 'Started', role: 'timestamp' },
      { key: 'baseFee', label: 'Base fee / mo', role: 'money' },
      { key: 'totalBilled', label: 'Billed (trailing 12 mo)', role: 'money' }
    ],
    value: {
      plan: billing.planName,
      product: billing.product ?? null,
      billingCycle: billing.billingCycle ? startCase(billing.billingCycle) : null,
      trial: billing.isTrial ? 'Yes' : 'No',
      startDate: billing.startDate ?? null,
      baseFee: billing.baseFee,
      totalBilled: billing.trailing12moTotal
    }
  })

  const invoices = table<BillingInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'amountUnpaid', label: 'Unpaid', role: 'money' },
      { key: 'datePaid', label: 'Paid', role: 'timestamp' },
      { key: 'hostedUrl', label: 'Invoice', role: 'url' },
      { key: 'id', role: 'identifier', hidden: true }
    ],
    rows: billing.invoices.map((i) => ({
      id: i.id,
      date: i.date ?? null,
      status: i.status,
      amount: i.amount,
      amountUnpaid: i.amountUnpaid,
      datePaid: i.datePaid ?? null,
      hostedUrl: i.hostedUrl ?? null
    })),
    key: 'id'
  })

  return capabilityResult({
    sections: [
      account.keyvalue({ title: 'Subscription' }),
      invoices.dataset.rows.length > 0 ? invoices.table({ title: 'Invoices' }) : null
    ]
  })
}

// ── usage (portal aggregate consumption + per-stack breakdown; no money) ────────────────

// Short version from the long runningVersion string ('13.1.0-2700… (commit…)' → '13.1.0').
const shortVersion = (value?: string): string | undefined => {
  if (!value) {
    return undefined
  }

  const match = /^\d+\.\d+\.\d+/.exec(value)

  return match ? match[0] : value.split(/[\s-]/)[0]
}

// Consumption only (the dollars live on Billing). GB rounded to 2 dp, series/checks/users to integers.
export const buildGrafanaUsage = (
  org: RawGrafanaOrgUsage | null | undefined,
  instanceList: RawGrafanaInstanceList | null | undefined
): GrafanaUsage => {
  const current = org?.subscriptions?.current ?? undefined

  const products: GrafanaProductUsage[] = [
    {
      key: 'metrics',
      label: 'Metrics',
      unit: 'active series',
      billed: Math.round(org?.hmUsage ?? 0),
      current: Math.round(org?.hmCurrentUsage ?? 0)
    },
    { key: 'logs', label: 'Logs', unit: 'GB', billed: round2(org?.hlUsage ?? 0) },
    { key: 'logsRetention', label: 'Logs retention', unit: 'GB', billed: round2(org?.hlRetentionUsage ?? 0) },
    { key: 'traces', label: 'Traces', unit: 'GB', billed: round2(org?.htUsage ?? 0) },
    { key: 'profiles', label: 'Profiles', unit: 'GB', billed: round2(org?.hpUsage ?? 0) },
    { key: 'synthetics', label: 'Synthetic Monitoring', unit: 'checks', billed: Math.round(org?.smUsage ?? 0) },
    {
      key: 'users',
      label: 'Grafana users',
      unit: 'users',
      billed: Math.round(org?.hgUsage ?? 0),
      current: Math.round(org?.hgCurrentActiveUsers ?? 0)
    }
  ]

  const stacks = (instanceList?.items ?? []).map((inst): GrafanaStack => ({
    name: inst.name ?? 'unknown',
    url: inst.url,
    region: inst.regionPublicName,
    status: inst.status ?? 'unknown',
    version: shortVersion(inst.runningVersion),
    planName: inst.planName,
    billedUsers: inst.billingActiveUsers ?? 0,
    activeUsers: inst.currentActiveUsers ?? 0,
    adminUsers: inst.currentActiveAdminUsers ?? 0,
    editorUsers: inst.currentActiveEditorUsers ?? 0,
    viewerUsers: inst.currentActiveViewerUsers ?? 0,
    dashboards: inst.dashboardCnt ?? 0,
    alerts: inst.alertCnt ?? 0,
    metricsSeries: Math.round(inst.hmInstancePromBillingUsage ?? 0),
    logsGb: round2(inst.hlInstanceBillingUsage ?? 0),
    tracesGb: round2(inst.htInstanceBillingUsage ?? 0),
    profilesGb: round2(inst.hpInstanceBillingUsage ?? 0)
  }))

  return {
    planName: current?.publicName ?? 'Unknown',
    billingCycle: current?.planBillingCycle,
    activeUsers: org?.hgCurrentActiveUsers ?? 0,
    billedUsers: stacks.reduce((sum, s) => sum + s.billedUsers, 0),
    products,
    stacks
  }
}

// Compose the usage CapabilityResult: the per-product consumption metrics (units carried per row) + a
// per-stack breakdown table. No money — all metrics are plain counts.

interface StackRow {
  name: string
  region: string | null
  version: string | null
  activeUsers: number
  billedUsers: number
  dashboards: number
  alerts: number
  metricsSeries: number
  logsGb: number
  tracesGb: number
}

export const buildGrafanaUsageResult = (usageData: GrafanaUsage): CapabilityResult => {
  const metrics: UsageMetricInput[] = usageData.products.map((p) => ({ label: p.label, value: p.billed, unit: p.unit }))
  const result = usage.result({ metrics })

  if (usageData.stacks.length) {
    const stacks = table<StackRow>({
      id: 'stacks',
      columns: [
        { key: 'name', label: 'Stack', role: 'label' },
        { key: 'region', label: 'Region', role: 'label' },
        { key: 'version', label: 'Version', role: 'label' },
        { key: 'activeUsers', label: 'Active users', role: 'count' },
        { key: 'billedUsers', label: 'Billed users', role: 'count' },
        { key: 'dashboards', label: 'Dashboards', role: 'count' },
        { key: 'alerts', label: 'Alerts', role: 'count' },
        { key: 'metricsSeries', label: 'Series', role: 'count' },
        { key: 'logsGb', label: 'Logs (GB)', role: 'count' },
        { key: 'tracesGb', label: 'Traces (GB)', role: 'count' }
      ],
      rows: usageData.stacks.map((s) => ({
        name: s.name,
        region: s.region ?? null,
        version: s.version ?? null,
        activeUsers: s.activeUsers,
        billedUsers: s.billedUsers,
        dashboards: s.dashboards,
        alerts: s.alerts,
        metricsSeries: s.metricsSeries,
        logsGb: s.logsGb,
        tracesGb: s.tracesGb
      })),
      // The stack name is its stable identity per org, so each stack accumulates its usage in the ledger.
      key: 'name'
    })
    const stacksView = stacks.table({ title: 'Stacks' })

    result.datasets.push(stacksView.dataset)
    result.views = [...(result.views ?? []), stacksView.view]
  }

  return result
}

// ── members (portal org roster) ─────────────────────────────────────────────────────────

// Pure transform — fixture-tested. The portal returns either a bare array or an `{ items }` wrapper; map
// either onto the roster. id prefers the numeric userId, then id, then login; role is the Grafana org role.
export const buildGrafanaMembers = (
  raw: RawGrafanaMemberList | RawGrafanaMember[] | null | undefined
): MembersInput => {
  const items = Array.isArray(raw) ? raw : (raw?.items ?? [])

  return {
    members: items.map((m, i) => ({
      id: String(m.userId ?? m.id ?? m.login ?? i),
      name: m.name || undefined,
      email: m.email || undefined,
      role: m.role || undefined
    }))
  }
}

// ── MTD (data-plane Prometheus instant query — the live month-to-date spend) ────────────

interface RawDataFrame {
  data?: { values?: unknown[][] }
}
interface RawQueryResponse {
  results?: Record<string, { frames?: RawDataFrame[] } | undefined>
}

// Pull the scalar dollar value out of a Grafana `/api/ds/query` instant response. `data.values` is
// column-major `[[timestamps], [values]]`; the value column is index 1. Returns the last finite value, or
// null if the shape is missing/empty (a degraded query yields no MTD, never a wrong number).
export const parseUsageCost = (raw: unknown): number | null => {
  const results = (raw as RawQueryResponse | null | undefined)?.results

  if (!results) {
    return null
  }

  const valueColumn = results.A?.frames?.[0]?.data?.values?.[1]

  if (!Array.isArray(valueColumn) || valueColumn.length === 0) {
    return null
  }

  const last = valueColumn[valueColumn.length - 1]
  const num = typeof last === 'string' ? Number(last) : last

  return typeof num === 'number' && Number.isFinite(num) ? num : null
}

// Best-effort live MTD: needs BOTH the stack slug and a data-plane token from config. Missing either → null
// (the cookie-sourced billing page renders fine without it). A query/permission failure → null too.
const fetchGrafanaMtd = async (ctx: CollectContext<GrafanaConfig>): Promise<number | null> => {
  const stackSlug = ctx.config.stackSlug?.trim()
  const token = ctx.config.dataPlaneToken?.trim()

  if (!stackSlug || !token) {
    return null
  }

  try {
    const raw = await ctx.client.post(
      `https://${stackSlug}.grafana.net/api/ds/query`,
      {
        queries: [
          {
            refId: 'A',
            datasource: { type: 'prometheus', uid: USAGE_DATASOURCE_UID },
            expr: USAGE_COST_EXPR,
            instant: true
          }
        ],
        from: 'now-1h',
        to: 'now'
      },
      { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    )

    return parseUsageCost(raw)
  } catch (err) {
    ctx.log('grafana MTD query failed (currentMtd → null)', { error: err instanceof Error ? err.message : String(err) })

    return null
  }
}

// ── collectors (fetch = the raw wire reads; build = the pure transform) ─────────────────

// The portal org slug. Defaults to 'grafana' as a placeholder; the user sets their real slug in Settings.
const orgSlug = (ctx: CollectContext<GrafanaConfig>): string => ctx.config.orgSlug?.trim() || 'grafana'

// The portal org + invoices, the resolved org slug (the invoice hosted-URL fallback needs it), and the live
// data-plane month-to-date figure. Summary + Billing share this bundle; the core query cache dedupes the
// underlying GETs across the two runs.
export interface GrafanaBillingRaw {
  org: RawGrafanaOrg | null
  invoiceList: RawGrafanaInvoiceList | null
  currentMtd: number | null
  slug: string
}

const fetchGrafanaBilling = async (ctx: CollectContext<GrafanaConfig>): Promise<GrafanaBillingRaw> => {
  const slug = orgSlug(ctx)
  const [org, invoiceList, currentMtd] = await Promise.all([
    ctx.client.get<RawGrafanaOrg>(`${PORTAL_ORIGIN}/api/orgs/${slug}`),
    ctx.client.get<RawGrafanaInvoiceList>(`${PORTAL_ORIGIN}/api/orgs/${slug}/invoices`),
    fetchGrafanaMtd(ctx)
  ])

  return { org, invoiceList, currentMtd, slug }
}

// The portal aggregate consumption + the per-stack instance list.
export interface GrafanaUsageRaw {
  org: RawGrafanaOrgUsage | null
  instanceList: RawGrafanaInstanceList | null
}

const fetchGrafanaUsage = async (ctx: CollectContext<GrafanaConfig>): Promise<GrafanaUsageRaw> => {
  const slug = orgSlug(ctx)
  const [org, instanceList] = await Promise.all([
    ctx.client.get<RawGrafanaOrgUsage>(`${PORTAL_ORIGIN}/api/orgs/${slug}`),
    ctx.client.get<RawGrafanaInstanceList>(
      `${PORTAL_ORIGIN}/api/instances?orgSlug=${encodeURIComponent(slug)}&pageSize=10`
    )
  ])

  return { org, instanceList }
}

// The portal members endpoint returns either a bare array or an { items } wrapper; carry whichever it sends.
export type GrafanaMembersRaw = RawGrafanaMemberList | RawGrafanaMember[]

// LIVE-VERIFY: the portal members path + response shape are reverse-engineered (cookie-auth, the same session
// as billing/usage).
const fetchGrafanaMembers = async (ctx: CollectContext<GrafanaConfig>): Promise<GrafanaMembersRaw> =>
  ctx.client.get<GrafanaMembersRaw>(`${PORTAL_ORIGIN}/api/orgs/${orgSlug(ctx)}/members`)

// ── descriptor ──────────────────────────────────────────────────────────────────────

export const grafanaPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'grafana',
    name: 'Grafana',
    vendor: 'Grafana Labs',
    category: 'devtools',
    color: '#f46800',
    description: 'Grafana Cloud — invoices, plan, live month-to-date spend, and per-product consumption.',
    homepage: 'https://grafana.com',
    dashboardUrl: 'https://grafana.com/orgs'
  },
  // Magic Login capture: the grafana.com SSO session. requiredCookie waits for the post-SSO session so the
  // portal API doesn't redirect/403 the capture.
  session: {
    loginUrl: 'https://grafana.com/auth/sign-in',
    dashboardMarkers: ['/orgs/', '/my-account'],
    cookieDomains: ['grafana.com'],
    requiredCookie: 'grafana_session',
    // Prefill the org slug from the dashboard URL (grafana.com/orgs/<slug>) when the capture settles on it.
    captureFromUrl: [{ pattern: '/orgs/([^/?#]+)', storeAs: 'orgSlug' }]
  },
  // Clear on 401 only — a 403 is a permission signal (the `/billing` endpoint 403s non-admins even on a live
  // session), so the default clearOnStatuses [401] is kept.
  auth: { kind: 'cookie' },
  transport: {
    engine: 'node',
    baseUrl: PORTAL_ORIGIN,
    defaultHeaders: {
      Accept: '*/*',
      Referer: `${PORTAL_ORIGIN}/`,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  config: grafanaConfigSchema,
  capabilities: [
    // Summary + Billing share fetchGrafanaBilling (org + invoices + the live MTD); the core query cache dedupes
    // the underlying GETs. currentMtd is the live data-plane figure (Summary's headline); Billing ignores it (its
    // detail is the invoice history, not the running total).
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchGrafanaBilling,
      build: (raw) =>
        buildGrafanaSummaryResult(buildGrafanaBilling(raw.org, raw.invoiceList, raw.slug), raw.currentMtd),
      sample: sampleGrafanaBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchGrafanaBilling,
      build: (raw) => buildGrafanaBillingTab(buildGrafanaBilling(raw.org, raw.invoiceList, raw.slug)),
      sample: sampleGrafanaBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchGrafanaUsage,
      build: (raw) => buildGrafanaUsageResult(buildGrafanaUsage(raw.org, raw.instanceList)),
      sample: sampleGrafanaUsage
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchGrafanaMembers,
      build: (raw) => members.result(buildGrafanaMembers(raw)),
      sample: sampleGrafanaMembers
    })
  ],
  probe: async (ctx) => {
    // The org endpoint is the cheapest authed portal call — a 200 proves the session cookie is live.
    await ctx.client.get(`${PORTAL_ORIGIN}/api/orgs/${orgSlug(ctx)}`)
  }
})

import { defineCapability, defineConfigSchema, definePlugin, type CollectContext, type ConfigOf } from '@butinapp/sdk'
import { capabilityResult, table, type CapabilityResult } from '@butinapp/sdk/data'
import { upperFirst } from '@butinapp/sdk/libs'
import { billing, usage, type UsageMetricInput } from '@butinapp/sdk/presets'
import { currentMonthKey, parseDollarAmount, round2 } from '@butinapp/sdk/util'
import * as cheerio from 'cheerio'

import { sampleAblyBilling, sampleAblyUsage } from './sample.js'

// Ably (ably.com) — realtime messaging / pub-sub. The account dashboard is server-rendered Rails HTML with
// NO JSON billing/usage API, so the capabilities scrape the HTML with cheerio.
//
// AUTH is a plain cookie session — the `_ably_session` Rails cookie, replayed verbatim, cleared on 401 only
// (a 403 is a per-route permission, not a dead session — core's default). The usage stats route is the
// exception: it returns 401 for a per-account permission denial, so its fetch tags that as `permissionDenied`
// to keep the live session from being wiped (see fetchAblyUsage).
//
// CLOUDFLARE: ably.com sits behind Cloudflare and only accepts a real browser (cf-ray on every response) —
// `requiresBrowserEngine: true` forces the Electron net.request transport with the real browser's TLS identity. The replay UA is
// injected centrally to match the capture window UA (cf_clearance binds to IP+UA+TLS-identity).
//
// ACCOUNT: the dashboard paths are keyed by an account SLUG (the `/accounts/<slug>/…` segment), and the
// invoice detail links use a separate numeric account id. Both are per-account, so they're `config.fields`
// the user fills in Settings (config holds account-specific ids).
//
// MONEY is already DOLLARS, scraped from `$233.30` strings (no cents conversion). USAGE is in native units
// (messages, GiB) with no exposed money rate, so it renders as counts.

const ORIGIN = 'https://ably.com'
const CURRENCY = 'USD'

const MONTHS: Record<string, string> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12'
}

// ── types (the data dictionary) ──────────────────────────────────────────────────────

export interface AblyInvoice {
  /** Ably's internal invoice id (from the row's `invoice-<id>` element id). */
  id: string
  /** Stripe invoice number shown in the table, e.g. `in_1Td…`. */
  number?: string
  /** 'YYYY-MM-DD'. */
  date?: string
  status: string
  /** USD dollars. */
  amount: number
  /** Dashboard link that 302s to the Stripe-hosted invoice. */
  hostedUrl?: string
}

export interface AblyBilling {
  planName: string
  invoices: AblyInvoice[]
  /** Most recent invoice total, dollars. */
  latestAmount: number
  /** Sum of invoice totals in the trailing 12 calendar months, dollars. */
  trailing12moTotal: number
}

export interface AblyUsageMetric {
  /** Stable stat key from `data-js-stat`, e.g. `messages_published`. */
  key: string
  label: string
  /** True for the bold billable-total rows that carry a monthly limit. */
  isBillable: boolean
  /** Display strings exactly as the dashboard formats them (may carry units like "53 GiB"). */
  limit?: string
  lastMonth?: string
  thisMonth?: string
  projected?: string
  /** Parsed numeric of `thisMonth` (commas/units stripped) for sorting; 0 if blank. */
  thisMonthValue: number
  note?: string
}

// ── shared parsers ───────────────────────────────────────────────────────────────────

export { parseDollarAmount }

// "June 1, 2026" → "2026-06-01" (UTC, no Date tz drift). undefined if unparseable.
export const parseInvoiceDate = (text?: string): string | undefined => {
  const m = text?.trim().match(/^(\w+)\s+(\d{1,2}),\s+(\d{4})$/)

  if (!m) {
    return undefined
  }

  const month = MONTHS[m[1]!.toLowerCase()]

  return month ? `${m[3]}-${month}-${m[2]!.padStart(2, '0')}` : undefined
}

// "71,413,818" / "53 GiB" → 71413818 / 53. 0 when blank/unparseable.
const toNumber = (text: string): number => {
  const m = text.replace(/,/g, '').match(/-?\d+(\.\d+)?/)

  return m ? parseFloat(m[0]) : 0
}

// Non-numeric trailing token as the unit hint: "53 GiB" → "GiB"; "17,135,770" → undefined.
const unitOf = (text?: string): string | undefined => {
  const m = text?.match(/[\d,.\s]+([A-Za-z/%]+)\s*$/)

  return m ? m[1] : undefined
}

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim()

// ── billing: scraped invoice history + current plan name ───────────────────────────────

// Scrape the invoice rows out of the invoices-page HTML. Cell order:
// [expand, invoice#, date, amount, status, reason, actions].
export const parseInvoices = (html: string): AblyInvoice[] => {
  const $ = cheerio.load(html)
  const invoices: AblyInvoice[] = []

  $('tr[data-testid="invoice-row"]').each((_, row) => {
    const $row = $(row)
    const cells = $row.find('td')
    const number = cells.eq(1).text().trim() || undefined
    const date = parseInvoiceDate(cells.eq(2).text().trim())
    const amount = parseDollarAmount(cells.eq(3).text().trim())
    const status = cells.eq(4).text().trim().toLowerCase() || 'unknown'
    const id = ($row.attr('id') ?? '').replace(/^invoice-/, '') || (number ?? 'unknown')
    const href = $row.find('a[href*="/invoices/"]').first().attr('href')

    invoices.push({
      id,
      number,
      date,
      status,
      amount,
      hostedUrl: href ? `${ORIGIN}${href}` : undefined
    })
  })

  return invoices
}

// The package page mounts a Turbo component whose props (HTML-entity-encoded JSON) carry
// `currentPackagePlanId`, e.g. "standard" → "Standard".
export const parsePlanName = (html: string): string => {
  const m = html.match(/currentPackagePlanId(?:&quot;|"):\s*(?:&quot;|")([^&"]+)/)

  if (!m) {
    return 'Unknown'
  }

  const id = m[1]!

  return upperFirst(id)
}

// 'YYYY-MM' shifted back `count` months.
const monthsBefore = (yearMonth: string, count: number): string => {
  const [y, m] = yearMonth.split('-').map(Number)
  const zeroBased = y! * 12 + (m! - 1) - count

  return `${String(Math.floor(zeroBased / 12)).padStart(4, '0')}-${String((zeroBased % 12) + 1).padStart(2, '0')}`
}

export const buildAblyBilling = (invoicesHtml: string, packageHtml: string): AblyBilling => {
  const invoices = parseInvoices(invoicesHtml).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  const latest = invoices[0]
  let trailing12moTotal = 0

  if (latest?.date) {
    const cutoff = monthsBefore(latest.date.slice(0, 7), 11)

    trailing12moTotal = invoices
      .filter((inv) => inv.date && inv.date.slice(0, 7) >= cutoff)
      .reduce((sum, inv) => sum + inv.amount, 0)
  }

  return {
    planName: parsePlanName(packageHtml),
    invoices,
    latestAmount: latest?.amount ?? 0,
    trailing12moTotal: round2(trailing12moTotal)
  }
}

// Summary tab — its spend.mtd summary is what the cross-service Overview rolls up. Ably issues one invoice per
// calendar month, so the current month's invoiced total stands in for month-to-date spend; a month with no
// invoice yet stays 0 (the Overview reads Ably's current-month bar) rather than nulling out and dropping the
// service from the Overview at the month rollover.
export const buildAblySummaryResult = (billingData: AblyBilling): CapabilityResult => {
  const ym = currentMonthKey()
  const mtd = billingData.invoices.filter((i) => i.date?.startsWith(ym)).reduce((sum, i) => sum + i.amount, 0)

  return billing.summary({
    currentMtd: round2(mtd),
    // Sum of the current calendar month's issued invoices.
    mtdBasis: 'invoiced',
    currency: CURRENCY,
    invoices: billingData.invoices.map((i) => ({ date: i.date, amount: i.amount, status: i.status })),
    stats: [
      { key: 'plan', label: 'Plan', role: 'label', value: billingData.planName },
      { key: 'latest', label: 'Latest invoice', role: 'money', value: billingData.latestAmount },
      { key: 'trailing12mo', label: 'Trailing 12 mo', role: 'money', value: billingData.trailing12moTotal },
      { key: 'invoiceCount', label: 'Invoices', role: 'count', value: billingData.invoices.length }
    ]
  })
}

// Billing tab — the invoice history; each row links to its Stripe-hosted invoice.
interface AblyInvoiceRow {
  date: string | null
  number: string | null
  amount: number
  status: string
  hostedUrl: string | null
}

export const buildAblyBillingResult = (billing: AblyBilling): CapabilityResult => {
  const invoices = table<AblyInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'number', label: 'Number', role: 'identifier' },
      { key: 'amount', label: 'Amount', role: 'money', currency: CURRENCY },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'hostedUrl', label: 'Invoice', role: 'url' }
    ],
    rows: billing.invoices.map((i) => ({
      date: i.date ?? null,
      number: i.number ?? null,
      amount: i.amount,
      status: i.status,
      hostedUrl: i.hostedUrl ?? null
    }))
  })

  return capabilityResult({ sections: [invoices.table({ title: 'Invoices' })] })
}

// ── usage: per-metric consumption scraped from the stats-table HTML fragment ────────────

// The fragment is a bare <tbody> (no <thead>); column order is [label, limit?, lastMonth, thisMonth-so-far,
// projected, note]. Bold billable-total rows carry a monthly limit; sub-metric rows leave it blank. cheerio
// drops <tr> with no <table> ancestor, so wrap it.
export const buildAblyUsageMetrics = (html: string): AblyUsageMetric[] => {
  const $ = cheerio.load(`<table>${html}</table>`)
  const metrics: AblyUsageMetric[] = []

  $('tr').each((_, row) => {
    const $row = $(row)
    const $label = $row.find('td[data-js-stat]').first()
    const key = $label.attr('data-js-stat')

    if (!key) {
      return
    }

    const cells = $row.find('td')
    const limit = clean(cells.eq(1).text())
    const lastMonth = clean(cells.eq(2).text())
    const thisMonth = clean(cells.eq(3).text())
    const projected = clean(cells.eq(4).text())
    const note = clean(cells.eq(5).text())

    metrics.push({
      key,
      label: clean($label.text()),
      isBillable: limit.length > 0,
      limit: limit || undefined,
      lastMonth: lastMonth || undefined,
      thisMonth: thisMonth || undefined,
      projected: projected || undefined,
      thisMonthValue: toNumber(thisMonth),
      note: note || undefined
    })
  })

  return metrics
}

// Compose the usage result: the metrics as count stat-rows (this-month value + unit/limit), plus a richer
// detail table with the dashboard's display strings (last month / this month / projected) preserved.
interface AblyUsageDetailRow {
  label: string
  limit: string | null
  lastMonth: string | null
  thisMonth: string | null
  projected: string | null
}

export const buildAblyUsageResult = (metrics: AblyUsageMetric[]): CapabilityResult => {
  const metricInputs: UsageMetricInput[] = metrics.map((m) => ({
    label: m.label,
    value: m.thisMonthValue,
    unit: unitOf(m.thisMonth ?? m.limit),
    limit: m.limit ? toNumber(m.limit) : null
  }))
  const result = usage.result({ metrics: metricInputs })

  if (metrics.length) {
    const detail = table<AblyUsageDetailRow>({
      id: 'usageDetail',
      columns: [
        { key: 'label', label: 'Metric', role: 'label' },
        { key: 'limit', label: 'Limit', role: 'text' },
        { key: 'lastMonth', label: 'Last month', role: 'text' },
        { key: 'thisMonth', label: 'This month', role: 'text' },
        { key: 'projected', label: 'Projected', role: 'text' }
      ],
      rows: metrics.map((m) => ({
        label: m.label,
        limit: m.limit ?? null,
        lastMonth: m.lastMonth ?? null,
        thisMonth: m.thisMonth ?? null,
        projected: m.projected ?? null
      }))
    })

    result.datasets.push(detail.dataset)
    result.views = [...(result.views ?? []), detail.table({ title: 'Usage detail' }).view]
  }

  return result
}

// ── collectors ─────────────────────────────────────────────────────────────────────────

export const ablyConfigSchema = defineConfigSchema([
  {
    key: 'accountSlug',
    label: 'Account slug',
    kind: 'text',
    required: true,
    placeholder: 'H7pwLQ',
    help: 'The /accounts/<slug>/ segment of your Ably dashboard URL.'
  }
])

export type AblyConfig = ConfigOf<typeof ablyConfigSchema>

// The account slug keys every dashboard path; a missing one surfaces as "fill in Settings" rather than a 404.
const accountSlug = (ctx: CollectContext<AblyConfig>): string => {
  const slug = ctx.config.accountSlug?.trim()

  if (!slug) {
    throw new Error('Ably: set the Account slug in Settings (the /accounts/<slug>/ segment of the dashboard URL).')
  }

  return slug
}

// The raw scrapes Summary + Billing share: invoice-page + package-page HTML.
export interface AblyBillingRaw {
  invoicesHtml: string
  packageHtml: string
}

// The raw scrape Usage parses: the bare stats-table <tbody> fragment.
export interface AblyUsageRaw {
  html: string
}

// Billing scrapes two pages (invoices + package); the package page is best-effort — a missing plan name
// must not blank the whole tab. Summary + Billing both fetch this; the core query cache dedupes the reads.
const fetchAblyBilling = async (ctx: CollectContext<AblyConfig>): Promise<AblyBillingRaw> => {
  const slug = accountSlug(ctx)
  const [invoicesHtml, packageHtml] = await Promise.all([
    ctx.client.getText(`${ORIGIN}/accounts/${slug}/invoices`),
    ctx.client.getText(`${ORIGIN}/accounts/${slug}/package`).catch(() => '')
  ])

  return { invoicesHtml, packageHtml }
}

// The stats table is gated by a per-account permission Ably serves as 401 "Access denied" — the same session
// reads invoices/package fine. Tag that 401 so it surfaces as a permission error on this tab rather than being
// taken for a dead session and wiping the whole cookie (core's clearOnStatuses default).
const fetchAblyUsage = async (ctx: CollectContext<AblyConfig>): Promise<AblyUsageRaw> => {
  try {
    return { html: await ctx.client.getText(`${ORIGIN}/api/stats/account/${accountSlug(ctx)}/table`) }
  } catch (err) {
    if ((err as { status?: number }).status === 401) {
      ;(err as { permissionDenied?: boolean }).permissionDenied = true
    }

    throw err
  }
}

// ── descriptor ───────────────────────────────────────────────────────────────────────

export const ablyPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'ably',
    name: 'Ably',
    vendor: 'Ably',
    category: 'devtools',
    color: '#ce3a1c',
    description: 'Ably realtime account — invoice history, current plan, and per-metric usage.',
    homepage: 'https://ably.com',
    dashboardUrl: 'https://ably.com/accounts'
  },
  session: {
    loginUrl: 'https://ably.com/login',
    dashboardMarkers: ['/accounts/'],
    cookieDomains: ['ably.com'],
    // The Rails session lands after the SSO redirect resolves; gate the capture on it so a half-set jar
    // (a dashboard marker matching before the auth cookie lands) isn't grabbed.
    requiredCookie: '_ably_session',
    // Google sign-in is omniauth, which stashes the OAuth `state` in the Rails `_ably_session` cookie. A
    // stale `_ably_session` left in the shared partition poisons that state on the callback, so the handshake
    // fails and login never completes (works once from a clean jar, fails every time after). Drop it at the
    // start of each capture so the OAuth round-trip begins clean; the authed `_ably_session` is then re-set
    // on the callback and captured.
    clearCookiesBeforeCapture: ['_ably_session']
  },
  auth: { kind: 'cookie' },
  transport: {
    requiresBrowserEngine: true,
    baseUrl: ORIGIN
  },
  config: ablyConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchAblyBilling,
      build: (raw) => buildAblySummaryResult(buildAblyBilling(raw.invoicesHtml, raw.packageHtml)),
      sample: sampleAblyBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchAblyBilling,
      build: (raw) => buildAblyBillingResult(buildAblyBilling(raw.invoicesHtml, raw.packageHtml)),
      sample: sampleAblyBilling
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchAblyUsage,
      build: (raw) => buildAblyUsageResult(buildAblyUsageMetrics(raw.html)),
      sample: sampleAblyUsage
    })
  ],
  probe: async (ctx) => {
    // The invoices page is the cheapest authed scrape — a 200 with the table proves the session is live.
    await ctx.client.getText(`${ORIGIN}/accounts/${accountSlug(ctx)}/invoices`)
  }
})

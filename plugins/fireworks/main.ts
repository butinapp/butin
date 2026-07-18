import { defineCapability, definePlugin, type CollectContext } from '@butinapp/sdk'
import { capabilityResult, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing, type BillingInvoiceInput } from '@butinapp/sdk/presets'
import { asArray, epochMsDay, parseDecimalAmount, round2 } from '@butinapp/sdk/util'

import { sampleFireworksFlight } from './sample.js'

// Fireworks AI: the billing dashboard lives on the Next.js app at app.fireworks.ai (served from Vercel's
// edge, NOT Cloudflare) so plain Node axios works — the browser engine isn't needed. The durable credential
// is the dashboard session cookie jar (matched by the fireworks.ai domain). The billing route is a React
// Server Component page: requesting it with `RSC: 1` returns the compact flight payload (not full HTML),
// which embeds the invoice list as `"invoiceRows":[{ id, amount, invoiceUrl, status, targetTimeMs, type }]`.
//
// MONEY: each row's `amount` is a pre-formatted dollar STRING, and in the RSC flight a leading `$` is escaped
// by DOUBLING (`"$$13.04"` — RSC reserves a leading `$` for references). Strip the `$`/`$$`/commas to a number;
// dollars, NOT cents. `targetTimeMs` is epoch milliseconds. The list is complete on its own — `invoiceUrl` is
// the Orb-hosted link surfaced as an external column, so there's NO per-invoice Orb fetch.
//
// Members are intentionally NOT a capability: Fireworks user management lives on the separate inference API
// (api.fireworks.ai, authed by an API key, a different credential) — out of scope for the cookie session here.
const BILLING_URL = 'https://app.fireworks.ai/account/billing'

// ── types ─────────────────────────────────────────────────────────────────────────
// The raw invoiceRows wire shape (only the fields we use) + the normalized invoice (USD dollars).
interface RawInvoiceRow {
  id?: string
  // Pre-formatted, RSC-escaped, e.g. "$$13.04".
  amount?: string
  // Orb-hosted invoice link.
  invoiceUrl?: string
  // e.g. "Upcoming" | "Success".
  status?: string
  // Epoch milliseconds.
  targetTimeMs?: number
  type?: number
}

export interface FireworksInvoice {
  id: string
  date?: string // 'YYYY-MM-DD' from targetTimeMs
  amount: number // parsed USD dollars
  status: string
  hostedUrl: string | null // Orb-hosted invoice link
}

export interface FireworksInvoicesReport {
  invoices: FireworksInvoice[]
  // Sum of successful (non-upcoming) invoice amounts, USD dollars.
  totalBilled: number
  // Most recent upcoming invoice amount, if any (the in-progress invoice = live MTD).
  upcomingAmount: number | null
  // The in-progress (upcoming) invoice accrues over the period → the live MTD; null when none.
  currentMtd: number | null
}

// ── domain logic ────────────────────────────────────────────────────────────────────

// Pull the `invoiceRows` array out of the billing-page RSC flight payload. The flight is not parseable as a
// whole, so locate the `"invoiceRows":` marker, balance-scan the array (respecting string/escape boundaries),
// then JSON.parse just that slice. Marker absent / unparseable slice → [].
export const extractInvoiceRows = (flight: string): RawInvoiceRow[] => {
  const marker = '"invoiceRows":'
  const at = flight.indexOf(marker)

  if (at === -1) {
    return []
  }

  const start = flight.indexOf('[', at)

  if (start === -1) {
    return []
  }

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < flight.length; i++) {
    const ch = flight[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }

      continue
    }

    if (ch === '"') {
      inString = true
    } else if (ch === '[') {
      depth++
    } else if (ch === ']') {
      depth--

      if (depth === 0) {
        try {
          return JSON.parse(flight.slice(start, i + 1)) as RawInvoiceRow[]
        } catch {
          return []
        }
      }
    }
  }

  return []
}

// Pure transform — fixture-tested. Normalize the raw rows to USD-dollar invoices (newest-first), and surface
// the upcoming (in-progress) invoice both as `upcomingAmount` and as `currentMtd` (the live month-to-date).
export const buildFireworksReport = (rows: RawInvoiceRow[] | undefined | null): FireworksInvoicesReport => {
  const invoices: FireworksInvoice[] = asArray<RawInvoiceRow>(rows)
    .map((row) => ({
      id: row.id ?? '',
      date: epochMsDay(row.targetTimeMs),
      amount: parseDecimalAmount(row.amount),
      status: row.status ?? 'unknown',
      hostedUrl: row.invoiceUrl || null
    }))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

  const upcoming = invoices.find((i) => i.status.toLowerCase() === 'upcoming')
  const totalBilled = invoices
    .filter((i) => i.status.toLowerCase() !== 'upcoming')
    .reduce((sum, i) => sum + i.amount, 0)

  return {
    invoices,
    totalBilled: round2(totalBilled),
    upcomingAmount: upcoming?.amount ?? null,
    currentMtd: upcoming?.amount ?? null
  }
}

// Adapt the normalized report's invoices to the SDK's BillingInvoiceInput (the monthly-spend chart source).
const toBillingInvoices = (report: FireworksInvoicesReport): BillingInvoiceInput[] =>
  report.invoices.map((i) => ({
    date: i.date,
    amount: i.amount,
    status: i.status,
    hostedUrl: i.hostedUrl
  }))

// ── summary (its spend.mtd is what the cross-service Overview rolls up) ──
// The shared billing.summary preset (account stat + monthly-spend chart + spend.mtd summary). currentMtd
// is the upcoming-invoice amount (null when none → the Overview skips Fireworks rather than charting a 0); we
// add the invoice count + total-billed as free stats off the list already fetched for the chart.
export const buildFireworksSummaryResult = (rows: RawInvoiceRow[] | undefined | null): CapabilityResult => {
  const report = buildFireworksReport(rows)

  return billing.summary({
    currentMtd: report.currentMtd,
    currentMtdLabel: 'Upcoming',
    // The in-progress (not-yet-issued) next invoice total.
    mtdBasis: 'upcoming',
    invoices: toBillingInvoices(report),
    stats: [
      { key: 'invoiceCount', label: 'Invoices', role: 'count', value: report.invoices.length },
      { key: 'totalBilled', label: 'Total billed', role: 'money', value: report.totalBilled }
    ]
  })
}

// ── billing (the detail table, NOT the Overview rollup) ──
// The invoice history as a table: date / amount / status (badged) + an external `url` column to the Orb-hosted
// invoice. Each row's invoiceUrl carries its own token, so it's a downloadable file (the host adds selection +
// Download all/selected + per-row Open). The headline (MTD / monthly chart) lives on Summary.
interface FireworksBillingRow {
  // Hidden — the invoice id rides as the ledger key so an upcoming invoice's status/amount accumulates as it
  // finalizes (several invoices can share a month, so date isn't a stable identity).
  id: string
  date: string | null
  amount: number
  status: string
  invoiceUrl: string | null
  // Hidden — carried for the download filename, declared not smuggled.
  name: string
}

export const buildFireworksBillingResult = (rows: RawInvoiceRow[] | undefined | null): CapabilityResult => {
  const report = buildFireworksReport(rows)
  const invoices = table<FireworksBillingRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'invoiceUrl', label: 'Invoice', role: 'url' },
      { key: 'name', role: 'label', hidden: true },
      { key: 'id', role: 'identifier', hidden: true }
    ],
    rows: report.invoices.map((i) => ({
      id: i.id,
      date: i.date ?? null,
      amount: i.amount,
      status: i.status,
      invoiceUrl: i.hostedUrl,
      name: `Invoice ${i.date ?? 'unknown'}`
    })),
    key: 'id'
  })

  return capabilityResult({
    sections: [
      invoices.fileTable({
        title: 'Invoices',
        name: 'name',
        source: { url: 'invoiceUrl' },
        ext: 'pdf',
        category: 'Invoices'
      })
    ]
  })
}

// ── collectors ──────────────────────────────────────────────────────────────────────
// One fetch feeds both tabs: the billing RSC flight. `RSC: 1` makes Next.js return the compact flight payload
// (not full HTML); getText hands back the raw stream for the balance-scan extractor. Summary + Billing both
// fetch it (the core query cache dedupes the underlying read).
const fetchFlight = (ctx: CollectContext): Promise<string> => ctx.client.getText(BILLING_URL, { RSC: '1' })

// ── descriptor ──────────────────────────────────────────────────────────────────────
export const fireworksPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'fireworks',
    name: 'Fireworks',
    vendor: 'Fireworks AI',
    category: 'devtools',
    color: '#6720ff',
    description: 'Fireworks AI dashboard billing — invoice history + the Orb-hosted invoice links.',
    homepage: 'https://fireworks.ai',
    dashboardUrl: 'https://app.fireworks.ai/account/billing'
  },
  // Magic Login capture: the dashboard session cookie jar on app.fireworks.ai. Billing lives only on the
  // dashboard (not the inference API), so the cookie session is all we need.
  session: {
    loginUrl: 'https://app.fireworks.ai/login',
    dashboardMarkers: ['/account', '/dashboard', '/models'],
    cookieDomains: ['fireworks.ai']
  },
  // Plain cookie replay — the dashboard cookie jar authenticates the same-origin GET verbatim (no resolve()).
  auth: { kind: 'cookie' },
  // app.fireworks.ai is a Next.js app on Vercel's edge (not Cloudflare): plain Node axios over Node TLS works,
  // no browser-TLS match needed. Same-origin GET → no Origin header required. (Members would need the separate
  // api.fireworks.ai inference API key — a different credential — so user management is intentionally omitted.)
  transport: { engine: 'node' },
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchFlight,
      build: (flight) => buildFireworksSummaryResult(extractInvoiceRows(flight)),
      sample: sampleFireworksFlight
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchFlight,
      build: (flight) => buildFireworksBillingResult(extractInvoiceRows(flight)),
      sample: sampleFireworksFlight
    })
  ],
  probe: async (ctx) => {
    // The billing RSC flight is the cheapest authed read — a successful fetch proves the dashboard session is live.
    await ctx.client.getText(BILLING_URL, { RSC: '1' })
  }
})

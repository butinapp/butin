import { defineCapability, defineConfigSchema, definePlugin, type CollectContext, type ConfigOf } from '@butinapp/sdk'
import { addSections, capabilityResult, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing, usage } from '@butinapp/sdk/presets'
import { epochSecDay, round2 } from '@butinapp/sdk/util'

import { sampleGoogleWorkspace } from './sample.js'

// Google Workspace (admin.google.com) — subscriptions, seat counts, per-seat pricing, and the computed
// monthly run-rate for a DIRECT (non-reseller) Workspace customer. Three read-only tabs over one cookie session:
//   1. Summary — the overview the cross-service Overview rolls up (spend.mtd): the monthly run-rate headline +
//      the subscription-count / billable-seat stat cards. No tables.
//   2. Billing — the per-subscription detail (the deepest detail this service exposes): SKU, plan, seats,
//      per-seat rate, monthly estimate, renewal. No invoices (payments.google.com is blocked).
//   3. Usage — per-SKU seat utilization against the commitment.
// Summary, Billing, and Usage share one subscriptions/pricing fetch (the query cache dedupes it).
//
// NO OFFICIAL API. Google exposes no billing API for a direct Workspace customer: the Reseller API is
// reseller-only and the Cloud Billing API covers GCP billing accounts, not Workspace subscriptions. So the
// subscription/seat/pricing data is read from the admin console's internal `batchexecute` RPCs
// (POST admin.google.com/_/DasherCommerceConsoleAdminUi/data/batchexecute).
//
// AUTH is the plain `.google.com` session cookies (replayed verbatim, cleared on 401 only — a 403 is a
// per-endpoint permission, not a dead session), PLUS three per-page tokens scraped from a billing page's
// HTML and replayed on every RPC: `SNlM0e` (the `at` XSRF), `FdrFJe` (`f.sid`), `cfb2h` (`bl` backend
// release). collect() first fetches the billing page (getText), scrapes the three tokens, then POSTs the
// batchexecute RPC with them and parses the `)]}'`-prefixed JSON-array response.
//
// TRANSPORT is plain `node` (axios): admin.google.com validates `Origin` + `Sec-Fetch-*` headers like a
// real same-origin XHR, and those are forbidden on Electron `net.request`. Google doesn't need the
// browser engine, so Node TLS is accepted.
//
// MONEY: the admin RPCs carry money as Google's structured tuple `[currency, units, nanos]` where dollars
// = units + nanos/1e9 (e.g. `["USD",14,720000000]` ⇒ 14.72). Amounts are normalized to USD dollars at the
// edge (the data-view contract's money unit). `currentMtd` / run-rate = Σ over subscriptions of
// `(committed ?? assigned) × currentMonthlyPerSeat`: for a commitment plan billed monthly, that recurring
// figure IS the accruing open-period spend, so it's the live MTD that feeds the cross-service Overview.
//
// ⚠️ LIVE REPLAY IS FRAGILE — collect() is best-effort. Google rotates `bl`/`f.sid` constantly, and its
// session spans hosts (admin/accounts/payments .google.com) with a per-host cookie subset + an
// admin→accounts(SetOSID)→admin redirect chain. Core's transport replays the captured jar as ONE flat Cookie
// header to every host, which Google can reject (CookieMismatch / a stripped sign-in shell) — so the token
// scrape can need a per-host cookie strategy core does not model. The pure parsers below (token scrape +
// batchexecute decode + the build*() normalizers) are fixture-tested.

const ADMIN_ORIGIN = 'https://admin.google.com'
const COMMERCE_APP = 'DasherCommerceConsoleAdminUi'
const SOURCE_SUBSCRIPTIONS = '/ac/billing/subscriptions'
const SOURCE_LICENSE_SETTINGS = '/ac/billing/licensesettings'
const RPC_SUBSCRIPTIONS = 'KyAUjc'
const RPC_PRICING = 'KRm3O'
// The admin console's Money tuples are tagged `["<ccy>", units, nanos]`; the per-seat MONTHLY rate is the
// tuple immediately followed by the `[2,1]` (per-month, per-unit) unit marker. We accept any 3-letter
// currency code so the parse isn't pinned to one billing currency.
const CURRENCY_CODE = /^[A-Z]{3}$/

// ── types (the data dictionary) ──────────────────────────────────────────────────────

/** The per-page tokens the admin console embeds in its HTML and replays on every batchexecute call. */
export interface GoogleAdminTokens {
  /** `SNlM0e` — the `at` XSRF token. */
  at: string
  /** `FdrFJe` — the `f.sid` session id. */
  fsid: string
  /** `cfb2h` — the `bl` backend release (also identifies WHICH app served the page). */
  bl: string
}

interface SkuPricing {
  /** Current per-seat monthly price, USD dollars; null if not priced (e.g. Voice, free). */
  currentMonthly: number | null
  /** Per-seat price at next renewal, USD dollars, when it differs. */
  renewalMonthly: number | null
}

export interface GoogleSubscription {
  /** Google SKU id, e.g. "GOOGLE.GAU_2021". */
  skuId: string
  /** Display name, e.g. "Google Workspace Business Standard". */
  skuName: string
  /** Plan name, e.g. "Annual Plan (Monthly Payment)" / "Flexible Plan". */
  planName: string
  status: string
  /** Seats currently assigned to users. */
  seatsAssigned: number | null
  /** Committed seat count (annual plans); null for flexible/free plans. */
  seatsCommitted: number | null
  /** Renewal date 'YYYY-MM-DD' (annual plans), if any. */
  renewalDate?: string
  /** Current per-seat monthly price, USD dollars; null if unpriced. */
  perSeatMonthly: number | null
  /** Per-seat price at next renewal, USD dollars, if it differs. */
  renewalPerSeatMonthly: number | null
  /** (committed ?? assigned) × perSeatMonthly, USD dollars; null if unpriced. */
  monthlyEstimate: number | null
}

export interface GoogleBilling {
  currency: string
  subscriptions: GoogleSubscription[]
  /** Current monthly recurring spend (Σ monthlyEstimate), USD dollars. Also `currentMtd`. null when
   *  no subscription could be priced. */
  monthlyRunRate: number | null
}

export interface GoogleSeatUsage {
  skuId: string
  skuName: string
  planName: string
  /** Seats assigned to users. */
  seatsAssigned: number
  /** Committed/purchased seats (annual plans); null for flexible (pay-as-you-go). */
  seatsCommitted: number | null
  /** assigned / committed, 0–1; null when there's no commitment to measure against. */
  utilization: number | null
}

export interface GoogleUsage {
  seats: GoogleSeatUsage[]
  /** Total assigned seats across all SKUs. */
  totalAssigned: number
  /** Total committed seats across all SKUs (committed plans only). */
  totalCommitted: number
}

// ── token scrape (the auth nonces the admin console embeds in its page HTML) ────────────

// Scrape the three batchexecute tokens out of an authenticated billing page's HTML. Returns null when any
// is missing (e.g. the session bounced to the sign-in shell, which carries none of them) so the caller can
// surface "re-capture" rather than POST a doomed RPC.
export const extractPageTokens = (html: string): GoogleAdminTokens | null => {
  const at = html.match(/"SNlM0e":"([^"]+)"/)?.[1]
  const fsid = html.match(/"FdrFJe":"([^"]+)"/)?.[1]
  const bl = html.match(/"cfb2h":"([^"]+)"/)?.[1]

  if (!at || !fsid || !bl) {
    return null
  }

  return { at, fsid, bl }
}

// The `bl` (cfb2h backend release) tells us WHICH app served the page — `dasher-commerce`/`dasher-admin` is
// the billing app; `identityfrontendauthui` means we landed on sign-in (the session can't reach the app).
export const isCommerceApp = (bl: string): boolean => /dasher-commerce|dasher-admin/.test(bl)

// ── batchexecute envelope decode ─────────────────────────────────────────────────────

// Parse a Google `batchexecute` response and return the decoded payload for one rpcid. The body is the
// `)]}'`-prefixed, length-prefixed stream of `[["wrb.fr","<rpcid>","<json>", …]]` envelopes; the inner
// `<json>` is itself a JSON string. Returns null when the rpcid isn't present (Google omits empties).
export const parseBatchExecute = (body: string, rpcid: string): unknown => {
  for (const line of body.replace(/^\)\]\}'/, '').split('\n')) {
    const trimmed = line.trim()

    if (!trimmed.startsWith('[[')) {
      continue
    }

    try {
      const rows = JSON.parse(trimmed) as unknown[][]

      for (const row of rows) {
        if (Array.isArray(row) && row[0] === 'wrb.fr' && row[1] === rpcid && typeof row[2] === 'string') {
          return JSON.parse(row[2])
        }
      }
    } catch {
      // Length-prefix lines and stray framing aren't JSON — skip them.
    }
  }

  return null
}

// ── pricing (KRm3O license-settings) ─────────────────────────────────────────────────

// Google Money tuple `[currency, units, nanos]` → dollars. Accepts any 3-letter currency tag.
const moneyTupleToDollars = (tuple: unknown): number | null => {
  if (
    !Array.isArray(tuple) ||
    typeof tuple[0] !== 'string' ||
    !CURRENCY_CODE.test(tuple[0]) ||
    typeof tuple[1] !== 'number'
  ) {
    return null
  }

  const units = tuple[1]
  const nanos = typeof tuple[2] === 'number' ? tuple[2] : 0

  return units + nanos / 1e9
}

// Walk the KRm3O license-settings tree and map each SKU id to its current/renewal per-seat monthly price.
// A "price entry" is an array `[null, <skuInfo>, <price>]` whose `skuInfo` contains a `GOOGLE.*` id; within
// `<price>`, per-seat monthly prices are Money tuples immediately followed by the `[2,1]` (per-month,
// per-unit) marker. The first such tuple is the current rate, a later distinct one is the renewal rate.
// Defensive: anything it can't parse just yields null.
export const extractPricing = (pricingRaw: unknown): Record<string, SkuPricing> => {
  const out: Record<string, SkuPricing> = {}

  if (!pricingRaw) {
    return out
  }

  const visit = (node: unknown): void => {
    if (!Array.isArray(node)) {
      return
    }

    if (node.length >= 3 && node[0] === null && Array.isArray(node[1]) && Array.isArray(node[2])) {
      const skuId = (JSON.stringify(node[1]).match(/(GOOGLE\.[A-Z0-9_]+)/) || [])[1]

      if (skuId && !out[skuId]) {
        // Collect Money tuples immediately followed by the [2,1] monthly-per-unit marker.
        const monthly: number[] = []
        const collect = (n: unknown): void => {
          if (!Array.isArray(n)) {
            return
          }

          for (let i = 0; i < n.length; i++) {
            const cur = n[i]
            const next = n[i + 1]

            if (Array.isArray(cur) && Array.isArray(next) && next[0] === 2 && next[1] === 1) {
              const dollars = moneyTupleToDollars(cur)

              if (dollars !== null) {
                monthly.push(dollars)
              }
            }

            collect(cur)
          }
        }

        collect(node[2])
        const renewal = monthly.find((m) => m !== monthly[0])

        out[skuId] = { currentMonthly: monthly[0] ?? null, renewalMonthly: renewal ?? null }
      }
    }

    for (const child of node) {
      visit(child)
    }
  }

  visit(pricingRaw)

  return out
}

// ── subscriptions (KyAUjc) ───────────────────────────────────────────────────────────

// Renewal block is `[3, [unixSeconds, nanos]]` → 'YYYY-MM-DD'.
const unixToDate = (block: unknown): string | undefined => {
  if (!Array.isArray(block) || !Array.isArray(block[1]) || typeof block[1][0] !== 'number') {
    return undefined
  }

  return epochSecDay(block[1][0])
}

export const parseSubscriptions = (subsRaw: unknown, pricing: Record<string, SkuPricing>): GoogleSubscription[] => {
  const list = Array.isArray(subsRaw) && Array.isArray((subsRaw as unknown[])[0]) ? (subsRaw as unknown[][])[0] : []
  const out: GoogleSubscription[] = []

  for (const sub of list) {
    if (!Array.isArray(sub)) {
      continue
    }

    const meta = sub[0] as unknown[] | undefined
    const skuInfo = sub[1] as unknown[] | undefined
    const planBlock = sub[2] as unknown[] | undefined
    const seats = sub[5] as unknown[] | undefined

    const skuId = (skuInfo?.[8] as string) ?? 'unknown'
    const skuName = ((skuInfo?.[0] as unknown[])?.[1] as string) ?? skuId
    const planName = ((planBlock?.[6] as unknown[])?.[1] as string) ?? 'unknown'
    const statusCode = meta?.[1]
    const status = statusCode === 2 ? 'active' : statusCode === 1 ? 'pending' : 'inactive'
    const seatsAssigned = typeof seats?.[3] === 'number' ? (seats[3] as number) : null
    const seatsCommitted = typeof seats?.[4] === 'number' ? (seats[4] as number) : null
    const renewalDate = unixToDate(meta?.[6])

    const price = pricing[skuId] ?? { currentMonthly: null, renewalMonthly: null }
    const billableSeats = seatsCommitted ?? seatsAssigned ?? 0
    const monthlyEstimate = price.currentMonthly !== null ? billableSeats * price.currentMonthly : null

    out.push({
      skuId,
      skuName,
      planName,
      status,
      seatsAssigned,
      seatsCommitted,
      renewalDate,
      perSeatMonthly: price.currentMonthly,
      renewalPerSeatMonthly: price.renewalMonthly,
      monthlyEstimate
    })
  }

  return out
}

// ── billing: pure normalizer (the fixture-test target) ──────────────────────────────────

interface BuildBillingArgs {
  subsRaw: unknown
  pricingRaw: unknown
  /** Currency read off the subscriptions (the admin RPCs report a single billing currency); USD fallback. */
  currency?: string
}

// Pure transform — fixture-tested. subsRaw is required; pricingRaw is best-effort (a drift in the nested
// KRm3O parse degrades to a null run-rate, not a thrown collect()).
export const buildGoogleWorkspaceBilling = (args: BuildBillingArgs): GoogleBilling => {
  const pricing = extractPricing(args.pricingRaw)
  const subscriptions = parseSubscriptions(args.subsRaw, pricing)
  const priced = subscriptions.map((s) => s.monthlyEstimate).filter((m): m is number => m !== null)
  const monthlyRunRate = priced.length ? round2(priced.reduce((sum, m) => sum + m, 0)) : null

  return {
    currency: (args.currency ?? 'USD').toUpperCase(),
    subscriptions,
    monthlyRunRate
  }
}

// Read the billing currency off the first subscription's currency cell (the admin RPC stamps it on each
// sub, e.g. sub[0][11]); falls back to USD. Kept separate so the build*() can be fixture-fed a currency too.
export const subscriptionsCurrency = (subsRaw: unknown): string | undefined => {
  const list = Array.isArray(subsRaw) && Array.isArray((subsRaw as unknown[])[0]) ? (subsRaw as unknown[][])[0] : []
  const first = list[0]
  const meta = Array.isArray(first) ? (first[0] as unknown[] | undefined) : undefined
  const ccy = meta?.[11]

  return typeof ccy === 'string' && CURRENCY_CODE.test(ccy) ? ccy : undefined
}

interface SubscriptionRow {
  skuName: string | null
  planName: string | null
  status: string | null
  seatsAssigned: number | null
  seatsCommitted: number | null
  perSeatMonthly: number | null
  monthlyEstimate: number | null
  renewalDate: string | null
}

// Summary tab — the overview the cross-service Overview rolls up (spend.mtd): the monthly run-rate headline +
// the subscription-count / billable-seat stat cards. Workspace bills the commitment monthly, so the recurring
// run-rate IS the open-period spend → currentMtd. There's no per-invoice history exposed here (it lives behind a
// blocked payments.google.com widget), so the monthly-spend chart has no source rows — the headline run-rate
// carries the rollup. The per-subscription detail lives on the Billing tab, not here.
export const buildGoogleWorkspaceSummaryResult = (billingData: GoogleBilling): CapabilityResult => {
  const mtd = billingData.monthlyRunRate

  return billing.summary({
    currentMtd: mtd,
    currentMtdLabel: 'Monthly run-rate',
    // The committed run-rate is a fixed recurring fee billed monthly — the floor and the whole bill (no metered
    // overage), so baseFee is the run-rate and the basis is 'flat'.
    baseFee: mtd,
    mtdBasis: 'flat',
    currency: billingData.currency,
    invoices: [],
    monthlyTitle: 'Monthly run-rate',
    stats: [
      { key: 'subscriptions', label: 'Subscriptions', role: 'count', value: billingData.subscriptions.length },
      {
        key: 'seats',
        label: 'Billable seats',
        role: 'count',
        value: billingData.subscriptions.reduce((sum, s) => sum + (s.seatsCommitted ?? s.seatsAssigned ?? 0), 0)
      }
    ]
  })
}

// Billing tab — the per-subscription detail (the deepest detail this service exposes): SKU, plan, seat counts,
// per-seat monthly rate, monthly estimate, and renewal date. No spend.mtd summary and no headline cards (those
// are the Summary tab's). There are no invoices to download — payments.google.com is blocked.
export const buildGoogleWorkspaceBillingTab = (billing: GoogleBilling): CapabilityResult => {
  const subs = table<SubscriptionRow>({
    id: 'subscriptions',
    columns: [
      { key: 'skuName', label: 'Subscription', role: 'label' },
      { key: 'planName', label: 'Plan', role: 'label' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'seatsAssigned', label: 'Assigned', role: 'count' },
      { key: 'seatsCommitted', label: 'Committed', role: 'count' },
      { key: 'perSeatMonthly', label: 'Per seat / mo', role: 'money', currency: billing.currency },
      { key: 'monthlyEstimate', label: 'Monthly', role: 'money', currency: billing.currency },
      { key: 'renewalDate', label: 'Renews', role: 'timestamp' }
    ],
    rows: billing.subscriptions.map((s) => ({
      skuName: s.skuName,
      planName: s.planName,
      status: s.status,
      seatsAssigned: s.seatsAssigned ?? null,
      seatsCommitted: s.seatsCommitted ?? null,
      perSeatMonthly: s.perSeatMonthly ?? null,
      monthlyEstimate: s.monthlyEstimate ?? null,
      renewalDate: s.renewalDate ?? null
    })),
    // One subscription per SKU, so the SKU name is its stable identity — each subscription's seats/estimate
    // accumulate in the ledger.
    key: 'skuName'
  })

  return capabilityResult({
    sections: [billing.subscriptions.length ? subs.table({ title: 'Subscriptions' }) : null]
  })
}

// ── usage: per-SKU seat utilization (the same KyAUjc subscriptions feed; Workspace meters by seat) ──────

// Pure transform — fixture-tested. No money (seat counts only; spend lives on billing).
export const buildGoogleWorkspaceUsage = (subsRaw: unknown): GoogleUsage => {
  // Pricing isn't needed for usage — pass an empty map so monthlyEstimate stays null.
  const subscriptions = parseSubscriptions(subsRaw, extractPricing(null))
  const seats: GoogleSeatUsage[] = subscriptions.map((s) => {
    const seatsAssigned = s.seatsAssigned ?? 0
    const seatsCommitted = s.seatsCommitted
    const utilization = seatsCommitted && seatsCommitted > 0 ? Math.min(seatsAssigned / seatsCommitted, 1) : null

    return { skuId: s.skuId, skuName: s.skuName, planName: s.planName, seatsAssigned, seatsCommitted, utilization }
  })

  return {
    seats,
    totalAssigned: seats.reduce((sum, s) => sum + s.seatsAssigned, 0),
    totalCommitted: seats.reduce((sum, s) => sum + (s.seatsCommitted ?? 0), 0)
  }
}

interface SeatRow {
  skuName: string | null
  planName: string | null
  seatsAssigned: number | null
  seatsCommitted: number | null
  // percent role renders 0–1 as a percentage; null when there's no commitment to measure against.
  utilization: number | null
}

export const buildGoogleWorkspaceUsageResult = (usageData: GoogleUsage): CapabilityResult => {
  const result = usage.result({
    metrics: [
      {
        label: 'Assigned seats',
        value: usageData.totalAssigned,
        unit: 'seats',
        limit: usageData.totalCommitted || null
      },
      { label: 'Committed seats', value: usageData.totalCommitted, unit: 'seats' }
    ]
  })

  const seatsView = usageData.seats.length
    ? table<SeatRow>({
        id: 'seats',
        columns: [
          { key: 'skuName', label: 'Subscription', role: 'label' },
          { key: 'planName', label: 'Plan', role: 'label' },
          { key: 'seatsAssigned', label: 'Assigned', role: 'count' },
          { key: 'seatsCommitted', label: 'Committed', role: 'count' },
          { key: 'utilization', label: 'Utilization', role: 'percent' }
        ],
        rows: usageData.seats.map((s) => ({
          skuName: s.skuName,
          planName: s.planName,
          seatsAssigned: s.seatsAssigned,
          seatsCommitted: s.seatsCommitted ?? null,
          utilization: s.utilization
        })),
        // One row per subscription (SKU), so the SKU name is its stable identity in the ledger.
        key: 'skuName'
      }).table({ title: 'Seat utilization' })
    : null

  return addSections(result, seatsView)
}

// ── collectors (best-effort live replay — see header) ──────────────────────────────────

const customerId = (ctx: CollectContext<GoogleWorkspaceConfig>): string => {
  const id = ctx.config.customerId?.trim()

  if (!id) {
    throw new Error('Google Workspace: set the Customer ID in Settings (the cid in the admin console URL).')
  }

  return id
}

// Fetch the token-bearing billing page once, scrape its three tokens, then POST a batchexecute RPC with
// them and decode the response. Wired against the documented endpoint shape; not yet verified live (Google
// rotates bl/f.sid and segregates cookies per host — see header). A bad/expired page throws so the UI can
// prompt a fresh Magic Login capture rather than parse a sign-in shell.
const runRpc = async (
  ctx: CollectContext<GoogleWorkspaceConfig>,
  rpcid: string,
  payload: unknown[],
  sourcePath: string
): Promise<unknown> => {
  const html = await ctx.client.getText(`${ADMIN_ORIGIN}${SOURCE_SUBSCRIPTIONS}?hl=en`)
  const tokens = extractPageTokens(html)

  if (!tokens || !isCommerceApp(tokens.bl)) {
    throw new Error(
      'Google Workspace: could not read the admin console tokens (the session likely expired or landed on ' +
        'sign-in). Re-capture via Magic Login.'
    )
  }

  const reqid = Math.floor(Math.random() * 900000) + 100000
  const cid = customerId(ctx)
  const url =
    `${ADMIN_ORIGIN}/_/${COMMERCE_APP}/data/batchexecute` +
    `?rpcids=${rpcid}&source-path=${encodeURIComponent(sourcePath)}` +
    `&f.sid=${encodeURIComponent(tokens.fsid)}&bl=${encodeURIComponent(tokens.bl)}` +
    `&hl=en&cid=${encodeURIComponent(cid)}&_reqid=${reqid}&rt=c`

  const fReq = JSON.stringify([[[rpcid, JSON.stringify(payload), null, '1']]])
  const form = new URLSearchParams({ 'f.req': fReq, at: tokens.at }).toString()

  const resp = await ctx.client.request<string>({
    url,
    method: 'POST',
    body: form,
    responseType: 'text',
    referer: `${ADMIN_ORIGIN}/`,
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'X-Same-Domain': '1'
    }
  })

  return parseBatchExecute(typeof resp.data === 'string' ? resp.data : String(resp.data), rpcid)
}

// Summary, Billing, and Usage all read the same KyAUjc subscriptions + KRm3O pricing RPCs; every capability's
// fetch returns this raw bundle. The core query cache dedupes the underlying reads across the runs. Pricing is
// best-effort.
export interface GoogleWorkspaceData {
  subsRaw: unknown
  pricingRaw: unknown
}

const fetchGoogleWorkspaceData = async (ctx: CollectContext<GoogleWorkspaceConfig>): Promise<GoogleWorkspaceData> => {
  const cid = customerId(ctx)
  const rootOu = ctx.config.rootOuId?.trim()
  const pricingPayload = rootOu ? [cid, rootOu] : [cid]

  const [subsRaw, pricingRaw] = await Promise.all([
    runRpc(ctx, RPC_SUBSCRIPTIONS, [cid], SOURCE_SUBSCRIPTIONS),
    runRpc(ctx, RPC_PRICING, pricingPayload, SOURCE_LICENSE_SETTINGS).catch(() => null)
  ])

  return { subsRaw, pricingRaw }
}

// Pure raw→billing normalizer over the fetched bundle; reads the billing currency off the subscriptions.
const billingFromData = (raw: GoogleWorkspaceData): GoogleBilling =>
  buildGoogleWorkspaceBilling({
    subsRaw: raw.subsRaw,
    pricingRaw: raw.pricingRaw,
    currency: subscriptionsCurrency(raw.subsRaw)
  })

// ── descriptor ──────────────────────────────────────────────────────────────────────

export const googleWorkspaceConfigSchema = defineConfigSchema([
  {
    key: 'customerId',
    label: 'Customer ID',
    kind: 'text',
    required: true,
    placeholder: 'C01abc234',
    help: 'The obfuscated customer id (the cid param in the admin console URL).'
  },
  {
    key: 'rootOuId',
    label: 'Root OU ID',
    kind: 'text',
    placeholder: '03abc1de4fg5hij',
    help: 'Optional — the root org-unit id; scopes the per-seat pricing lookup.'
  }
])

export type GoogleWorkspaceConfig = ConfigOf<typeof googleWorkspaceConfigSchema>

export const googleWorkspacePlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'google-workspace',
    name: 'Google Workspace',
    vendor: 'Google',
    category: 'devtools',
    color: '#1a73e8',
    description: 'Google Workspace admin — subscriptions, seat counts, per-seat pricing, and monthly run-rate.',
    homepage: 'https://workspace.google.com',
    dashboardUrl: 'https://admin.google.com/ac/billing/subscriptions'
  },
  // Magic Login lands on the billing page; capture only on the settled 200 (a half-set jar before the
  // admin→accounts redirect resolves would grab the wrong cookie subset).
  session: {
    loginUrl: 'https://admin.google.com/ac/billing/subscriptions',
    dashboardMarkers: ['/ac/billing/subscriptions'],
    cookieDomains: ['google.com'],
    requiredCookie: 'SID'
  },
  auth: { kind: 'cookie' },
  // Node (axios): admin.google.com validates Origin + Sec-Fetch-* (forbidden on Electron net.request) and
  // doesn't need the browser engine. The cross-host Origin/X-Same-Domain markers go per-request in runRpc.
  transport: {
    engine: 'node',
    baseUrl: ADMIN_ORIGIN,
    defaultHeaders: {
      Origin: ADMIN_ORIGIN
    }
  },
  config: googleWorkspaceConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchGoogleWorkspaceData,
      build: (raw) => buildGoogleWorkspaceSummaryResult(billingFromData(raw)),
      sample: sampleGoogleWorkspace
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchGoogleWorkspaceData,
      build: (raw) => buildGoogleWorkspaceBillingTab(billingFromData(raw)),
      sample: sampleGoogleWorkspace
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchGoogleWorkspaceData,
      build: (raw) => buildGoogleWorkspaceUsageResult(buildGoogleWorkspaceUsage(raw.subsRaw)),
      sample: sampleGoogleWorkspace
    })
  ],
  probe: async (ctx) => {
    // Fetch the admin billing page and confirm it served the commerce app (not the sign-in shell) — proves
    // the captured .google.com session still reaches the console, without running a batchexecute RPC.
    const html = await ctx.client.getText(`${ADMIN_ORIGIN}${SOURCE_SUBSCRIPTIONS}?hl=en`)
    const tokens = extractPageTokens(html)

    if (!tokens || !isCommerceApp(tokens.bl)) {
      throw new Error('Google Workspace: session expired or landed on sign-in — re-capture via Magic Login.')
    }
  }
})

import {
  defineCapability,
  defineConfigSchema,
  definePlugin,
  type CollectContext,
  type ConfigOf,
  type ConfigOption
} from '@butinapp/sdk'
import { addSections, capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { billing, keys, usage, type ApiKeysInput, type BillingInvoiceInput } from '@butinapp/sdk/presets'
import { byDayAsc, byDayDesc, centsToMajor, isoDay, isoDaysAgo, round2, startCase } from '@butinapp/sdk/util'

import { sampleGreptileBilling, sampleGreptileKeys, sampleGreptilePeople, sampleGreptileUsage } from './sample.js'

// Greptile (app.greptile.com) — an AI code-review tool. Its data layer is a tRPC API
// (`/api/trpc/<proc>`) with the superjson transformer + request batching, behind a Next.js app on
// Vercel's edge (not Cloudflare) → plain `node` transport. Auth is a NextAuth/Auth.js session cookie
// (the chunked `__Secure-authjs.session-token.0` / `.1` pair), replayed verbatim (cookie auth, clear
// on 401 only). The tenant (org) is a per-org UUID `tenantExternalId` picked in Settings: the combobox
// lists the orgs you belong to (fetched from `/api/auth/session` → user.organizations), so you choose
// one instead of pasting a UUID. Money is cents everywhere (Stripe) → centsToMajor.

const ORIGIN = 'https://app.greptile.com'

// ── tRPC batched-GET transport ────────────────────────────────────────────────────────
// The app uses superjson-encoded, batched tRPC GETs: `?batch=1&input={"0":{json,meta?}}`, unwrapping
// `[0].result.data.json`. `meta` marks non-JSON values (Dates / undefined) by path so the server's
// superjson transformer revives them before zod validation.

type SuperjsonInput = {
  json: unknown
  meta?: { values: Record<string, unknown>; v: number }
}

type TrpcBatchResponse<T> = Array<{ result?: { data?: { json?: T } } } | { error?: { json?: { message?: string } } }>

// One batched tRPC query → its unwrapped superjson `json` payload. Throws with the server's message on
// a tRPC error entry.
const trpcQuery = async <T>(ctx: CollectContext<GreptileConfig>, proc: string, input: SuperjsonInput): Promise<T> => {
  const encoded = encodeURIComponent(JSON.stringify({ 0: input }))
  const data = await ctx.client.get<TrpcBatchResponse<T>>(`${ORIGIN}/api/trpc/${proc}?batch=1&input=${encoded}`)
  const entry = Array.isArray(data) ? data[0] : undefined

  if (entry && 'error' in entry && entry.error) {
    throw new Error(entry.error.json?.message ?? `greptile: ${proc} failed`)
  }

  return (entry && 'result' in entry ? entry.result?.data?.json : undefined) as T
}

// The tenant (org) UUID — per-install, read from settings (NOT hardcoded).
const tenantId = (ctx: CollectContext<GreptileConfig>): string => {
  const id = ctx.config.tenantExternalId?.trim()

  if (!id) {
    throw new Error('Greptile: set the Tenant ID in Settings (the per-org UUID from your dashboard).')
  }

  return id
}

// Plain `{ tenantExternalId }` input (no Dates / undefined → no `meta`).
const tenantInput = (ctx: CollectContext<GreptileConfig>): SuperjsonInput => ({
  json: { tenantExternalId: tenantId(ctx) }
})

// ── org resolution (Settings picker) ──────────────────────────────────────────────────
// `/api/auth/session` (the NextAuth session endpoint) carries `user.organizations[]` — every org you
// belong to, each with its `tenantExternalId` UUID + display `name`. The Settings combobox fetches it
// through the authed client so you pick an org instead of pasting its UUID. We never silently choose:
// the picked value is stored under `tenantExternalId` and read back by `tenantId()`.

export type RawSessionOrg = {
  tenantExternalId?: string
  name?: string
  slug?: string
}

type RawAuthSession = {
  user?: { organizations?: RawSessionOrg[] } | null
}

export const fetchGreptileOrgs = async (get: <T>(url: string) => Promise<T>): Promise<RawSessionOrg[]> => {
  try {
    const session = await get<RawAuthSession>(`${ORIGIN}/api/auth/session`)

    return session?.user?.organizations ?? []
  } catch {
    return []
  }
}

// Map the session payload onto combobox options: org name as label, the tenant UUID as the stored value
// (with the slug/UUID as subtext). `recommended` marks the first only when there's an actual choice, so
// the picker pre-selects something instead of opening blank — but never silently chooses.
export const buildGreptileOrgOptions = (orgs: RawSessionOrg[]): ConfigOption[] => {
  const valid = (orgs ?? []).filter(
    (o): o is RawSessionOrg & { tenantExternalId: string } =>
      typeof o.tenantExternalId === 'string' && !!o.tenantExternalId
  )

  return valid.map((o, i) => ({
    value: o.tenantExternalId,
    label: o.name?.trim() || o.slug?.trim() || o.tenantExternalId,
    description: o.slug?.trim() || o.tenantExternalId,
    recommended: valid.length > 1 && i === 0
  }))
}

// ── billing ───────────────────────────────────────────────────────────────────────────
// History from `billing.getCodeReviewBillingPeriods` (month list, each with a Stripe `invoiceId` — null
// for the open current period) joined to `billing.getUpcomingInvoice({ invoiceId })` per finalized month.
// The open period has no invoice yet, so its projected spend (from `getCurrentPeriodCosts`) is synthesized
// into an `upcoming` row so the monthly chart includes the in-progress month. All money is cents.

export type RawBillingPeriod = {
  startTime?: string
  endTime?: string
  label?: string
  invoiceId?: string | null
}

export type RawInvoiceLine = {
  description?: string
  amount?: number // cents
  currency?: string
}

export type RawUpcomingInvoice = {
  periodStart?: string
  periodEnd?: string
  total?: number // cents
  subtotal?: number // cents
  currency?: string
  status?: string
  hostedInvoiceUrl?: string | null
  lines?: RawInvoiceLine[]
}

export type RawSubscriptionInfo = {
  codeReview?: {
    model?: string
    status?: string
    seatPriceCents?: number
    overagePriceCents?: number
    includedReviewsPerDev?: number
    periodStart?: string
    periodEnd?: string
  } | null
}

export type RawCurrentPeriodCosts = {
  codeReview?: {
    totalCents?: number
    seatCostCents?: number
    overageCostCents?: number
    activeDevs?: number
    overageCount?: number
  } | null
  api?: { totalCents?: number } | null
}

export type RawFlexUsageStatus = {
  creditBalanceCents?: number
  currentPeriodStart?: string
  currentPeriodEnd?: string
  flexUsageReviewCount?: number
  projectedNetFlexUsageChargeCents?: number
}

export type GreptileSubscription = {
  model: string
  status: string
  seatPriceUsd: number
  overagePriceUsd: number
  includedReviewsPerDev: number
  activeDevs: number
  overageCount: number
  seatCostUsd: number
  overageCostUsd: number
  apiCostUsd: number
  /** Live current-period running total (seat + overage + API), dollars — the MTD figure. */
  currentTotalUsd: number
  creditBalanceUsd: number
}

export type GreptileInvoice = BillingInvoiceInput & {
  /** Human label for the billing period, e.g. '5th May – 5th Jun, 2026'. */
  label: string
  /** True for the in-progress period (a live projection, not a finalized invoice). */
  projected: boolean
}

export type GreptileBilling = {
  subscription: GreptileSubscription
  /** Newest-first, including the projected current period. */
  invoices: GreptileInvoice[]
  /** Sum of finalized (non-projected) invoice totals, dollars. */
  totalBilled: number
}

/** A period joined to the invoice fetched for it (null when no invoice / fetch failed). */
export type PeriodWithInvoice = {
  // Stable union key for incremental fetch: the Stripe invoiceId, or the CONSTANT `'open'` for the invoice-less
  // current period. There is only ever one open period, so its id must stay constant across refreshes — at
  // month rollover it finalizes under its own `invoiceId` and the new current period reuses the `'open'` slot,
  // rather than orphaning a stale `open:<oldStartTime>` row the service never re-emits. Stripe invoice ids are
  // always `in_...`, so `'open'` can't collide with one.
  id: string
  // Top-level copy of `period.startTime`, so core's incremental watermark can read it without reaching into
  // the nested `period`. `buildGreptileBilling` still destructures `{ period, invoice }` and ignores this.
  startTime?: string
  period: RawBillingPeriod
  invoice: RawUpcomingInvoice | null
}

// Always fully shaped with safe defaults so the renderer never reads `undefined`. Money is Stripe cents →
// dollars. currentTotalUsd is the live current-period running total.
export const buildGreptileBilling = (
  periods: PeriodWithInvoice[] | null | undefined,
  rawSub: RawSubscriptionInfo | null | undefined,
  rawCosts: RawCurrentPeriodCosts | null | undefined,
  rawFlex: RawFlexUsageStatus | null | undefined
): GreptileBilling => {
  const cr = rawSub?.codeReview ?? {}
  const costs = rawCosts?.codeReview ?? {}
  const apiCosts = rawCosts?.api ?? {}

  const subscription: GreptileSubscription = {
    model: cr.model ?? 'unknown',
    status: cr.status ?? 'unknown',
    seatPriceUsd: centsToMajor(cr.seatPriceCents),
    overagePriceUsd: centsToMajor(cr.overagePriceCents),
    includedReviewsPerDev: cr.includedReviewsPerDev ?? 0,
    activeDevs: costs.activeDevs ?? 0,
    overageCount: costs.overageCount ?? 0,
    seatCostUsd: centsToMajor(costs.seatCostCents),
    overageCostUsd: centsToMajor(costs.overageCostCents),
    apiCostUsd: centsToMajor(apiCosts.totalCents),
    currentTotalUsd: centsToMajor(costs.totalCents) + centsToMajor(apiCosts.totalCents),
    creditBalanceUsd: centsToMajor(rawFlex?.creditBalanceCents)
  }

  const invoices: GreptileInvoice[] = (periods ?? [])
    .map(({ period, invoice }): GreptileInvoice => {
      const projected = !period?.invoiceId || !invoice
      const start = invoice?.periodStart ?? period?.startTime

      if (projected) {
        return {
          label: period?.label ?? 'Current period',
          date: isoDay(start),
          status: 'upcoming',
          amount: subscription.currentTotalUsd,
          projected: true,
          hostedUrl: null
        }
      }

      return {
        id: period?.invoiceId ?? undefined,
        label: period?.label ?? '',
        date: isoDay(start),
        status: invoice?.status ?? 'unknown',
        amount: centsToMajor(invoice?.total ?? invoice?.subtotal),
        projected: false,
        hostedUrl: invoice?.hostedInvoiceUrl ?? null
      }
    })
    .sort(byDayDesc)

  const totalBilled = invoices.filter((i) => !i.projected).reduce((sum, i) => sum + i.amount, 0)

  return {
    subscription,
    invoices,
    totalBilled: round2(totalBilled)
  }
}

// Card on file + billing contact. Greptile's tRPC carries no payment method — it lives only in Stripe,
// reached via the latest finalized invoice's hostedInvoiceUrl. The Stripe walk (ephemeral-key mint →
// hosted-invoice fetch) is a live-account-only path not replayable from fixtures; `parseStripeHostedInvoice`
// is the pure normalizer for the Stripe responses.

export type GreptilePaymentMethod = {
  brand: string
  last4: string
  expMonth: number
  expYear: number
  funding: string
}

export type GreptileBillingContact = {
  name: string
  email: string
}

type RawStripeCard = {
  brand?: string
  display_brand?: string
  last4?: string
  exp_month?: number
  exp_year?: number
  funding?: string
}

type RawStripePaymentMethod = {
  type?: string
  card?: RawStripeCard | null
  billing_details?: { name?: string | null; email?: string | null } | null
}

export type RawStripeHostedInvoice = {
  customer_name?: string | null
  customer_email?: string | null
  payment_intent?: { payment_method?: RawStripePaymentMethod | null } | null
  payments_array?: Array<{
    payment_intent_client?: { payment_method?: RawStripePaymentMethod | null } | null
  }> | null
}

const firstStripePaymentMethod = (raw: RawStripeHostedInvoice): RawStripePaymentMethod | null =>
  raw.payment_intent?.payment_method ??
  raw.payments_array?.find((p) => p?.payment_intent_client?.payment_method)?.payment_intent_client?.payment_method ??
  null

// Both fields are null when Stripe didn't carry them.
export const parseStripeHostedInvoice = (
  raw: RawStripeHostedInvoice | null | undefined
): { paymentMethod: GreptilePaymentMethod | null; contact: GreptileBillingContact | null } => {
  if (!raw) {
    return { paymentMethod: null, contact: null }
  }

  const pm = firstStripePaymentMethod(raw)
  const card = pm?.card ?? null
  const paymentMethod: GreptilePaymentMethod | null = pm
    ? {
        brand: card?.display_brand ?? card?.brand ?? pm.type ?? 'unknown',
        last4: card?.last4 ?? '',
        expMonth: card?.exp_month ?? 0,
        expYear: card?.exp_year ?? 0,
        funding: card?.funding ?? ''
      }
    : null

  const name = raw.customer_name ?? pm?.billing_details?.name ?? ''
  const email = raw.customer_email ?? pm?.billing_details?.email ?? ''
  const contact: GreptileBillingContact | null = name || email ? { name, email } : null

  return { paymentMethod, contact }
}

// Summary tab — the lean overview the cross-service Overview rolls up (spend.mtd): the in-progress period's
// running total, the headline subscription stats, and the monthly-spend trend chart. The subscription
// record, line items, payment method, and the invoice list are the Billing tab's detail — not here.
export const buildGreptileSummaryResult = (billingData: GreptileBilling): CapabilityResult => {
  const sub = billingData.subscription

  return billing.summary({
    // 0 stays (the Overview reads the current-month bar) rather than nulling out and dropping the service from
    // the Overview when the provider rolls its period and the open running total is momentarily 0.
    currentMtd: sub.currentTotalUsd,
    currentMtdLabel: 'This period',
    // Usage-metered spend accruing live over the open period.
    mtdBasis: 'accrued',
    plan: sub.model,
    invoices: billingData.invoices.map((i) => ({
      date: i.date,
      amount: i.amount,
      status: i.status,
      hostedUrl: i.hostedUrl ?? null
    })),
    stats: [
      { key: 'seatCost', label: 'Seats', role: 'money', value: sub.seatCostUsd },
      { key: 'overageCost', label: 'Overage', role: 'money', value: sub.overageCostUsd },
      { key: 'activeDevs', label: 'Active devs', role: 'count', value: sub.activeDevs }
    ]
  })
}

// Billing tab — the financial detail (not the Overview rollup; the headline + chart live on Summary): the
// subscription account record (plan, status, period, the cost breakdown + total billed), the (optional)
// payment-method + billing-contact records, and the downloadable invoice history. Greptile invoices carry a
// `hostedInvoiceUrl` only (no PDF byte source), so the invoice list is a plain table with a `url` column.

type BillingAccountRow = {
  plan: string
  status: string
  period: string | null
  seatPrice: number
  overagePrice: number
  includedReviewsPerDev: number
  credit: number
  totalBilled: number
}

type PaymentMethodRow = {
  brand: string | null
  last4: string | null
  expiry: string | null
  funding: string | null
}

type BillingContactRow = {
  name: string | null
  email: string | null
}

type BillingInvoiceRow = {
  // Hidden — the Stripe invoice id rides as the ledger key so a finalized invoice accumulates past the fetch
  // window. Present on every non-projected row (a finalized period always carries its invoiceId).
  id: string
  date: string | null
  label: string
  amount: number
  status: string
  hostedUrl: string | null
}

export const buildGreptileBillingTab = (
  billing: GreptileBilling,
  payment?: { paymentMethod: GreptilePaymentMethod | null; contact: GreptileBillingContact | null } | null
): CapabilityResult => {
  const sub = billing.subscription
  // The subscription's own period window isn't on the report; the open invoice's period stands in.
  const open = billing.invoices.find((i) => i.projected)

  const account = record<BillingAccountRow>({
    id: 'account',
    fields: [
      { key: 'plan', label: 'Plan', role: 'label' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'period', label: 'Current period', role: 'label' },
      { key: 'seatPrice', label: 'Seat price', role: 'money' },
      { key: 'overagePrice', label: 'Overage price', role: 'money' },
      { key: 'includedReviewsPerDev', label: 'Included reviews / dev', role: 'count' },
      { key: 'credit', label: 'Credit balance', role: 'money' },
      { key: 'totalBilled', label: 'Total billed (all time)', role: 'money' }
    ],
    value: {
      plan: startCase(sub.model),
      status: sub.status,
      period: open?.label ?? null,
      seatPrice: sub.seatPriceUsd,
      overagePrice: sub.overagePriceUsd,
      includedReviewsPerDev: sub.includedReviewsPerDev,
      credit: sub.creditBalanceUsd,
      totalBilled: billing.totalBilled
    }
  })

  const pm = payment?.paymentMethod ?? null
  const paymentMethod = pm
    ? record<PaymentMethodRow>({
        id: 'paymentMethod',
        fields: [
          { key: 'brand', label: 'Card', role: 'label' },
          { key: 'last4', label: 'Last 4', role: 'label' },
          { key: 'expiry', label: 'Expires', role: 'label' },
          { key: 'funding', label: 'Funding', role: 'label' }
        ],
        value: {
          brand: pm.brand,
          last4: pm.last4 || null,
          expiry: pm.expMonth && pm.expYear ? `${String(pm.expMonth).padStart(2, '0')}/${pm.expYear}` : null,
          funding: pm.funding || null
        }
      })
    : null

  const c = payment?.contact ?? null
  const contact = c
    ? record<BillingContactRow>({
        id: 'billingContact',
        fields: [
          { key: 'name', label: 'Name', role: 'label' },
          { key: 'email', label: 'Email', role: 'label' }
        ],
        value: { name: c.name || null, email: c.email || null }
      })
    : null

  const invoices = table<BillingInvoiceRow>({
    id: 'invoices',
    columns: [
      { key: 'date', label: 'Date', role: 'timestamp' },
      { key: 'label', label: 'Period', role: 'label' },
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'hostedUrl', label: 'Invoice', role: 'url' },
      { key: 'id', role: 'identifier', hidden: true }
    ],
    rows: billing.invoices
      .filter((i) => !i.projected)
      .map((i, idx) => ({
        id: i.id ?? `inv-${idx}`,
        date: i.date ?? null,
        label: i.label || '—',
        amount: i.amount,
        status: i.status,
        hostedUrl: i.hostedUrl ?? null
      })),
    // The Stripe invoice id is a stable, unique identity for each finalized invoice — key it so an invoice
    // accumulates in the ledger past the fetch window.
    key: 'id'
  })

  return capabilityResult({
    sections: [
      account.keyvalue({ title: 'Subscription' }),
      paymentMethod?.keyvalue({ title: 'Payment method' }) ?? null,
      contact?.keyvalue({ title: 'Billing contact' }) ?? null,
      invoices.dataset.rows.length > 0 ? invoices.table({ title: 'Invoices' }) : null
    ]
  })
}

// The raw billing bundle Summary + Billing share: the period list joined to its per-month invoice, plus the
// subscription / current-period-cost / flex-usage payloads. `buildGreptileBillingFromRaw` is the pure
// raw→normalized step both tabs derive from.
export type GreptileBillingRaw = {
  periods: PeriodWithInvoice[]
  sub: RawSubscriptionInfo | null
  costs: RawCurrentPeriodCosts | null
  flex: RawFlexUsageStatus | null
}

// Summary always wants every period (its monthly-paid trend spans all history); Billing opts into incremental
// fetch (see the `billing` capability decl below), so its `ctx.since` is set on every run but the first —
// `relevant` then keeps only the open period plus periods at/after the watermark, and core's stored union
// retains the finalized periods this run omits. Returning an omitted period here (even with `invoice: null`)
// would instead overwrite its stored invoice on merge, so filtering it OUT of the result is what preserves it.
export const fetchGreptileBilling = async (ctx: CollectContext<GreptileConfig>): Promise<GreptileBillingRaw> => {
  const [periods, sub, costs, flex] = await Promise.all([
    trpcQuery<RawBillingPeriod[]>(ctx, 'billing.getCodeReviewBillingPeriods', tenantInput(ctx)),
    trpcQuery<RawSubscriptionInfo>(ctx, 'billing.getSubscriptionInfo', tenantInput(ctx)),
    trpcQuery<RawCurrentPeriodCosts>(ctx, 'billing.getCurrentPeriodCosts', tenantInput(ctx)),
    trpcQuery<RawFlexUsageStatus>(ctx, 'billing.getFlexUsageStatus', tenantInput(ctx))
  ])

  const relevant = (periods ?? []).filter((p) => !p?.invoiceId || !ctx.since || (p.startTime ?? '') >= ctx.since)

  // Fetch each finalized month's invoice; tolerate per-invoice failures (one 4xx on a historical invoice
  // shouldn't blank the whole tab).
  const joined = await Promise.all(
    relevant.map(async (period): Promise<PeriodWithInvoice> => {
      const id = period.invoiceId ?? 'open'

      if (!period?.invoiceId) {
        return { id, startTime: period.startTime, period, invoice: null }
      }

      const invoice = await trpcQuery<RawUpcomingInvoice>(ctx, 'billing.getUpcomingInvoice', {
        json: { tenantExternalId: tenantId(ctx), invoiceId: period.invoiceId }
      }).catch(() => null)

      return { id, startTime: period.startTime, period, invoice }
    })
  )

  return { periods: joined, sub: sub ?? null, costs: costs ?? null, flex: flex ?? null }
}

export const buildGreptileBillingFromRaw = (raw: GreptileBillingRaw): GreptileBilling =>
  buildGreptileBilling(raw.periods, raw.sub, raw.costs, raw.flex)

// ── usage ─────────────────────────────────────────────────────────────────────────────
// `pullRequest.getDailyReviewUsage` → daily web + CLI review counts + per-author breakdown (reviews,
// overage/"flex", seats) for the current billing period; `billing.getFlexUsageStatus` adds the period
// window + projected overage charge (cents). Counts, not money, except the projected flex charge.

export type RawDailyPoint = {
  date?: string
  codeReview?: number
  cliReview?: number
}

export type RawAuthor = {
  authorId?: string
  authorLogin?: string
  webReviewCount?: number
  webFlexCount?: number
  cliReviewCount?: number
  cliFlexCount?: number
  seatPeriods?: number
}

export type RawDailyReviewUsage = {
  daily?: RawDailyPoint[]
  authors?: RawAuthor[]
}

export type GreptileDailyPoint = {
  date: string
  codeReview: number
  cliReview: number
}

export type GreptileAuthor = {
  login: string
  webReviews: number
  cliReviews: number
  totalReviews: number
  totalFlex: number
  seats: number
}

export type GreptileUsage = {
  periodStart?: string
  periodEnd?: string
  daily: GreptileDailyPoint[]
  authors: GreptileAuthor[]
  totalCodeReviews: number
  totalCliReviews: number
  flexUsageReviewCount: number
  projectedFlexChargeUsd: number
}

// Daily points drop undated rows; sorted oldest→newest.
export const buildGreptileUsage = (
  rawDaily: RawDailyReviewUsage | null | undefined,
  rawFlex: RawFlexUsageStatus | null | undefined
): GreptileUsage => {
  const daily: GreptileDailyPoint[] = (rawDaily?.daily ?? [])
    .map((d) => ({ date: isoDay(d.date) ?? '', codeReview: d.codeReview ?? 0, cliReview: d.cliReview ?? 0 }))
    .filter((d) => d.date !== '')
    .sort(byDayAsc)

  const authors: GreptileAuthor[] = (rawDaily?.authors ?? []).map((a) => {
    const web = a.webReviewCount ?? 0
    const cli = a.cliReviewCount ?? 0

    return {
      login: a.authorLogin || '(unknown)',
      webReviews: web,
      cliReviews: cli,
      totalReviews: web + cli,
      totalFlex: (a.webFlexCount ?? 0) + (a.cliFlexCount ?? 0),
      seats: a.seatPeriods ?? 0
    }
  })

  return {
    periodStart: isoDay(rawFlex?.currentPeriodStart),
    periodEnd: isoDay(rawFlex?.currentPeriodEnd),
    daily,
    authors,
    totalCodeReviews: daily.reduce((sum, d) => sum + d.codeReview, 0),
    totalCliReviews: daily.reduce((sum, d) => sum + d.cliReview, 0),
    flexUsageReviewCount: rawFlex?.flexUsageReviewCount ?? 0,
    projectedFlexChargeUsd: centsToMajor(rawFlex?.projectedNetFlexUsageChargeCents)
  }
}

// Compose the usage result: review-count metrics (projected flex charge carries its USD cost) + an
// optional daily web-reviews timeseries + an optional per-author breakdown table.
export const buildGreptileUsageResult = (usageData: GreptileUsage): CapabilityResult => {
  const result = usage.result({
    periodStart: usageData.periodStart,
    periodEnd: usageData.periodEnd,
    metrics: [
      { label: 'Web reviews', value: usageData.totalCodeReviews, unit: 'reviews' },
      { label: 'CLI reviews', value: usageData.totalCliReviews, unit: 'reviews' },
      {
        label: 'Overage reviews',
        value: usageData.flexUsageReviewCount,
        unit: 'reviews',
        cost: usageData.projectedFlexChargeUsd
      }
    ]
  })

  const dailySeries = usageData.daily.length
    ? table<GreptileDailyPoint>({
        id: 'daily',
        columns: [
          { key: 'date', label: 'Date', role: 'timestamp' },
          { key: 'codeReview', label: 'Web reviews', role: 'count' },
          { key: 'cliReview', label: 'CLI reviews', role: 'count' }
        ],
        rows: usageData.daily,
        // One row per day, so the ISO day is its stable identity — each day accumulates in the ledger.
        key: 'date'
      }).timeseries({ x: 'date', y: 'codeReview', granularity: 'daily', title: 'Daily web reviews' })
    : null

  const authorTable = usageData.authors.length
    ? table<GreptileAuthor>({
        id: 'authors',
        columns: [
          { key: 'login', label: 'Author', role: 'label' },
          { key: 'webReviews', label: 'Web', role: 'count' },
          { key: 'cliReviews', label: 'CLI', role: 'count' },
          { key: 'totalReviews', label: 'Total', role: 'count' },
          { key: 'totalFlex', label: 'Overage', role: 'count' },
          { key: 'seats', label: 'Seats', role: 'count' }
        ],
        rows: usageData.authors,
        // The author login is each author's stable identity, so per-author review counts accumulate in the ledger.
        key: 'login'
      }).table({ title: 'By author' })
    : null

  return addSections(result, dailySeries, authorTable)
}

// `getDailyReviewUsage` carries `z.date()` start/end (and per-period start/end) + an `undefined`
// namespaceId — all need their superjson `meta` markers verbatim so the server revives them before zod
// validation. Omitting `['Date']` would send the dates as plain strings and fail `z.date()`.
const dailyUsageInput = (ctx: CollectContext<GreptileConfig>, startIso: string, endIso: string): SuperjsonInput => ({
  json: {
    tenantExternalId: tenantId(ctx),
    startTime: startIso,
    endTime: endIso,
    namespaceId: null,
    billingPeriods: [{ startTime: startIso, endTime: endIso }]
  },
  meta: {
    values: {
      startTime: ['Date'],
      endTime: ['Date'],
      namespaceId: ['undefined'],
      'billingPeriods.0.startTime': ['Date'],
      'billingPeriods.0.endTime': ['Date']
    },
    v: 1
  }
})

// The raw usage bundle: the daily web/CLI review counts (+ per-author breakdown) joined to the flex-usage
// status that scopes the query window and carries the projected overage charge.
export type GreptileUsageRaw = {
  daily: RawDailyReviewUsage | null
  flex: RawFlexUsageStatus | null
}

const fetchGreptileUsage = async (ctx: CollectContext<GreptileConfig>): Promise<GreptileUsageRaw> => {
  // The flex-usage status carries the current billing-period window, which scopes the daily query. Fall
  // back to a trailing-30-day window if it's missing.
  const flex = (await trpcQuery<RawFlexUsageStatus>(ctx, 'billing.getFlexUsageStatus', tenantInput(ctx))) ?? {}
  const end = flex.currentPeriodEnd ?? new Date().toISOString()
  const start = flex.currentPeriodStart ?? isoDaysAgo(30)

  const daily =
    (await trpcQuery<RawDailyReviewUsage>(ctx, 'pullRequest.getDailyReviewUsage', dailyUsageInput(ctx, start, end))) ??
    {}

  return { daily, flex }
}

// ── apiKeys ───────────────────────────────────────────────────────────────────────────
// `apikey.list` returns the org's API keys with name / id / createdAt — NO secret material (the token is
// only shown once at creation), so this is a safe read-only inventory.

export type RawApiKey = {
  id?: string
  name?: string
  createdAt?: string
}

export type RawApiKeyList = {
  items?: RawApiKey[]
  total?: number
}

// No masked secret column: the listing carries no secret material.
export const buildGreptileKeys = (raw: RawApiKeyList | null | undefined): ApiKeysInput => ({
  keys: (raw?.items ?? []).map((k) => ({
    id: String(k.id ?? ''),
    name: k.name || '(unnamed)',
    createdAt: k.createdAt ?? undefined
  }))
})

// `apikey.list` input: `search` is an optional string passed `undefined`, so it needs its `['undefined']`
// superjson marker; pageSize is bumped to list every key in one page.
const keysInput = (ctx: CollectContext<GreptileConfig>): SuperjsonInput => ({
  json: {
    tenantExternalId: tenantId(ctx),
    page: 0,
    pageSize: 100,
    search: null,
    sortField: 'createdAt',
    sortDirection: 'desc'
  },
  meta: { values: { search: ['undefined'] }, v: 1 }
})

const fetchGreptileKeys = (ctx: CollectContext<GreptileConfig>): Promise<RawApiKeyList> =>
  trpcQuery<RawApiKeyList>(ctx, 'apikey.list', keysInput(ctx))

// ── members ─────────────────────────────────────────────────────────────────────────
// `organization.searchPeople` (empty query, large page) returns everyone with dashboard access plus any
// pending invites — each item carries a `type` ('member' vs an invite kind), an email, and a role. The
// dashboard surfaces no name (the avatar is the email's initial), so the roster is email + role + status.
// No secret material. An invite surfaces with a 'pending' status.

export type RawPerson = {
  type?: string
  email?: string
  role?: string | null
}

export type RawSearchPeople = {
  items?: RawPerson[]
}

export type GreptileMember = {
  email: string
  role: string | null
  status: 'active' | 'pending'
}

// Active members first, then pending invites; alphabetical by email within each. Rows without an email are
// dropped (the roster keys on email).
export const buildGreptileMembers = (raw: RawSearchPeople | null | undefined): GreptileMember[] =>
  (raw?.items ?? [])
    .filter((p): p is RawPerson & { email: string } => typeof p.email === 'string' && !!p.email)
    .map((p) => ({
      email: p.email,
      role: p.role ?? null,
      status: p.type === 'member' ? ('active' as const) : ('pending' as const)
    }))
    .sort((a, b) => (a.status === b.status ? a.email.localeCompare(b.email) : a.status === 'active' ? -1 : 1))

// Email / role / status, keyed by email. Role + status render as case-insensitively-toned badges.
export const buildGreptileMembersResult = (members: GreptileMember[]): CapabilityResult =>
  capabilityResult({
    sections: [
      table<GreptileMember>({
        id: 'members',
        columns: [
          { key: 'email', label: 'Email', role: 'identifier' },
          { key: 'role', label: 'Role', role: 'category' },
          { key: 'status', label: 'Status', role: 'status' }
        ],
        rows: members,
        key: 'email',
        // A roster is the complete current-state set: a user the service stops returning has lost access.
        retention: 'snapshot'
      }).table({ title: 'Members' })
    ]
  })

// All fields are defined → no superjson `meta`.
const peopleInput = (ctx: CollectContext<GreptileConfig>): SuperjsonInput => ({
  json: { tenantExternalId: tenantId(ctx), query: '', pageSize: 100 }
})

const fetchGreptileMembers = (ctx: CollectContext<GreptileConfig>): Promise<RawSearchPeople> =>
  trpcQuery<RawSearchPeople>(ctx, 'organization.searchPeople', peopleInput(ctx))

// ── descriptor ──────────────────────────────────────────────────────────────────────
export const greptileConfigSchema = defineConfigSchema([
  {
    key: 'tenantExternalId',
    label: 'Organization',
    kind: 'combobox',
    required: true,
    placeholder: 'Pick your organization…',
    help: 'The org Butin reads. The list comes from your session; pick one instead of pasting its UUID.',
    loadOptions: async (ctx) => buildGreptileOrgOptions(await fetchGreptileOrgs((url) => ctx.client.get(url)))
  }
])

export type GreptileConfig = ConfigOf<typeof greptileConfigSchema>

export const greptilePlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'greptile',
    name: 'Greptile',
    vendor: 'Greptile',
    category: 'devtools',
    color: '#28e99f',
    description: 'Greptile AI code-review — spend summary, billing detail, daily review usage, API keys, and members.',
    homepage: 'https://greptile.com',
    dashboardUrl: 'https://app.greptile.com'
  },
  session: {
    loginUrl: 'https://app.greptile.com/login',
    dashboardMarkers: ['/settings', '/reviews', '/-/'],
    cookieDomains: ['greptile.com'],
    // The chunked Auth.js session cookie — wait for the first chunk before grabbing the jar.
    requiredCookie: '__Secure-authjs.session-token.0',
    // Login is Auth.js fronting Ory Hydra (auth.greptile.com). When the session expires, re-seeding the saved jar
    // puts BOTH a dead session token AND stale Hydra CSRF cookies (ory_hydra_login_csrf_<hash>) back into the
    // window; the fresh sign-in then trips "CSRF value from the token does not match the CSRF value from the data
    // store" / "session expired" and bounces back to /login until cookies are cleared by hand. Clearing only the
    // CSRF cookies isn't enough — the dead session token still wedges it. So start every sign-in from a clean jar
    // and never re-seed (Google SSO on the shared partition stays intact, so re-login is one click). Headless
    // replay still uses the captured credential.
    persistCookies: false
  },
  auth: { kind: 'cookie' },
  transport: {
    baseUrl: ORIGIN,
    defaultHeaders: {
      Accept: '*/*',
      'content-type': 'application/json',
      'x-trpc-source': 'nextjs-react',
      'x-timezone': 'UTC',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  },
  config: greptileConfigSchema,
  capabilities: [
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: fetchGreptileBilling,
      build: (raw) => buildGreptileSummaryResult(buildGreptileBillingFromRaw(raw)),
      sample: sampleGreptileBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchGreptileBilling,
      build: (raw) => buildGreptileBillingTab(buildGreptileBillingFromRaw(raw)),
      sample: sampleGreptileBilling,
      // No `window` — core applies its default trailing horizon, which is harmless here: finalized invoices are
      // immutable, so any re-fetched period just dedupes onto the same stored row.
      incremental: { listKey: 'periods', id: 'id', timestamp: 'startTime' }
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchGreptileUsage,
      build: (raw) => buildGreptileUsageResult(buildGreptileUsage(raw.daily, raw.flex)),
      sample: sampleGreptileUsage
    }),
    defineCapability({
      id: 'apiKeys',
      label: 'API Keys',
      fetch: fetchGreptileKeys,
      build: (raw) => keys.result(buildGreptileKeys(raw)),
      sample: sampleGreptileKeys
    }),
    defineCapability({
      id: 'members',
      label: 'Members',
      fetch: fetchGreptileMembers,
      build: (raw) => buildGreptileMembersResult(buildGreptileMembers(raw)),
      sample: sampleGreptilePeople
    })
  ],
  probe: async (ctx) => {
    // Listing API keys is the cheapest authed tRPC call — a 200 proves the NextAuth session is live.
    await trpcQuery(ctx, 'apikey.list', keysInput(ctx))
  }
})

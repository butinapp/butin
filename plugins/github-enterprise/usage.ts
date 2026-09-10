import { type CollectContext } from '@butinapp/sdk'
import { capabilityResult, record, table, type CapabilityResult } from '@butinapp/sdk/data'
import { byDayAsc, isoDay, round2 } from '@butinapp/sdk/util'

import { makeDashboard } from './dashboard.js'

// GitHub Enterprise usage — per-product metered spend for the current billing period, off the
// github.com billing dashboard.
//
// Money is already DOLLARS (e.g. totalGrossAmount 167.758860223 → $167.76); NO cents conversion.
// Amounts are high-precision floats — round only for display. gross = list price, discount =
// enterprise/committed discount, net = what's actually billed (gross − discount). An enterprise can
// run ~100% discount on a product, so net is often 0 while gross is not — we surface all three.
//
// Sources (all JSON, all gated by the verified-fetch nonce):
//   - GET /enterprises/<slug>/billing/usage/total → { usage: { totalGrossAmount } } (authoritative gross)
//   - GET /enterprises/<slug>/billing/net_usage?group=0&period=3&product=<P>&sku=&query=
//       → { usage: [{ grossAmount, netAmount, discountAmount, product, sku, friendlySkuName,
//                     quantity, unitType, usageAt }] } — once per product; aggregated to per-product
//       (+ per-SKU) and per-day totals.

// period=3 is the current-period selector; group=0 returns un-grouped per-SKU rows.
const PERIOD = 3
const NET_USAGE_GROUP = 0

// Product slugs the dashboard queries net-usage for, with display names.
export const GITHUB_PRODUCTS: Array<{ slug: string; label: string }> = [
  { slug: 'actions', label: 'Actions' },
  { slug: 'copilot', label: 'Copilot' },
  { slug: 'codespaces', label: 'Codespaces' },
  { slug: 'ghas', label: 'Advanced Security' },
  { slug: 'git-lfs', label: 'Git LFS' },
  { slug: 'models', label: 'Models' },
  { slug: 'packages', label: 'Packages' },
  { slug: 'spark', label: 'Spark' }
]

// --- raw shapes (only the fields we use) ---

export type RawUsageTotal = {
  usage?: { totalGrossAmount?: number }
}

export type RawNetUsageRow = {
  grossAmount?: number
  netAmount?: number
  discountAmount?: number
  product?: string
  sku?: string
  friendlySkuName?: string
  quantity?: number
  unitType?: string
  /** ISO timestamp. */
  usageAt?: string
}

export type RawNetUsage = {
  usage?: RawNetUsageRow[]
}

/** One product's raw net-usage response, tagged with the product we asked for. */
export type ProductNetUsage = {
  slug: string
  label: string
  raw: RawNetUsage
}

/** The raw usage bundle a fetch returns: the authoritative gross total + each product's net-usage rows. */
export type GithubUsageRaw = {
  total: RawUsageTotal
  perProduct: ProductNetUsage[]
}

type SkuUsage = {
  sku: string
  name: string
  gross: number
}

type UsageRecord = {
  gross: number
  discount: number
  net: number
  products: number
}

type ProductRow = {
  product: string
  net: number
  gross: number
  discount: number
  skus: string
}

type DailyRow = {
  date: string
  net: number
  gross: number
  discount: number
}

// Pure transform — fixture-tested. Aggregates each product's rows to gross/net/discount (+ per-SKU
// names) and folds every row into a per-day gross/net/discount trend. Products with no usage are
// dropped; both tables sort by spend/date. `total`'s authoritative gross headlines the summary record
// (falling back to the summed gross when absent).
export const buildGithubUsage = (total: RawUsageTotal, perProduct: ProductNetUsage[]): CapabilityResult => {
  const productRows: ProductRow[] = []
  const dailyMap = new Map<string, { gross: number; net: number; discount: number }>()
  let summedGross = 0
  let totalNet = 0
  let totalDiscount = 0

  for (const { label, raw } of perProduct) {
    const usage = raw?.usage ?? []

    if (usage.length === 0) {
      continue
    }

    const skuMap = new Map<string, SkuUsage>()
    let gross = 0
    let net = 0
    let discount = 0

    for (const r of usage) {
      const g = r.grossAmount ?? 0

      gross += g
      net += r.netAmount ?? 0
      discount += r.discountAmount ?? 0

      const skuKey = r.sku ?? r.friendlySkuName ?? 'unknown'
      const existing = skuMap.get(skuKey)

      if (existing) {
        existing.gross += g
      } else {
        skuMap.set(skuKey, { sku: skuKey, name: r.friendlySkuName ?? skuKey, gross: g })
      }

      const date = isoDay(r.usageAt)

      if (date) {
        const d = dailyMap.get(date) ?? { gross: 0, net: 0, discount: 0 }

        d.gross += g
        d.net += r.netAmount ?? 0
        d.discount += r.discountAmount ?? 0
        dailyMap.set(date, d)
      }
    }

    summedGross += gross
    totalNet += net
    totalDiscount += discount

    const skus = Array.from(skuMap.values())
      .sort((a, b) => b.gross - a.gross)
      .map((s) => s.name)
      .join(' · ')

    productRows.push({ product: label, gross: round2(gross), discount: round2(discount), net: round2(net), skus })
  }

  productRows.sort((a, b) => b.gross - a.gross)

  const dailyRows: DailyRow[] = Array.from(dailyMap.entries())
    .map(([date, v]) => ({ date, gross: round2(v.gross), net: round2(v.net), discount: round2(v.discount) }))
    .sort(byDayAsc)

  const totalGross = total?.usage?.totalGrossAmount ?? summedGross

  const usage = record<UsageRecord>({
    id: 'usage',
    fields: [
      { key: 'gross', label: 'Gross usage', role: 'money' },
      { key: 'discount', label: 'Discount', role: 'money' },
      { key: 'net', label: 'Net billed', role: 'money' },
      { key: 'products', label: 'Products with usage', role: 'count' }
    ],
    value: {
      gross: round2(totalGross),
      discount: round2(totalDiscount),
      net: round2(totalNet),
      products: productRows.length
    }
  })

  const products = table<ProductRow>({
    id: 'products',
    columns: [
      { key: 'product', label: 'Product', role: 'label' },
      { key: 'net', label: 'Net', role: 'money' },
      { key: 'gross', label: 'Gross', role: 'money' },
      { key: 'discount', label: 'Discount', role: 'money' },
      { key: 'skus', label: 'SKUs', role: 'text' }
    ],
    rows: productRows,
    // One row per product (aggregated), so the product name is its stable identity in the ledger.
    key: 'product'
  })

  const daily = table<DailyRow>({
    id: 'daily',
    columns: [
      { key: 'date', label: 'Day', role: 'timestamp' },
      { key: 'net', label: 'Net', role: 'money' },
      { key: 'gross', label: 'Gross', role: 'money' },
      { key: 'discount', label: 'Discount', role: 'money' }
    ],
    rows: dailyRows,
    // One row per day, so the ISO day is its stable identity — each day's usage accumulates in the ledger.
    key: 'date'
  })

  return capabilityResult({
    sections: [
      usage.stat(),
      products.table({ title: 'Usage by product' }),
      // The metered figures are a per-day trend off the billing dashboard's usageAt timestamps.
      dailyRows.length > 0
        ? daily.timeseries({ x: 'date', y: 'net', granularity: 'daily', title: 'Daily net usage' })
        : null,
      dailyRows.length > 0 ? daily.table({ title: 'Daily usage' }) : null
    ],
    // Only headline a net-spend figure when there's actually usage (avoid a misleading $0 on an account
    // with no enterprise metered usage).
    summaries:
      productRows.length > 0
        ? [{ section: 'other', label: 'Net usage', value: round2(totalNet), role: 'money' }]
        : undefined
  })
}

// The bundle wrapper over the fixture-tested two-arg buildGithubUsage — the pure raw → result transform.
export const buildGithubUsageResult = (raw: GithubUsageRaw): CapabilityResult =>
  buildGithubUsage(raw.total ?? {}, raw.perProduct)

export const fetchGithubUsage = async (ctx: CollectContext): Promise<GithubUsageRaw> => {
  const dash = makeDashboard(ctx)
  const [total, ...perProduct] = await Promise.all([
    // Un-caught: a dead session 401s here and propagates so core can clear the cookie (re-prompt login).
    dash.getJson<RawUsageTotal>(`${dash.billingBase}/usage/total`),
    ...GITHUB_PRODUCTS.map(async ({ slug, label }): Promise<ProductNetUsage> => {
      // A single product failing (e.g. not enabled) shouldn't sink the report — fall back to empty.
      // Endpoint is `net_usage` (underscore); the dashboard always sends empty `sku`/`query` filters.
      const raw = await dash
        .getJson<RawNetUsage>(`${dash.billingBase}/net_usage`, {
          group: NET_USAGE_GROUP,
          period: PERIOD,
          product: slug,
          sku: '',
          query: ''
        })
        .catch(() => ({ usage: [] }) as RawNetUsage)

      return { slug, label, raw }
    })
  ])

  return { total: total ?? {}, perProduct }
}

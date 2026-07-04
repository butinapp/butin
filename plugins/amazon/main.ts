import { type CollectContext, defineCapability, definePlugin } from '@butinapp/sdk'
import { type CapabilityResult, table } from '@butinapp/sdk/data'
import { billing } from '@butinapp/sdk/presets'
import { currentMonthKey, parseDollarAmount, round2 } from '@butinapp/sdk/util'
import * as cheerio from 'cheerio'

import { sampleAmazonBilling } from './sample.js'

// Amazon (amazon.ca retail) — your order history as billing: each order's date + grand total drive the monthly
// spend rollup, and its invoice PDFs are downloadable. Amazon exposes NO JSON billing API — the Your-Orders
// pages are server-rendered HTML and each order's invoice PDFs come from an AJAX "invoice popover" fragment —
// so everything is scraped with cheerio.
//
// AUTH is a plain cookie session — the `.amazon.ca` login cookies (`at-acbca` the durable auth token,
// `session-id`, `sess-at-acbca`, …) replayed verbatim. No bearer, no minting.
//
// TRANSPORT: amazon.ca is fronted by CloudFront + AWS WAF (the `aws-waf-token` cookie), which challenges plain
// Node TLS clients, so this runs on the Electron engine (real browser TLS identity) via requiresBrowserEngine.
//
// SCOPE: one billing capability. There is intentionally no "usage" capability — the `unagi*.amazon.com/1/events/*`
// traffic a recording captures is ad-impression telemetry, not account usage.

const ORIGIN = 'https://www.amazon.ca'
const CURRENCY = 'CAD'

// ── shared parsers (the fixture-tested core) ──────────────────────────────────────────

// Root-relative hrefs as Amazon returns them → absolute against the marketplace origin (already-absolute passes
// through).
const absolutize = (href: string, origin = ORIGIN): string =>
  /^https?:\/\//.test(href) ? href : `${origin}${href.startsWith('/') ? '' : '/'}${href}`

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

// `December 2, 2024` → `2024-12-02`. Amazon order cards render the placed/charged date in this long form; an
// unrecognized string degrades to undefined (an undated order still counts toward totals, just not the chart).
export const parseAmazonDate = (text?: string): string | undefined => {
  const m = (text ?? '').trim().match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/)
  const month = m && MONTHS[m[1]!.toLowerCase()]

  return m && month ? `${m[3]}-${month}-${m[2]!.padStart(2, '0')}` : undefined
}

// One order scraped from a Your-Orders card.
export interface AmazonOrder {
  orderId: string
  /** 'YYYY-MM-DD' from the card's "Order placed" / "Subscription charged on" date. */
  date?: string
  /** Grand total in CAD dollars. */
  total: number
  /** The recipient name from the card's "Ship to" cell (the full address lives on the order-detail page). */
  recipient?: string
  /** The order's line-item product titles (the card lists each item under `.yohtmlc-product-title`). */
  items?: string[]
  /** Relative invoice-popover URL (carries the per-render relatedRequestId) for fetching the order's PDFs. */
  popoverUrl?: string
}

// Scrape the order cards out of one Your-Orders page. Each `.order-card` carries the id, a caps-labelled header
// grid (`Order placed`/`Subscription charged on` → date, `Total` → amount), and the invoice control whose
// `data-a-popover` holds the popover URL. Pure — fixture-tested, tolerant of shape drift (skips a card with no id).
export const parseOrders = (html: string): AmazonOrder[] => {
  const $ = cheerio.load(html || '')
  const orders: AmazonOrder[] = []

  $('.order-card').each((_, card) => {
    const $c = $(card)
    const orderId = $c.find('.yohtmlc-order-id span[dir="ltr"]').first().text().trim()

    if (!orderId) {
      return
    }

    let date: string | undefined
    let total = 0
    let recipient: string | undefined

    // Each header field is a caps label + its value, in the same `.a-column`; the value is the column text with
    // the label prefix removed.
    $c.find('.a-text-caps').each((_, caps) => {
      const label = $(caps).text().replace(/\s+/g, ' ').trim()
      const column = $(caps).closest('.a-column').text().replace(/\s+/g, ' ').trim()
      const value = column.startsWith(label) ? column.slice(label.length).trim() : column

      if (/^(Order placed|Subscription charged on)$/i.test(label)) {
        date = parseAmazonDate(value)
      } else if (/^Total$/i.test(label)) {
        total = parseDollarAmount(value)
      } else if (/^Ship to$/i.test(label)) {
        recipient = value
      }
    })

    const popover = $c.find('[data-a-popover*="invoice/popover"]').first().attr('data-a-popover') ?? ''
    const popoverUrl = popover.match(/\/your-orders\/invoice\/popover\?[^"\\]*/)?.[0].replace(/&amp;/g, '&')

    // Each item's product title links to its `/dp/<ASIN>` detail page; the title text IS the line item.
    const items = $c
      .find('.yohtmlc-product-title')
      .map((_, t) => $(t).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(Boolean)

    orders.push({ orderId, date, total, recipient, items, popoverUrl })
  })

  return orders
}

// The years the account actually has orders, read from the Your-Orders time-filter dropdown (`year-2026` …
// `year-2016`). Lets the collector fetch only real years instead of probing empty ones.
export const parseOrderYears = (html: string): string[] => {
  const $ = cheerio.load(html || '')
  const years: string[] = []

  $('#time-filter option, select[name="timeFilter"] option').each((_, o) => {
    const value = $(o).attr('value') ?? ''

    if (/^year-\d{4}$/.test(value)) {
      years.push(value)
    }
  })

  return years
}

// The filtered order count a Your-Orders page reports (`97 orders` / `1 order`, or fr `97 commandes`) — lets the
// collector compute the page count and fetch the rest concurrently instead of paginating until an empty page.
// 0 when absent (the caller falls back to walking pages).
export const parseOrderCount = (html: string): number => {
  const m = (html || '').match(/([\d,]+)\s+(?:orders?|commandes?)\b/i)

  return m ? parseInt(m[1]!.replace(/,/g, ''), 10) || 0 : 0
}

// Parse one invoice-popover HTML fragment into the order's downloadable invoice-PDF paths. The popover lists a
// "Printable Order Summary" link, one or more "Invoice N" PDF links (`/documents/download/<uuid>/invoice.pdf`),
// and a "Request Invoice" contact link — only the PDFs are invoices, so the summary/contact links are dropped.
export const parseInvoicePopover = (html: string): string[] => {
  const $ = cheerio.load(html || '')
  const urls: string[] = []

  $('a').each((_, a) => {
    const href = ($(a).attr('href') ?? '').replace(/&amp;/g, '&')

    if (/\/documents\/download\/[^/]+\/invoice\.pdf/i.test(href)) {
      urls.push(href)
    }
  })

  return [...new Set(urls)]
}

// ── billing capability ────────────────────────────────────────────────────────────────

// One downloadable order row. date/total/orderId/items render; `popoverUrl` + `name` ride hidden — `popoverUrl`
// is what the capability's fetchFile replays to resolve the invoice PDF on demand (never up front).
interface OrderRow {
  date: string | null
  total: number
  orderId: string
  recipient: string
  items: string
  popoverUrl: string
  name: string
}

// Pure transform — fixture-tested. The orders drive the monthly-spend rollup (the headline stat + chart + the
// cross-service Overview spark) AND a downloadable Orders table. The invoice PDFs are NOT fetched here — each
// row carries its popover URL and the host calls fetchFile only for the rows the user actually downloads.
// currentMtd sums the current calendar month's orders (null when none, so the Overview skips Amazon vs charting 0).
export const buildAmazonBilling = (orders: AmazonOrder[] | undefined | null): CapabilityResult => {
  const list = Array.isArray(orders) ? orders : []
  const ym = currentMonthKey()
  const mtd = list.filter((o) => o.date?.startsWith(ym)).reduce((sum, o) => sum + o.total, 0)

  const result = billing.summary({
    currentMtd: mtd > 0 ? round2(mtd) : null,
    // currentMtd is the sum of orders placed this calendar month.
    mtdBasis: 'invoiced',
    currency: CURRENCY,
    invoices: list.map((o) => ({ date: o.date, amount: o.total, status: 'paid' })),
    stats: [{ key: 'orderCount', label: 'Orders', role: 'count', value: list.length }]
  })

  const orders_ = table<OrderRow>({
    id: 'orders',
    columns: [
      { key: 'date', label: 'Order date', role: 'timestamp' },
      { key: 'total', label: 'Total', role: 'money', currency: CURRENCY },
      { key: 'orderId', label: 'Order', role: 'identifier' },
      { key: 'recipient', label: 'Ship to', role: 'label' },
      { key: 'items', label: 'Items', role: 'label', truncate: true },
      { key: 'popoverUrl', role: 'text', hidden: true },
      { key: 'name', role: 'label', hidden: true }
    ],
    rows: list.map((o) => ({
      date: o.date ?? null,
      total: o.total,
      orderId: o.orderId,
      recipient: o.recipient ?? '',
      items: (o.items ?? []).join(', '),
      popoverUrl: o.popoverUrl ?? '',
      name: `Amazon order ${o.orderId}`
    })),
    // Keyed by order id so the ledger accumulates instead of replacing — orders the service ages out of its
    // window survive (the incremental fetch keeps re-pulling only the recent window).
    key: 'orderId'
  }).fileTable({ title: 'Orders', name: 'name', source: { fetch: true }, ext: 'pdf', category: 'Invoices' })

  result.datasets.push(orders_.dataset)
  result.views = [...(result.views ?? []), orders_.view]

  return result
}

// ── collector ───────────────────────────────────────────────────────────────────────
// Only the order LIST is fetched here; the invoice PDFs are resolved lazily by fetchFile, per row, when the
// user downloads. The years come from the page's own time-filter dropdown (only years that have orders), and
// each page reports its order count ("97 orders"), so the exact page set is known up front and fetched
// CONCURRENTLY (pace:false + a bounded pool) instead of paginating one slow paced page at a time.

// Amazon hard-caps the orders list at 10/page (no page-size param works); a safety cap on pages per year.
const ORDERS_PER_PAGE = 10
const MAX_PAGES_PER_YEAR = 40
// Concurrent page fetches — parallel enough to be fast, modest enough not to look like a burst to the WAF.
const FETCH_CONCURRENCY = 6
const INVOICE_HEADERS = { Accept: 'text/html,*/*', 'X-Requested-With': 'XMLHttpRequest' }
const ordersUrl = (timeFilter: string, startIndex: number): string =>
  `${ORIGIN}/your-orders/orders?timeFilter=${timeFilter}&startIndex=${startIndex}`

// Run `fn` over `items` with at most `limit` in flight at once (the collector's own concurrency, since the
// page fetches opt out of the per-host pacer).
const mapPool = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out = new Array<R>(items.length)
  let next = 0

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++

        out[i] = await fn(items[i]!)
      }
    })
  )

  return out
}

const fetchPage = (ctx: CollectContext, timeFilter: string, startIndex: number): Promise<string> =>
  ctx.client
    .request<string>({ url: ordersUrl(timeFilter, startIndex), responseType: 'text', pace: false })
    .then((r) => r.data)
    .catch(() => '')

const fetchAmazonBilling = async (ctx: CollectContext): Promise<AmazonOrder[]> => {
  // Bootstrap: current-year page 0 gives the year dropdown (the exact years with orders) + this year's count.
  const thisYear = new Date().getUTCFullYear()
  const first = await fetchPage(ctx, `year-${thisYear}`, 0)
  const parsed = parseOrderYears(first)
  const allYears = parsed.length > 0 ? parsed : [thisYear, thisYear - 1, thisYear - 2].map((y) => `year-${y}`)
  // Incremental: skip years entirely older than the watermark — their orders are already stored (core's kept
  // union retains them, and ctx.since already steps back the re-fetch window). `ctx.since` is undefined on a
  // first run / forced full refetch, so every year is fetched then. `year-YYYY` sorts lexically by its year.
  const minYear = ctx.since?.slice(0, 4)
  const years = minYear ? allYears.filter((y) => y.replace('year-', '') >= minYear) : allYears

  // Each year's page 0 (concurrent) — page 0 carries the order count that sets how many more pages to pull.
  const page0 = new Map<string, string>([[`year-${thisYear}`, first]])

  for (const [year, html] of await mapPool(
    years.filter((y) => !page0.has(y)),
    FETCH_CONCURRENCY,
    (y) => fetchPage(ctx, y, 0).then((html) => [y, html] as const)
  )) {
    page0.set(year, html)
  }

  // Every remaining (year, page) across all years, fetched in one concurrent wave (page 0 already in hand).
  const rest: { year: string; startIndex: number }[] = []

  for (const year of years) {
    const html = page0.get(year) ?? ''
    const count = parseOrderCount(html)
    // Known count → exact pages; unknown but a full first page → assume more (capped); else just page 0.
    const pages =
      count > 0
        ? Math.ceil(count / ORDERS_PER_PAGE)
        : parseOrders(html).length >= ORDERS_PER_PAGE
          ? MAX_PAGES_PER_YEAR
          : 1

    for (let p = 1; p < Math.min(pages, MAX_PAGES_PER_YEAR); p++) {
      rest.push({ year, startIndex: p * ORDERS_PER_PAGE })
    }
  }

  const restHtml = await mapPool(rest, FETCH_CONCURRENCY, (r) => fetchPage(ctx, r.year, r.startIndex))

  // Assemble, deduped by order id across every page.
  const orders: AmazonOrder[] = []
  const seen = new Set<string>()

  for (const html of [...years.map((y) => page0.get(y) ?? ''), ...restHtml]) {
    for (const order of parseOrders(html)) {
      if (!seen.has(order.orderId)) {
        seen.add(order.orderId)
        orders.push(order)
      }
    }
  }

  return orders
}

// One order's invoice PDF, resolved on demand: fetch the order's invoice popover (its hidden popoverUrl), take
// the first invoice-PDF link, download its bytes, and verify they're really a PDF. Each step logs to the Logs
// view so a failed download says exactly WHY (no link / unreachable / not invoiced yet / not a PDF) — the common
// case being a recent order Amazon hasn't invoiced yet (the popover offers only a printable summary).
const fetchAmazonInvoicePdf = async (ctx: CollectContext, row: Record<string, unknown>): Promise<Uint8Array> => {
  const orderId = String(row.orderId ?? '?')
  const popoverUrl = String(row.popoverUrl ?? '')

  if (!popoverUrl) {
    throw new Error(`Amazon ${orderId}: no invoice link captured for this order`)
  }

  let popoverHtml: string

  try {
    popoverHtml = await ctx.client.getText(absolutize(popoverUrl), INVOICE_HEADERS)
  } catch (err) {
    ctx.log(`invoice ${orderId}: popover request failed`, { error: String((err as Error)?.message ?? err) })

    throw new Error(`Amazon ${orderId}: could not reach the invoice popover`)
  }

  const pdfs = parseInvoicePopover(popoverHtml)

  ctx.log(`invoice ${orderId}: popover ${popoverHtml.length}b → ${pdfs.length} PDF link(s)`, {
    orderId,
    popoverBytes: popoverHtml.length,
    pdfLinks: pdfs.length
  })

  if (pdfs.length === 0) {
    throw new Error(`Amazon ${orderId}: not invoiced yet — Amazon issues the invoice PDF after the order ships`)
  }

  const res = await ctx.client.request<ArrayBuffer>({
    url: absolutize(pdfs[0]!),
    responseType: 'arraybuffer',
    // The download endpoint ignores Accept, but ask for the PDF explicitly so a redirect-to-HTML can't slip in.
    headers: { Accept: 'application/pdf,*/*' }
  })
  const bytes = new Uint8Array(res.data)
  // `%PDF` magic bytes — a non-PDF body (an error/sign-in page) must fail loudly, not save a corrupt file.
  const isPdf = bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46

  ctx.log(`invoice ${orderId}: downloaded ${bytes.length}b (pdf=${isPdf})`, { orderId, bytes: bytes.length, isPdf })

  if (!isPdf) {
    throw new Error(
      `Amazon ${orderId}: invoice download wasn't a PDF (${bytes.length}b) — the session may need re-login`
    )
  }

  return bytes
}

// ── descriptor ──────────────────────────────────────────────────────────────────────

export const amazonPlugin = definePlugin({
  reportingCurrency: CURRENCY,
  meta: {
    id: 'amazon',
    name: 'Amazon',
    vendor: 'Amazon',
    color: '#FF9900',
    description: 'Amazon order history — monthly spend and downloadable invoice PDFs from Your Orders.',
    homepage: 'https://www.amazon.ca',
    dashboardUrl: 'https://www.amazon.ca/your-orders/orders'
  },
  session: {
    // Logged out, Your Orders redirects through Amazon's openid sign-in (password + MFA), then lands back here.
    loginUrl: 'https://www.amazon.ca/your-orders/orders',
    dashboardMarkers: ['/your-orders/orders', '/gp/css/order-history', '/gp/css/homepage.html'],
    cookieDomains: ['amazon.ca'],
    // `at-acbca` is the durable auth token, present only once signed in — gate the capture on it.
    requiredCookie: 'at-acbca'
  },
  auth: { kind: 'cookie' },
  transport: {
    // CloudFront + AWS WAF reject a plain Node client, so present the real browser TLS identity.
    requiresBrowserEngine: true,
    defaultHeaders: { Accept: 'text/html,*/*', 'Accept-Language': 'en-CA' }
  },
  capabilities: [
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchAmazonBilling,
      build: buildAmazonBilling,
      sample: sampleAmazonBilling,
      fetchFile: fetchAmazonInvoicePdf,
      // Incremental: a refresh re-pulls only the recent window + any newer orders; the kept union retains the
      // full history, and build runs over all of it (so the spend chart + order count stay whole). 60d catches
      // a late refund / return / status change on a recent order.
      incremental: { id: 'orderId', timestamp: 'date', window: { days: 60 } }
    })
  ],
  probe: async (ctx) => {
    // Your Orders is the cheapest authed read. A live session answers 200 with the order list; a dead one
    // redirects to the sign-in portal (Amazon never 401s).
    const res = await ctx.client.request<string>({ url: `${ORIGIN}/your-orders/orders`, responseType: 'text' })

    if (isAmazonSignedOut(res.status, res.data)) {
      throw new Error('Amazon: session is not authenticated (sign in again).')
    }
  }
})

// Whether a Your-Orders response is the signed-out state rather than the order list: a non-200 (the sign-in
// redirect the transport surfaces as a 3xx) or the rendered sign-in FORM. The bare `/ap/signin` LINK appears in
// the authenticated page's own nav (Sign Out, account menu), so it must NOT be the signal — key off the sign-in
// form's own fields, which are absent once authenticated.
export const isAmazonSignedOut = (status: number, body: string): boolean =>
  status !== 200 || /id="ap_email"|name="signIn"|"signInSubmit"/i.test(body)

import { resolveCurrencies, validateCapabilityResult as rawValidateCR } from '@butinapp/sdk/data'
import { createSampleGen, resolveSampleConfig } from '@butinapp/sdk/testing'
import { currentMonthKey } from '@butinapp/sdk/util'
import { expect, test } from 'vitest'

import {
  amazonPlugin,
  buildAmazonBilling,
  isAmazonSignedOut,
  parseAmazonDate,
  parseInvoicePopover,
  parseOrderCount,
  parseOrders,
  parseOrderYears
} from './main.js'
import { sampleAmazonBilling } from './sample.js'

const validateCapabilityResult = (r: Parameters<typeof resolveCurrencies>[0]): string[] =>
  rawValidateCR(resolveCurrencies(r, 'CAD'))

// Synthetic, redacted — faithful to the real Your-Orders card + invoice-popover shapes (no real ids / uuids).
// Each item renders as a `.yohtmlc-product-title` linking to its `/dp/<ASIN>` page, as the live cards do.
const card = (
  id: string,
  dateLabel: string,
  dateValue: string,
  total: string,
  ref: string,
  items: string[]
): string => `
  <div class="order-card js-order-card">
    <div class="a-column"><span class="a-text-caps">${dateLabel}</span><span>${dateValue}</span></div>
    <div class="a-column"><span class="a-text-caps">Total</span><span>${total}</span></div>
    <div class="a-column"><span class="a-text-caps">Ship to</span><span>Alex Doe</span></div>
    <div class="yohtmlc-order-id"><span class="a-text-caps">Order #</span><span dir="ltr">${id}</span></div>
    ${items.map((t) => `<a class="a-link-normal yohtmlc-product-title" href="/dp/B0EXAMPLE01?ref=ppx_yo2ov_dt_b_fed_as">${t}</a>`).join('')}
    <span class="a-declarative" data-a-popover='{"activate":"onclick","url":"/your-orders/invoice/popover?orderId=${id}&amp;relatedRequestId=EXAMPLEREQ01&amp;ref_=${ref}"}'>
      <a class="a-link-normal" href="/your-orders/invoice/popover?orderId=${id}&amp;relatedRequestId=EXAMPLEREQ01&amp;ref_=${ref}">Invoice</a>
    </span>
  </div>`

const ORDERS_HTML = `<div id="ordersContainer">
  ${card('111-2223334-5556667', 'Order placed', 'December 2, 2024', '$238.88', 'fed_invoice_ajax', ['Anker USB-C Cable (6ft, 2-Pack)', 'Anker Power Bank 25,000mAh'])}
  ${card('D01-8794964-0377844', 'Subscription charged on', 'December 1, 2024', '$25.28', 'fed_digi_order_invoice_ajax', [])}
</div>`

const POPOVER_TWO =
  '<ul class="invoice-list"><li><a class="a-link-normal" href="/gp/css/summary/print.html?orderID=111-2222222-3333333&amp;ref=x">Printable Order Summary</a></li><li><a class="a-link-normal" href="/documents/download/aaaa1111-0000-0000-0000-000000000001/invoice.pdf">Invoice 1</a></li><li><a class="a-link-normal" href="/documents/download/bbbb2222-0000-0000-0000-000000000002/invoice.pdf">Invoice 2</a></li><li><a class="a-link-normal" href="/gp/help/contact/contact.html?orderID=111-2222222-3333333">Request Invoice</a></li></ul>'

const POPOVER_NONE =
  '<ul class="invoice-list"><li><a class="a-link-normal" href="/gp/css/summary/print.html?orderID=777-8888888-9999999">Printable Order Summary</a></li></ul>'

test('amazon plugin is a cookie-session scrape with one CAD billing capability', () => {
  expect(amazonPlugin.meta.id).toBe('amazon')
  expect(amazonPlugin.reportingCurrency).toBe('CAD')
  expect(amazonPlugin.auth.kind).toBe('cookie')
  expect(amazonPlugin.session?.requiredCookie).toBe('at-acbca')
  expect(amazonPlugin.transport?.requiresBrowserEngine).toBe(true)
  expect(amazonPlugin.capabilities.map((c) => c.id)).toEqual(['billing'])
})

// --- isAmazonSignedOut (the probe's signal) ---

test('isAmazonSignedOut ignores the /ap/signin nav link on an authed page, catches the real sign-in form', () => {
  // The authenticated orders page carries `/ap/signin` in its own Sign Out / account nav — must NOT read as dead.
  expect(
    isAmazonSignedOut(200, '<a class="nav-link" href="/ap/signin">Sign Out</a><div class="order-card">…</div>')
  ).toBe(false)
  // The sign-in portal: a non-200 redirect, or the rendered form with its own fields.
  expect(isAmazonSignedOut(302, '')).toBe(true)
  expect(isAmazonSignedOut(200, '<form name="signIn"><input id="ap_email" /></form>')).toBe(true)
})

// --- parseAmazonDate ---

test('parseAmazonDate maps the long-form card date to ISO; junk degrades to undefined', () => {
  expect(parseAmazonDate('December 2, 2024')).toBe('2024-12-02')
  expect(parseAmazonDate('January 31, 2026')).toBe('2026-01-31')
  expect(parseAmazonDate('Yesterday')).toBeUndefined()
  expect(parseAmazonDate(undefined)).toBeUndefined()
})

// --- parseOrders ---

test('parseOrders pulls id, date, total, line items and the cleaned popover URL from each card', () => {
  const orders = parseOrders(ORDERS_HTML)

  expect(orders).toHaveLength(2)
  expect(orders[0]).toMatchObject({
    orderId: '111-2223334-5556667',
    date: '2024-12-02',
    total: 238.88,
    recipient: 'Alex Doe'
  })
  expect(orders[0]!.items).toEqual(['Anker USB-C Cable (6ft, 2-Pack)', 'Anker Power Bank 25,000mAh'])
  expect(orders[0]!.popoverUrl).toBe(
    '/your-orders/invoice/popover?orderId=111-2223334-5556667&relatedRequestId=EXAMPLEREQ01&ref_=fed_invoice_ajax'
  )
  // A digital subscription card uses "Subscription charged on" and a D01- order id, and lists no items here.
  expect(orders[1]).toMatchObject({ orderId: 'D01-8794964-0377844', date: '2024-12-01', total: 25.28, items: [] })
  expect(parseOrders('')).toEqual([])
})

// --- parseOrderYears ---

test('parseOrderYears reads the year options from the time-filter dropdown, ignoring last30/months-3', () => {
  const html =
    '<select id="time-filter"><option value="last30">past 30 days</option><option value="months-3">past 3 months</option><option value="year-2026">2026</option><option value="year-2025">2025</option><option value="year-2016">2016</option></select>'

  expect(parseOrderYears(html)).toEqual(['year-2026', 'year-2025', 'year-2016'])
  expect(parseOrderYears('')).toEqual([])
})

test('parseOrderCount reads the reported order total (drives concurrent page fetching)', () => {
  expect(parseOrderCount('<span>97 orders</span>')).toBe(97)
  expect(parseOrderCount('1 order placed')).toBe(1)
  expect(parseOrderCount('1,234 orders')).toBe(1234)
  expect(parseOrderCount('97 commandes')).toBe(97)
  expect(parseOrderCount('no count here')).toBe(0)
})

// --- parseInvoicePopover ---

test('parseInvoicePopover keeps only invoice PDFs, dropping the summary and contact links', () => {
  expect(parseInvoicePopover(POPOVER_TWO)).toEqual([
    '/documents/download/aaaa1111-0000-0000-0000-000000000001/invoice.pdf',
    '/documents/download/bbbb2222-0000-0000-0000-000000000002/invoice.pdf'
  ])
  expect(parseInvoicePopover(POPOVER_NONE)).toEqual([])
  expect(parseInvoicePopover('')).toEqual([])
})

// --- buildAmazonBilling ---

test('buildAmazonBilling builds the spend rollup + a lazily-downloadable Orders table', () => {
  const ym = currentMonthKey()
  const result = buildAmazonBilling([
    {
      orderId: '111-2223334-5556667',
      date: `${ym}-15`,
      total: 238.88,
      items: ['Anker USB-C Cable', 'Anker Power Bank'],
      popoverUrl: '/your-orders/invoice/popover?orderId=111-2223334-5556667&relatedRequestId=ABC'
    },
    { orderId: 'D01-8794964-0377844', date: '2024-12-01', total: 25.28 }
  ])

  expect(validateCapabilityResult(result)).toEqual([])

  // Spend rollup: current-month total + the cross-service spend summary.
  const account = result.datasets.find((d) => d.id === 'account') as unknown as { value: Record<string, unknown> }

  expect(account.value.currentMtd).toBe(238.88)
  expect(result.summaries?.[0]).toMatchObject({ section: 'spend', value: 238.88 })

  // The Orders table downloads PER ROW via fetchFile (no eager PDF URLs), carrying the popover URL hidden.
  const view = result.views?.find((v) => v.type === 'table' && v.dataset === 'orders') as { files?: unknown }

  expect(view.files).toMatchObject({ source: { fetch: true }, ext: 'pdf', category: 'Invoices' })

  const rows = (result.datasets.find((d) => d.id === 'orders') as unknown as { rows: OrderRow[] }).rows

  expect(rows.find((r) => r.orderId === '111-2223334-5556667')).toMatchObject({
    total: 238.88,
    items: 'Anker USB-C Cable, Anker Power Bank',
    popoverUrl: '/your-orders/invoice/popover?orderId=111-2223334-5556667&relatedRequestId=ABC',
    name: 'Amazon order 111-2223334-5556667'
  })
  // An order with no popover still lists; its row carries no download key and an empty items cell.
  const subscription = rows.find((r) => r.orderId === 'D01-8794964-0377844')

  expect(subscription?.popoverUrl).toBe('')
  expect(subscription?.items).toBe('')
})

test('buildAmazonBilling tolerates empty/missing input and reports no current spend', () => {
  expect(validateCapabilityResult(buildAmazonBilling(null))).toEqual([])

  const account = buildAmazonBilling([]).datasets.find((d) => d.id === 'account') as unknown as {
    value: Record<string, unknown>
  }

  expect(account.value.currentMtd).toBeNull()
})

// --- incremental fetch ---

test('billing is incremental — a keyed orders table + an orderId/date watermark', () => {
  const billing = amazonPlugin.capabilities.find((c) => c.id === 'billing')!

  expect(billing.incremental).toMatchObject({ id: 'orderId', timestamp: 'date', window: { days: 60 } })

  // The orders table is keyed so the ledger accumulates (keeps orders the service ages out) instead of replacing.
  const orders = buildAmazonBilling([]).datasets.find((d) => d.id === 'orders') as unknown as { key?: string }

  expect(orders.key).toBe('orderId')
})

test('buildAmazonBilling over a merged union spans retained-old + updated + new orders', () => {
  // The union after a window re-fetch: an old order the service no longer returns is RETAINED, a recent order's
  // total was revised down (a refund — the fresher copy), and a brand-new order arrived. build sees them all.
  const ym = currentMonthKey()
  const union = [
    { orderId: 'OLD-1', date: '2019-03-02', total: 50 },
    { orderId: 'REC-1', date: `${ym}-02`, total: 7 },
    { orderId: 'NEW-1', date: `${ym}-20`, total: 30 }
  ]

  const result = buildAmazonBilling(union)

  expect(validateCapabilityResult(result)).toEqual([])

  // The whole union renders (the aged-out 2019 order included), and current-month spend sums only this month.
  const rows = (result.datasets.find((d) => d.id === 'orders') as unknown as { rows: OrderRow[] }).rows

  expect(rows.map((r) => r.orderId).sort()).toEqual(['NEW-1', 'OLD-1', 'REC-1'])

  const account = result.datasets.find((d) => d.id === 'account') as unknown as { value: Record<string, unknown> }

  expect(account.value.currentMtd).toBe(37)
})

interface OrderRow {
  orderId: string
  date: string | null
  total: number
  recipient: string
  items: string
  popoverUrl: string
  name: string
}

// --- sample ---

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of amazonPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(cap.sample!()), cap.id).toEqual([])
  }
})

test('amazon sample is synthetic, scales with the documents knob, and carries a popover URL per order', () => {
  const small = sampleAmazonBilling(createSampleGen('amazon:t'), resolveSampleConfig({ size: 'small' }))
  const large = sampleAmazonBilling(createSampleGen('amazon:t'), resolveSampleConfig({ size: 'large' }))

  expect(large.length).toBeGreaterThanOrEqual(small.length)
  expect(small.every((o) => /^\d{3}-\d{7}-\d{7}$/.test(o.orderId))).toBe(true)
  expect(small.every((o) => (o.popoverUrl ?? '').includes('invoice/popover'))).toBe(true)
  // Every sampled order carries 1–3 line items, so the demo renders the Items column populated.
  expect(small.every((o) => (o.items?.length ?? 0) >= 1 && o.items!.length <= 3)).toBe(true)
})

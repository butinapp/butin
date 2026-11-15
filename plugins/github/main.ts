import { type CollectContext, defineCapability, definePlugin } from '@butinapp/sdk'
import { type CapabilityResult } from '@butinapp/sdk/data'
import { billing } from '@butinapp/sdk/presets'
import { byDayDesc, currentMonthKey, parseDollarAmount, round2, squish, startCase } from '@butinapp/sdk/util'
import * as cheerio from 'cheerio'

import { sampleGithubBilling } from './sample.js'

// GitHub (personal account) billing, read off the github.com billing dashboard — NOT the api.github.com REST API.
// The dashboard's JSON XHRs are "verified fetches": each carries `GitHub-Verified-Fetch: true` + an `X-Fetch-Nonce`
// scraped from the `<meta name="fetch-nonce">` of an authed page (it rotates per page load). Without the nonce GitHub
// answers the JSON routes with the HTML shell. The HTML pages themselves are plain cookie-only GETs.

const GITHUB_ORIGIN = 'https://github.com'
const BILLING_PATH = '/settings/billing'
const HISTORY_PATH = '/account/billing/history'
// Bounds a runaway pagination walk over the payment history.
const MAX_HISTORY_PAGES = 24

// ── types ───────────────────────────────────────────────────────────────────────────

// The `billing-app` react-app payload embedded in /settings/billing (only the fields read here).
export type RawBillingApp = {
  customer?: {
    customerId?: number
    plan?: string
    // 'month' | 'year'
    planDuration?: string
    // Dollars, e.g. 4.0.
    planPrice?: number
  }
}

// /settings/billing/usage/total — the current period's gross metered usage, in dollars.
export type RawUsageTotal = {
  usage?: { billableAmount?: number }
}

// /settings/billing/discounts — each discount's `currentAmount` is the dollars of usage it covered this period.
export type RawDiscounts = {
  discounts?: { currentAmount?: number }[]
}

// One payment-history row, parsed from the server-rendered `li.Box-row`.
export type GithubPayment = {
  // 'YYYY-MM-DD'
  date?: string
  // Short transaction id shown in the row.
  id: string
  // e.g. "Visa ending in 1234".
  method: string
  // Dollars.
  amount: number
  // Label text, e.g. "Success" / "Declined".
  status: string
  receiptUrl?: string
  invoiceUrl?: string
}

export type GithubBillingRaw = {
  app: RawBillingApp | null
  payments: GithubPayment[]
  usageTotal: RawUsageTotal
  discounts: RawDiscounts
}

// ── shared: dashboard transport ─────────────────────────────────────────────────────

export const extractFetchNonce = (html: string): string => {
  const nonce = cheerio.load(html)('meta[name="fetch-nonce"]').attr('content')

  if (!nonce) {
    throw new Error('[github] fetch-nonce not found on the billing page — session expired?')
  }

  return nonce
}

const absolute = (href?: string): string | undefined =>
  href ? (href.startsWith('http') ? href : `${GITHUB_ORIGIN}${href}`) : undefined

// ── billing ─────────────────────────────────────────────────────────────────────────

// The `billing-app` payload, or null when the react-app isn't on the page (shape drift) so the tab degrades to the
// payment history alone.
export const extractBillingApp = (html: string): RawBillingApp | null => {
  const json = cheerio
    .load(html)('react-app[app-name="billing-app"] script[data-target="react-app.embeddedData"]')
    .text()

  try {
    return (JSON.parse(json) as { payload?: RawBillingApp }).payload ?? null
  } catch {
    return null
  }
}

export const parseTotalPages = (html: string): number => {
  const total = Number(cheerio.load(html)('.paginate-container .current').attr('data-total-pages'))

  return Number.isInteger(total) && total > 0 ? total : 1
}

export const parsePaymentHistory = (html: string): GithubPayment[] => {
  const $ = cheerio.load(html)

  return $('li.Box-row')
    .toArray()
    .flatMap((row) => {
      const $row = $(row)
      const id = squish($row.find('.id code span').first().text())

      if (!id) {
        return []
      }

      return [
        {
          date: squish($row.find('.date time').first().text()) || undefined,
          id,
          method: squish($row.find('.method').first().text()),
          amount: parseDollarAmount(squish($row.find('.amount').first().text())),
          status: squish($row.find('.status .Label').first().text()) || 'unknown',
          receiptUrl: absolute($row.find('.receipt a').first().attr('href')),
          invoiceUrl: absolute($row.find('invoice-download').first().attr('data-url'))
        }
      ]
    })
}

export const buildGithubBilling = ({ app, payments, usageTotal, discounts }: GithubBillingRaw): CapabilityResult => {
  const customer = app?.customer
  const gross = usageTotal.usage?.billableAmount
  const included = (discounts.discounts ?? []).reduce((sum, d) => sum + (d.currentAmount ?? 0), 0)
  const metered = gross == null ? null : round2(Math.max(0, gross - included))
  // An annual plan's price is not this month's spend, so only a monthly plan contributes a base fee.
  const baseFee = customer?.planDuration === 'month' ? (customer.planPrice ?? null) : null
  const card = payments.find((p) => p.method)?.method.match(/^(.+?) ending in (\d{4})$/)

  return billing.result({
    // Accrued: the monthly plan fee + the net metered usage so far this period. Null with no billing signal at all.
    currentMtd: metered == null && baseFee == null ? null : round2((baseFee ?? 0) + (metered ?? 0)),
    mtdBasis: 'accrued',
    baseFee,
    meteredMtd: metered,
    plan: customer?.plan
      ? `${startCase(customer.plan)}${customer.planDuration === 'year' ? ' (annual)' : ''}`
      : undefined,
    // A declined charge is not spend, and the same rows feed the monthly series — so only settled payments are listed.
    invoices: payments
      .filter((p) => /success/i.test(p.status))
      .sort(byDayDesc)
      .map((p) => ({
        id: p.id,
        date: p.date,
        status: p.status,
        amount: p.amount,
        pdfUrl: p.invoiceUrl ?? null,
        hostedUrl: p.receiptUrl ?? null
      })),
    paymentMethod: card ? { brand: card[1], last4: card[2] } : undefined,
    invoiceDownload: true
  })
}

// Page 1 of the history and the billing page are load-bearing (a dead session fails there, so core can clear the
// cookie); later history pages and the metered-usage JSON are best-effort.
export const fetchGithubBilling = async (ctx: CollectContext): Promise<GithubBillingRaw> => {
  const getHtml = (path: string, referer: string) => ctx.client.getText(path, { Referer: `${GITHUB_ORIGIN}${referer}` })

  const [billingHtml, firstHistory] = await Promise.all([
    getHtml(BILLING_PATH, BILLING_PATH),
    getHtml(HISTORY_PATH, HISTORY_PATH)
  ])
  const nonce = extractFetchNonce(billingHtml)
  const app = extractBillingApp(billingHtml)
  const customerId = app?.customer?.customerId
  const [year, month] = currentMonthKey().split('-').map(Number)

  const getJson = <T>(path: string, params: Record<string, string | number>): Promise<T> =>
    ctx.client.get<T>(`${path}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`, {
      Accept: 'application/json',
      'GitHub-Verified-Fetch': 'true',
      'X-Fetch-Nonce': nonce,
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${GITHUB_ORIGIN}${BILLING_PATH}`
    })

  const pageCount = Math.min(parseTotalPages(firstHistory), MAX_HISTORY_PAGES)
  const [usageTotal, discounts, laterPages] = await Promise.all([
    customerId == null
      ? {}
      : getJson<RawUsageTotal>(`${BILLING_PATH}/usage/total`, { customer_id: customerId }).catch(() => ({})),
    getJson<RawDiscounts>(`${BILLING_PATH}/discounts`, { month, year, reloadKey: 0 }).catch(() => ({})),
    Promise.all(
      Array.from({ length: pageCount - 1 }, (_, i) =>
        getHtml(`${HISTORY_PATH}?page=${i + 2}`, HISTORY_PATH)
          .then(parsePaymentHistory)
          .catch((): GithubPayment[] => [])
      )
    )
  ])

  return { app, payments: [...parsePaymentHistory(firstHistory), ...laterPages.flat()], usageTotal, discounts }
}

// ── descriptor ──────────────────────────────────────────────────────────────────────

// `_gh_sess` holds the social-login OAuth `state`; a promoted stale copy poisons the next Google/SSO round-trip, so it
// is cleared before capture. The durable session is `user_session`.
export const githubPlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'github',
    name: 'GitHub',
    vendor: 'GitHub',
    category: 'devtools',
    color: '#1f2328',
    homepage: 'https://github.com',
    dashboardUrl: 'https://github.com/settings/billing',
    description: 'Your personal GitHub plan, metered usage, and payment history with invoices.'
  },
  session: {
    loginUrl: 'https://github.com/login',
    dashboardMarkers: ['/settings/', '/account/billing', '/dashboard'],
    cookieDomains: ['github.com'],
    requiredCookie: 'user_session',
    clearCookiesBeforeCapture: ['_gh_sess']
  },
  auth: { kind: 'cookie' },
  transport: {
    engine: 'node',
    baseUrl: GITHUB_ORIGIN,
    defaultHeaders: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' },
    // The invoice-PDF download is refused without a same-origin Referer.
    download: { referer: GITHUB_ORIGIN }
  },
  capabilities: [
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: fetchGithubBilling,
      build: buildGithubBilling,
      sample: sampleGithubBilling
    })
  ],
  // The fetch-nonce meta is only rendered on an authed page, so scraping it proves the session in one HTML GET.
  probe: async (ctx) => {
    extractFetchNonce(await ctx.client.getText(BILLING_PATH, { Referer: `${GITHUB_ORIGIN}${BILLING_PATH}` }))
  }
})

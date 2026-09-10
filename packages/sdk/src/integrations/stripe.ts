// Stripe billing mechanics shared by every plugin that proxies billing to Stripe. Two reusable shapes live
// here: the hosted billing-portal walk (services with no invoice API of their own — depot, novu, posthog) and
// the hosted-invoice → PDF download (services that expose only the Stripe-hosted invoice page — screenshotapi).
// Pure relative to a ButinClient: each helper takes the authed client and does the cross-origin Stripe calls,
// so a plugin only supplies how it ACQUIRES the one-time portal URL (a 302 from its own endpoint, a JSON
// field, or a value already in hand) and how it normalizes the result.

import type { ButinClient } from '../plugin/transport.js'

// ── hosted billing portal ────────────────────────────────────────────────────────────────

// The Stripe API version the hosted billing portal pins its ephemeral-key calls to. Stripe shifts response
// shapes across versions, so the portal-session calls send the same one the portal page does.
export const STRIPE_PORTAL_VERSION = '2025-06-30.basil'

const STRIPE_BILLING_ORIGIN = 'https://billing.stripe.com'

// The three tokens Stripe's hosted billing portal embeds in its page markup to authorize its own API:
// the session id (path segment), an ephemeral key (Bearer), and the connected account (stripe-account header).
export type StripePortalSession = {
  bps: string
  ek: string
  account: string
}

// Stripe's hosted portal page embeds the session id, an ephemeral key, and the account id in its bootstrap
// markup. The three tokens carry distinctive, stable prefixes, so a prefix regex survives surrounding-markup
// drift. Exported so the scrape is fixture-tested.
export const extractStripePortalTokens = (html: string): StripePortalSession => {
  const ek = html.match(/ek_live_[A-Za-z0-9_]+/)?.[0]
  const bps = html.match(/bps_[A-Za-z0-9]+/)?.[0]
  const account = html.match(/acct_[A-Za-z0-9]+/)?.[0]

  if (!ek || !bps || !account) {
    throw new Error('Stripe billing-portal session not found on the portal page (session expired?).')
  }

  return { bps, ek, account }
}

// Fetch a one-time Stripe portal-session page and scrape its tokens. `portalUrl` is the
// `billing.stripe.com/p/session/…` URL the plugin already holds (e.g. a JSON field). The page rides on
// Stripe's own ephemeral-key auth, so this hop carries neither the service's session cookie nor any Bearer.
export const openStripePortal = async (client: ButinClient, portalUrl: string): Promise<StripePortalSession> => {
  if (!portalUrl.includes('/p/session/')) {
    throw new Error('Stripe billing-portal URL is not a portal session (session expired?).')
  }

  const page = await client.request<string>({
    url: portalUrl,
    responseType: 'text',
    sendAuth: false,
    sendCookie: false,
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
  })

  return extractStripePortalTokens(page.data)
}

// Open a Stripe portal session reached through a service endpoint that 302s to it (the common shape — the
// service mints the session server-side with its own secret key and hands back only the client redirect).
// The redirect hop keeps the service's session (cookie + any Bearer) to be authorized; the portal-page hop
// drops it. `maxRedirects: 0` reads the Location instead of chasing it cross-origin.
export const openStripePortalViaRedirect = async (
  client: ButinClient,
  redirectUrl: string
): Promise<StripePortalSession> => {
  const redirect = await client.request({ url: redirectUrl, maxRedirects: 0 })
  const location = redirect.headers.location

  if (!location) {
    throw new Error('Stripe billing-portal endpoint did not redirect to a portal session (session expired?).')
  }

  return openStripePortal(client, location)
}

// GET a portal-session resource (`invoices`, `subscriptions`, …), authorized by the ephemeral key — the same
// captcha-free calls the portal UI makes (hCaptcha only gates payment-method mutations). Cross-origin to
// Stripe, so it carries the Bearer/account/version headers and drops the service's session cookie.
export const fetchStripePortalResource = async <T>(
  client: ButinClient,
  session: StripePortalSession,
  resource: string,
  params: Record<string, number> = {}
): Promise<T> => {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
  const res = await client.request<T>({
    url: `${STRIPE_BILLING_ORIGIN}/v1/billing_portal/sessions/${session.bps}/${resource}${query ? `?${query}` : ''}`,
    sendAuth: false,
    sendCookie: false,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${session.ek}`,
      'stripe-account': session.account,
      'stripe-version': STRIPE_PORTAL_VERSION,
      Origin: STRIPE_BILLING_ORIGIN,
      Referer: `${STRIPE_BILLING_ORIGIN}/`
    }
  })

  return res.data
}

// ── Stripe wire shapes (only the fields collectors read) — money in CENTS, dates in unix seconds. ──

export type RawStripeLine = {
  amount?: number
  description?: string
  short_description?: string
  price_details?: { product?: { name?: string } }
}

export type RawStripeInvoice = {
  id?: string
  number?: string
  status?: string
  total?: number
  amount_due?: number
  amount_paid?: number
  currency?: string
  // Unix seconds; collectors prefer effective_at → finalized_at → created/due_date.
  effective_at?: number
  finalized_at?: number
  created?: number
  due_date?: number
  hosted_invoice_url?: string
  invoice_pdf?: string
  lines?: { data?: RawStripeLine[] }
}

export type RawStripeInvoiceList = {
  data?: RawStripeInvoice[]
  has_more?: boolean
}

// ── hosted-invoice PDF download ────────────────────────────────────────────────────────────

// A Stripe hosted-invoice URL (https://invoice.stripe.com/i/<acct>/<liveId>?s=ap) serves an SPA shell, NOT a
// PDF. The real PDF is two hops away: GET invoicedata.stripe.com/invoice_pdf_file_url/<acct>/<liveId> for a
// JSON `{ file_url }` (a short-lived signed S3 link), then GET that. This derives the first-hop endpoint from
// the hosted URL (same acct + liveId, no query). Exported so the parse is fixture-tested.
const STRIPE_HOSTED_INVOICE_RE = /invoice\.stripe\.com\/i\/(acct_[^/]+)\/(live_[^/?]+)/

export const stripePdfFileUrlEndpoint = (hosted?: string | null): string | null => {
  const m = hosted ? STRIPE_HOSTED_INVOICE_RE.exec(hosted) : null

  return m ? `https://invoicedata.stripe.com/invoice_pdf_file_url/${m[1]}/${m[2]}` : null
}

// Download the PDF behind a Stripe hosted-invoice URL via the two-hop file-url handoff — a drop-in `fetchFile`
// body for a `files` table whose rows carry the hosted URL. Both hops are public (the S3 link is signed), so
// neither carries the service's session cookie or Bearer.
export const fetchStripeHostedInvoicePdf = async (client: ButinClient, hosted?: string | null): Promise<Uint8Array> => {
  const endpoint = stripePdfFileUrlEndpoint(hosted)

  if (!endpoint) {
    throw new Error('Stripe hosted-invoice URL is not in the expected invoice.stripe.com/i/<acct>/<live> shape.')
  }

  const meta = await client.request<{ file_url?: string }>({ url: endpoint, sendAuth: false, sendCookie: false })
  const fileUrl = meta.data?.file_url

  if (!fileUrl) {
    throw new Error('Stripe invoice_pdf_file_url returned no PDF link (the hosted invoice link may have expired).')
  }

  const pdf = await client.request<ArrayBuffer>({
    url: fileUrl,
    responseType: 'arraybuffer',
    sendAuth: false,
    sendCookie: false
  })

  return new Uint8Array(pdf.data)
}

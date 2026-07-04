import type { CollectContext } from '@butinapp/sdk'

// Shared transport for github.com's Enterprise billing dashboard endpoints — the
// `github.com/enterprises/<slug>/billing/...` JSON the billing SPA calls, plus the server-rendered
// payment-history / licensing / contacts HTML pages. This is NOT the public api.github.com REST API
// (Octokit + PAT); Enterprise billing/usage lives only on these dashboard endpoints and needs the
// logged-in browser session cookie.
//
// github.com is served from GitHub's own edge (not Cloudflare), so plain axios (Node TLS) works — no
// `requiresBrowserEngine`. The authenticated XHR carries the same markers as the dashboard's own fetch
// (real browser UA + session cookie + the verified-fetch nonce), so it is accepted; the edge's request
// checks are the first suspect if requests start 403ing.
//
// THE GOTCHA — "verified fetch": every billing JSON XHR must carry `GitHub-Verified-Fetch: true` +
// `X-Fetch-Nonce: v2:<uuid>`. The nonce is NOT a cookie — it's a `<meta name="fetch-nonce">` embedded
// in every authed page that rotates per load. We scrape it from a fresh billing page before the JSON
// calls. Omitting it on JSON makes GitHub serve the HTML shell instead of JSON. The HTML doc pages
// (payment_history/licensing/contacts) are plain navigations — cookie only, NO nonce — so JSON and
// HTML fetches must stay separated (`getJson` vs `getHtml`).
export const GITHUB_ORIGIN = 'https://github.com'

// The verified-fetch nonce is embedded in every authenticated page as `<meta name="fetch-nonce"
// content="v2:…">`. Scrape it off a freshly-fetched dashboard page before the JSON XHRs.
export const extractFetchNonce = (html: string): string => {
  const match = html.match(/<meta\s+name="fetch-nonce"\s+content="([^"]+)"/i)

  if (!match?.[1]) {
    throw new Error('[github-enterprise] fetch-nonce not found in billing page — session expired?')
  }

  return match[1]
}

export const slugOf = (config: Record<string, unknown>): string => {
  const slug = (config.enterpriseSlug as string | undefined)?.trim()

  if (!slug) {
    throw new Error('Set your GitHub enterprise slug in Settings.')
  }

  return slug
}

const qs = (params: Record<string, string | number>): string => {
  const entries = Object.entries(params)

  if (entries.length === 0) {
    return ''
  }

  // URLSearchParams keeps empty values (`sku=&query=`) — the dashboard always sends those.
  const search = new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))

  return `?${search.toString()}`
}

// A scoped client over one enterprise's billing dashboard. `getHtml` is cookie-only (document
// navigations); `getJson` lazily scrapes the verified-fetch nonce once (shared across every JSON call
// in this collect) and attaches it. The cookie itself is applied by core's auth layer.
export interface Dashboard {
  slug: string
  billingBase: string
  licensingPath: string
  getHtml: (path: string, params?: Record<string, string | number>) => Promise<string>
  getJson: <T>(path: string, params?: Record<string, string | number>) => Promise<T>
}

export const makeDashboard = (ctx: CollectContext, slug: string = slugOf(ctx.config)): Dashboard => {
  const billingBase = `/enterprises/${slug}/billing`
  const referer = `${GITHUB_ORIGIN}${billingBase}`
  let noncePromise: Promise<string> | null = null

  const getNonce = (): Promise<string> => {
    noncePromise ??= ctx.client.getText(billingBase, { Referer: referer }).then(extractFetchNonce)

    return noncePromise
  }

  return {
    slug,
    billingBase,
    licensingPath: `/enterprises/${slug}/licensing`,
    getHtml: (path, params = {}) => ctx.client.getText(`${path}${qs(params)}`, { Referer: referer }),
    getJson: async <T>(path: string, params: Record<string, string | number> = {}): Promise<T> => {
      const nonce = await getNonce()

      return ctx.client.get<T>(`${path}${qs(params)}`, {
        Accept: 'application/json',
        'GitHub-Verified-Fetch': 'true',
        'X-Fetch-Nonce': nonce,
        'X-Requested-With': 'XMLHttpRequest',
        Referer: referer
      })
    }
  }
}

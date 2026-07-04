import { defineCapability, defineConfigSchema, definePlugin, type ConfigOf } from '@butinapp/sdk'

import { buildGithubBilling, buildGithubSummary, loadGithubBilling } from './billing.js'
import { extractFetchNonce, GITHUB_ORIGIN, slugOf } from './dashboard.js'
import { sampleGithubBilling, sampleGithubUsage } from './sample.js'
import { buildGithubUsageResult, fetchGithubUsage } from './usage.js'

// GitHub Enterprise: the cookie-csrf pattern over Node TLS. Reads the Enterprise billing dashboard
// (`github.com/enterprises/<slug>/billing/...`) — the JSON the billing SPA calls plus the
// server-rendered payment-history / licensing / contacts pages — NOT the public api.github.com REST
// API (that's a PAT + Octokit, a different surface). Enterprise billing/usage lives ONLY on these
// dashboard endpoints, so a personal/org account has nothing here; set your Enterprise slug in Settings.
//
// Auth is cookie-csrf but with NO global resolve(): the verified-fetch nonce is attached per-request on
// the JSON XHRs only (see dashboard.ts) — the HTML doc pages must stay cookie-only, so we can't blanket
// the nonce header across every request the way a global resolve() would.
//
// `_gh_sess` is GitHub's ephemeral session cookie that holds the social-login OAuth `state`.
// `promoteSessionCookies` wrongly persists it, so a stale one poisons the Google round-trip ("could not
// validate the response from your social login provider"). Clearing only it (NOT the durable
// `user_session`) before login forces a fresh one while keeping an active session signed in.
export const githubEnterpriseConfigSchema = defineConfigSchema([
  {
    key: 'enterpriseSlug',
    label: 'Enterprise slug',
    kind: 'text',
    required: true,
    help: 'Your GitHub Enterprise slug (github.com/enterprises/<slug>/billing). Enterprise accounts only.'
  }
])

export type GithubEnterpriseConfig = ConfigOf<typeof githubEnterpriseConfigSchema>

export const githubEnterprisePlugin = definePlugin({
  reportingCurrency: 'USD',
  meta: {
    id: 'github-enterprise',
    name: 'GitHub Enterprise',
    vendor: 'GitHub',
    category: 'devtools',
    color: '#1f2328',
    dashboardUrl: 'https://github.com/enterprises',
    description: 'GitHub Enterprise billing, metered usage, and invoice history.',
    homepage: 'https://github.com'
  },
  session: {
    loginUrl: 'https://github.com/login',
    dashboardMarkers: ['/enterprises/', '/settings/', '/dashboard'],
    cookieDomains: ['github.com'],
    requiredCookie: 'user_session',
    clearCookiesBeforeCapture: ['_gh_sess'],
    // Prefill the enterprise slug from the dashboard URL (github.com/enterprises/<slug>/) when the capture settles on it.
    captureFromUrl: [{ pattern: '/enterprises/([^/?#]+)', storeAs: 'enterpriseSlug' }]
  },
  auth: { kind: 'cookie-csrf' },
  // github.com is GitHub's own edge (not Cloudflare) → plain Node TLS. The node client injects the browser
  // UA + sec-ch-ua hints centrally; we only add the Sec-Fetch-* set that marks this as a same-origin SPA
  // XHR, so the authed fetch carries the same markers the dashboard's own XHR sends.
  transport: {
    engine: 'node',
    baseUrl: GITHUB_ORIGIN,
    defaultHeaders: {
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    },
    // GitHub 403s an invoice-PDF download without a same-origin Referer; the downloadable payment-history
    // table needs it on the download path.
    download: { referer: GITHUB_ORIGIN }
  },
  config: githubEnterpriseConfigSchema,
  capabilities: [
    // Summary + Billing fold the SAME billing surfaces (loadGithubBilling shares one in-flight fetch with a
    // short TTL); each binds its own pure build. Invoice PDFs aren't a separate documents tab — the Billing
    // payment-history table is downloadable (invoice column).
    defineCapability({
      id: 'summary',
      label: 'Summary',
      fetch: loadGithubBilling,
      build: buildGithubSummary,
      sample: sampleGithubBilling
    }),
    defineCapability({
      id: 'billing',
      label: 'Billing',
      fetch: loadGithubBilling,
      build: buildGithubBilling,
      sample: sampleGithubBilling,
      // Payment history is the only thing worth walking incrementally here — the other billing surfaces
      // (usage, license, contacts) are cheap point-in-time reads with no history to page through.
      incremental: { listKey: 'payments', id: 'id', timestamp: 'timestamp', window: { days: 45 } }
    }),
    defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: fetchGithubUsage,
      build: buildGithubUsageResult,
      sample: sampleGithubUsage
    })
  ],
  probe: async (ctx) => {
    // The billing page embeds the verified-fetch nonce only when authed — extractFetchNonce throws otherwise.
    // Scraping it is the cheapest proof the session cookie + enterprise slug are both live (one HTML GET, no
    // billing JSON calls).
    const billingBase = `/enterprises/${slugOf(ctx.config)}/billing`

    extractFetchNonce(await ctx.client.getText(billingBase, { Referer: `${GITHUB_ORIGIN}${billingBase}` }))
  }
})

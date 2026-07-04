import type { RecordingManifest } from '../main/recording/types.js'

import { hostOf, registrableDomain } from './url.js'

// Hosts that are sign-in / identity providers or analytics — never the surface a plugin targets, so they
// are excluded when picking a recording's primary host. The merge action is the escape hatch for the rest.
export const LOGIN_HOSTS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'appleid.apple.com',
  'auth0.com',
  'okta.com',
  'login.live.com'
]
export const ANALYTICS_HOSTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'segment.io',
  'sentry.io',
  'datadoghq.com',
  'doubleclick.net',
  'hotjar.com'
]
// Browser-verification / consent / static-asset plumbing every site loads — never the surface a plugin targets,
// so a verification gate or a cookie banner can't out-count the real service and mis-title a recording. Kept to
// unambiguous infra hosts: `challenges.cloudflare.com` serves only the verification widget, so a recording of
// that vendor's own dashboard (its `dash.`/`api.` hosts) stays untouched.
export const INFRA_HOSTS = ['challenges.cloudflare.com', 'gstatic.com', 'onetrust.com', 'cookielaw.org']

const EXCLUDED_HOSTS = [...LOGIN_HOSTS, ...ANALYTICS_HOSTS, ...INFRA_HOSTS]

const isExcluded = (host: string): boolean => EXCLUDED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))

// One surface per registrable domain: every subdomain of a site folds together (www.acme.com, app.acme.com and
// api.acme.com are all `acme.com`), so a service's many hosts list as one. Login IdPs / analytics are excluded
// on their full host first (before collapsing), so accounts.google.com never pulls a recording under google.com.
export const primaryHost = (manifest: RecordingManifest): string => {
  const counts = manifest.hostCounts ?? {}
  const byDomain = new Map<string, number>()

  for (const [host, n] of Object.entries(counts)) {
    if (isExcluded(host)) {
      continue
    }

    const domain = registrableDomain(host)

    byDomain.set(domain, (byDomain.get(domain) ?? 0) + n)
  }

  // The domain the user set out to record is the one they navigated to. Third-party verification / consent / CDN
  // traffic can out-count it (a browser-verification gate, a tag manager), so when the start URL's own domain
  // was actually requested it wins outright over the request-count leader. A start URL that is itself a login
  // IdP (excluded) has no own domain to prefer, so those fall through to the counted leader.
  const startHost = hostOf(manifest.startUrl)
  const startDomain = registrableDomain(startHost)

  if (startDomain && !isExcluded(startHost) && byDomain.has(startDomain)) {
    return startDomain
  }

  const top = [...byDomain].sort((a, b) => b[1] - a[1])[0]?.[0]

  return top ?? startDomain
}

export const resolveSurface = (host: string, merges: Record<string, string>): string => merges[host] ?? host

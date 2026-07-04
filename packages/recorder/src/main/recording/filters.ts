import { registrableDomain } from '../../detect/url.js'

import type { FilterConfig } from './types.js'

// Decides whether a captured request is worth persisting. With "Capture all" on,
// nothing is filtered. Otherwise we drop data:/blob URIs, the configured noisy
// resource types, and any host matching a configured blocked substring. The
// lists below are the defaults; they're user-editable and stored in config.
//
// `Script` is skipped by default to keep recordings lean, with ONE exception: a FIRST-PARTY script (same
// registrable domain as the page that loaded it) is kept. An SPA's own bundles carry the reverse-engineering
// source an agent needs — per-deploy Next.js server-action ids, route manifests, inline API clients — while
// the third-party/vendor/analytics scripts that bloat a capture stay dropped. Other skipped subresource types
// (images, fonts, stylesheets, media) are dropped regardless of party.

export const DEFAULT_SKIP_RESOURCE_TYPES = ['Image', 'Font', 'Stylesheet', 'Media', 'Script']

// A request is first-party when it shares the registrable domain of the page that fired it (app.foo.com counts
// cdn.foo.com as first-party). Unknown page URL or an unparseable host → not first-party.
function isFirstParty(url: string, pageUrl?: string): boolean {
  if (!pageUrl) {
    return false
  }

  try {
    return registrableDomain(new URL(url).host) === registrableDomain(new URL(pageUrl).host)
  } catch {
    return false
  }
}

export const DEFAULT_BLOCK_HOSTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'segment.io',
  'mixpanel.com',
  'sentry.io',
  'datadoghq.com',
  'intercom.io',
  'intercom.com',
  'fullstory.com',
  'hotjar.com',
  'amplitude.com',
  'posthog.com',
  'cloudflareinsights.com'
]

export function defaultFilters(): FilterConfig {
  return { skipResourceTypes: [...DEFAULT_SKIP_RESOURCE_TYPES], blockHosts: [...DEFAULT_BLOCK_HOSTS] }
}

export function shouldCapture(
  resourceType: string,
  url: string,
  captureAll: boolean,
  filters?: FilterConfig,
  pageUrl?: string
): boolean {
  if (captureAll) {
    return true
  }

  // Inline data: URIs and blob: object URLs carry no network call worth replaying.
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    return false
  }

  let host: string

  try {
    host = new URL(url).host
  } catch {
    return true
  }

  const blocked = filters?.blockHosts ?? DEFAULT_BLOCK_HOSTS

  if (blocked.some((entry) => host.includes(entry))) {
    return false
  }

  const skip = filters?.skipResourceTypes ?? DEFAULT_SKIP_RESOURCE_TYPES

  if (skip.includes(resourceType)) {
    // First-party scripts are the SPA's own code (server-action ids, route manifests) — keep them; every
    // other skipped subresource stays dropped.
    return resourceType === 'Script' && isFirstParty(url, pageUrl)
  }

  return true
}

import type { RecordedRequest } from '../main/recording/types.js'

import type { EndpointCategory, EndpointHint } from './types.js'
import { hostOf } from './url.js'

// Path patterns that hint at a data surface worth reading. First match wins (priority top-down) so each path
// is filed under one category. These are clues from the URL alone — a starting point for collect(), not proof
// the endpoint returns that data. `tokens` is deliberately absent from api-keys: it collides with auth mints.
const PATTERNS: { category: EndpointCategory; re: RegExp }[] = [
  { category: 'api-keys', re: /(api[-_]?keys?|listkeys|\bkeys\b|credentials?|secrets?)/ },
  { category: 'invoices', re: /(invoices?|billing|receipts?|charges?|payments?|subscriptions?)/ },
  { category: 'usage', re: /(usage|metrics?|\bstats\b|consumption|quota|analytics)/ },
  { category: 'members', re: /(members?|teams?|seats?|\busers?\b|people|invitations?|invites?|collaborators?)/ },
  { category: 'totals', re: /(totals?|summary|balance|overview|aggregate|cost[-_]?explorer)/ }
]

// Static assets often carry these words in their path (a Next.js chunk for the /account/members page is
// `_next/static/chunks/app/.../members/page-*.js`) — matching those would be a false positive. So consider
// only real data calls: never preflights or navigations, never `_next/static` or asset files.
const ASSET_EXT = /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|webp|avif|wasm)(\?|$)/i

// Telemetry / analytics beacons are write-only event sinks, not readable data surfaces — yet their path often
// carries a data-surface word ("metrics", "events", "stats") and they answer 200, so a naive scan mis-files one
// as a real capability (an ad-impression beacon `…ClientSideMetrics.nexus` read as "usage"). Drop them on the
// path: an event/ingest segment, an RUM/CSM collector, or a reverse-DNS `.nexus`/`.prod` event-stream tail.
const TELEMETRY_PATH =
  /(^|\/)(events?|collect|beacon|telemetry|ingest|batch|rum|csm|pixel|client[-_]?side[-_]?metrics)(\/|$)|\.(nexus|prod)$/

const isDataRequest = (r: RecordedRequest): boolean => {
  if (r.request.method === 'OPTIONS') {
    return false
  }

  if (/\/_next\/static\//.test(r.request.url) || ASSET_EXT.test(r.request.url)) {
    return false
  }

  const type = r.type.toLowerCase()

  // `Ping` is navigator.sendBeacon — fire-and-forget telemetry, never a surface you can read back.
  if (type === 'ping') {
    return false
  }

  if (type === 'xhr' || type === 'fetch' || type === 'eventsource') {
    return true
  }

  return r.response.mimeType.toLowerCase().includes('application/json')
}

// Collapse id-like segments (uuids, hashes, long numbers, Clerk `sess_`/`user_` ids) so `/v2/teams/<uuid>`
// reads as `/v2/teams/:id` and repeated calls to the same shape dedupe.
const normalizePath = (pathname: string): string =>
  pathname
    .split('/')
    .map((seg) =>
      /^[0-9a-f]{8}-[0-9a-f-]{8,}$|^[0-9a-f]{16,}$|^\d{4,}$|^(sess|user|org|team)_/.test(seg) ? ':id' : seg
    )
    .join('/')

const PER_CATEGORY_CAP = 6

// Scan a run's traffic for endpoints whose path looks like a data surface worth gathering, deduped by shape
// and capped per category. Surfaced in the detected profile as a clue to what a plugin could collect here.
export const classifyEndpoints = (requests: RecordedRequest[]): EndpointHint[] => {
  const out: EndpointHint[] = []
  const seen = new Set<string>()
  const counts = new Map<EndpointCategory, number>()

  for (const r of requests) {
    if (!isDataRequest(r)) {
      continue
    }

    let pathname: string

    try {
      pathname = new URL(r.request.url).pathname
    } catch {
      continue
    }

    if (TELEMETRY_PATH.test(pathname.toLowerCase())) {
      continue
    }

    const hit = PATTERNS.find((p) => p.re.test(pathname.toLowerCase()))

    if (!hit) {
      continue
    }

    const key = `${hit.category}:${normalizePath(pathname.toLowerCase())}`

    if (seen.has(key) || (counts.get(hit.category) ?? 0) >= PER_CATEGORY_CAP) {
      continue
    }

    seen.add(key)
    counts.set(hit.category, (counts.get(hit.category) ?? 0) + 1)
    out.push({ category: hit.category, method: r.request.method, url: r.request.url, host: hostOf(r.request.url) })
  }

  return out
}

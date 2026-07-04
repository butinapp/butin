import type { RecordedRequest } from '../main/recording/types.js'

import type { Guess, TransportLabel } from './types.js'

const headerVal = (headers: Record<string, string> | undefined, name: string): string | undefined => {
  if (!headers) {
    return undefined
  }

  const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === name)

  return hit?.[1]
}

// Some edges only accept a real browser (they reject a plain Node client and bind cf_clearance to (IP, UA, TLS identity)) —
// those need the electron transport with the real browser's TLS identity. Any one of: a cf-mitigated
// header, a cf_clearance cookie, or a 403 from a Cloudflare edge is enough to flag the surface.
export const classifyTransport = (requests: RecordedRequest[]): Guess<TransportLabel> => {
  const evidence: string[] = []

  for (const r of requests) {
    const server = headerVal(r.response.headers, 'server') ?? headerVal(r.response.wireHeaders, 'server')
    const mitigated = headerVal(r.response.wireHeaders, 'cf-mitigated') ?? headerVal(r.response.headers, 'cf-mitigated')
    const setCookie = (r.response.setCookieHeaders ?? []).join('; ')

    if (mitigated) {
      evidence.push(`cf-mitigated: ${mitigated} on ${r.request.url}`)
    }

    if (setCookie.includes('cf_clearance=')) {
      evidence.push(`cf_clearance cookie set on ${r.request.url}`)
    }

    if (server?.toLowerCase() === 'cloudflare' && r.response.status === 403) {
      evidence.push(`403 from cloudflare on ${r.request.url}`)
    }
  }

  if (evidence.length > 0) {
    return { value: { engine: 'electron', requiresBrowserEngine: true }, confidence: 'high', evidence }
  }

  return {
    value: { engine: 'node', requiresBrowserEngine: false },
    confidence: 'high',
    evidence: ['no browser-engine signal']
  }
}

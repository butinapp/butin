import type { AuthKind } from '@butinapp/sdk'

import type { RecordedRequest } from '../main/recording/types.js'

import type { Confidence, Guess } from './types.js'

const lc = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))

const headersOf = (r: RecordedRequest): Record<string, string> =>
  lc({ ...r.request.headers, ...(r.request.wireHeaders ?? {}) })

const CSRF_HEADERS = ['x-csrf-token', 'x-xsrf-token', 'x-csrftoken', 'csrf-token']

// Decode a JWT's payload claims (the bits we classify on). Returns undefined for opaque (non-JWT) tokens.
const jwtClaims = (token: string): { exp?: number; iss?: string } | undefined => {
  const part = token.split('.')[1]

  if (!part) {
    return undefined
  }

  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: number; iss?: string }
  } catch {
    return undefined
  }
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

// A JWT `iss` is usually a URL (`https://clerk.x.com`) but may be a bare host — reduce either to a host.
const issuerHost = (iss: string): string => {
  try {
    return new URL(iss).host
  } catch {
    return iss.replace(/^https?:\/\//, '').split('/')[0] ?? ''
  }
}

const guess = (value: AuthKind, confidence: Confidence, evidence: string[]): Guess<AuthKind> => ({
  value,
  confidence,
  evidence
})

// Classify the replay strategy from the observed auth material. Order matters: the more specific shapes
// (minted-jwt, cookie-csrf) are tested before the generic cookie/bearer fallbacks.
// Emits 6 of the 8 auth kinds — rotating-refresh and api-key are not detectable from a request trace
// (they look identical to bearer-token/external on the wire) and must be set manually by the plugin author.
export const classifyAuth = (requests: RecordedRequest[]): Guess<AuthKind> => {
  // Each Bearer use, paired with the host it was presented to — the host matters for the issuer heuristic.
  const bearerUses = requests.flatMap((r) => {
    const auth = headersOf(r).authorization

    return auth?.toLowerCase().startsWith('bearer ') ? [{ token: auth.slice(7), host: hostOf(r.request.url) }] : []
  })
  const bearers = bearerUses.map((b) => b.token)
  const hosts = new Set(requests.map((r) => hostOf(r.request.url)).filter(Boolean))

  const hasCookie = requests.some((r) => Boolean(headersOf(r).cookie))
  const csrfHit = requests.find((r) => CSRF_HEADERS.some((h) => h in headersOf(r)))

  // minted-jwt, signal A — a POST whose response body literally contains a presented Bearer: that endpoint
  // handed the token back, so it's minted per session and replay means re-calling the mint. The token guard
  // (length > 16) avoids matching a trivial opaque value that happens to appear in some body.
  const mintPost = requests.find(
    (r) => r.request.method === 'POST' && bearers.some((b) => b.length > 16 && (r.response.body ?? '').includes(b))
  )

  // minted-jwt, signal B — a Bearer JWT whose `iss` is a *different* host than the API it's sent to, and that
  // issuer host is itself in the trace. That's an identity host (Clerk, Auth0, …) minting tokens for a separate
  // API. The mint often happened in an earlier session (token still valid), so signal A won't fire — the
  // cross-host issuer is the durable tell. Example: api.upstash.com Bearer with iss=clerk.upstash.com.
  const issuerMint = bearerUses.find((b) => {
    const iss = jwtClaims(b.token)?.iss

    if (!iss) {
      return false
    }

    const ih = issuerHost(iss)

    return Boolean(ih) && ih !== b.host && hosts.has(ih)
  })

  const shortLived = bearers.find((b) => {
    const exp = jwtClaims(b)?.exp

    return exp !== undefined && exp - Math.floor(Date.now() / 1000) < 60 * 60
  })

  if (mintPost) {
    return guess('minted-jwt', 'high', [
      `token returned by POST ${mintPost.request.url}`,
      shortLived ? 'reused as a short-exp Bearer' : 'reused as a Bearer'
    ])
  }

  if (issuerMint) {
    const ih = issuerHost(jwtClaims(issuerMint.token)?.iss ?? '')

    return guess('minted-jwt', shortLived ? 'high' : 'medium', [
      `Bearer JWT issued by ${ih} (a distinct identity host) and presented to ${issuerMint.host}`,
      'the token is minted by the IdP — replay re-mints it from the live session'
    ])
  }

  if (csrfHit && hasCookie) {
    const name = CSRF_HEADERS.find((h) => h in headersOf(csrfHit))

    return guess('cookie-csrf', 'high', [`cookie + ${name} header on ${csrfHit.request.url}`])
  }

  if (bearers.length > 0) {
    const stable = new Set(bearers).size === 1

    if (shortLived) {
      return guess('spa-bearer', 'low', [
        'short-exp Bearer with no replayable mint endpoint in the trace — verify it is an SPA OIDC silent-renew'
      ])
    }

    return guess('bearer-token', stable ? 'high' : 'medium', [
      stable ? 'one stable Authorization: Bearer reused' : 'multiple Bearer values seen'
    ])
  }

  if (hasCookie) {
    return guess('cookie', 'high', ['requests authenticate with the session cookie alone'])
  }

  return guess('external', 'low', ['no captured session auth — likely a durable key / SigV4 configured out-of-band'])
}

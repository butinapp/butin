import type { Guess, RunData } from './types.js'
import { hostOf } from './url.js'

// Cookie NAMES that are identity-provider session material. A stale copy of one of these still loads the app and
// wedges the next sign-in (a dead WorkOS/Auth0/Stytch/Clerk session that never re-auths cleanly), so it's a
// clear-before-capture candidate on its own — it won't match the durable app session you replay (`sessionid`).
const IDP_NAME = /auth0|stytch|workos|clerk|okta|keycloak|kratos|_ory|cognito|onelogin/i

// Generic session / CSRF names. These alone aren't enough — a durable login token is often named `*session*`
// too — so a session-named cookie is only flagged when its value ROTATES (below), which separates a transient
// Rails-style `_gh_sess` from the stable token you actually replay.
const SESSION_NAME = /sess|xsrf|csrf/i

// A request on the login / OAuth / SSO leg of the journey — the host is an IdP/auth subdomain, or the URL
// carries the authorization-code-flow markers. Cookies set here are part of the auth handshake; used to lift a
// flagged cookie's confidence and to name where it came from.
const OAUTH_MARKERS = [
  'client_id=',
  'redirect_uri=',
  'authorization_session_id=',
  'response_type=',
  '/oauth',
  '/authorize',
  '/sso-callback',
  '/authkit'
]
const AUTH_HOST = /^(login|auth|accounts|sso|id|idp)\.|(^|\.)(auth0|okta|workos|stytch|clerk|onelogin)\.com$/i

const onAuthLeg = (url: string): boolean => {
  const u = url.toLowerCase()

  return AUTH_HOST.test(hostOf(url)) || OAUTH_MARKERS.some((m) => u.includes(m))
}

type CookieSetting = {
  name: string
  value: string
}

// Parse a raw `Set-Cookie` line to its name + value. A bare/empty value is a deletion (a logout clear), not a
// set, so it's dropped — only cookies the server actually establishes are considered.
const parseSetCookie = (line: string): CookieSetting | null => {
  const pair = line.split(';')[0] ?? ''
  const eq = pair.indexOf('=')

  if (eq < 1) {
    return null
  }

  const name = pair.slice(0, eq).trim()
  const value = pair.slice(eq + 1).trim()

  return name && value ? { name, value } : null
}

type Flag = { name: string; confidence: 'high' | 'medium'; reason: string }

// Detect the session/auth cookies a plugin should list in `session.clearCookiesBeforeCapture`: an identity-
// provider session cookie (a stale one blocks re-auth) or a rotating session/CSRF cookie set on the auth leg
// (promote-on-quit persists it and it poisons the next OAuth `state`). A STABLE durable login token — the cookie
// you actually replay — is deliberately not flagged, so pasting the suggestion in can't break session reuse.
export const detectClearBeforeCapture = (run: RunData): Guess<string[]> => {
  // Fold every Set-Cookie occurrence per name: the distinct values it took (volatility), whether any was set on
  // the auth leg, and the host that set it (for the evidence line).
  const byName = new Map<string, { values: Set<string>; authLeg: boolean; host?: string }>()

  for (const r of run.requests) {
    for (const line of r.response.setCookieHeaders ?? []) {
      const cookie = parseSetCookie(line)

      if (!cookie) {
        continue
      }

      const agg = byName.get(cookie.name) ?? { values: new Set<string>(), authLeg: false }

      agg.values.add(cookie.value)

      if (onAuthLeg(r.request.url)) {
        agg.authLeg = true
        agg.host ??= hostOf(r.request.url)
      }

      byName.set(cookie.name, agg)
    }
  }

  const flags: Flag[] = []

  for (const [name, agg] of byName) {
    const where = agg.host ? ` set by ${agg.host}` : ''

    if (IDP_NAME.test(name)) {
      flags.push({
        name,
        confidence: agg.authLeg ? 'high' : 'medium',
        reason: `${name} — an identity-provider session cookie${where}; a stale one blocks a clean re-auth`
      })
    } else if (SESSION_NAME.test(name) && agg.values.size >= 2) {
      flags.push({
        name,
        confidence: agg.authLeg ? 'high' : 'medium',
        reason: `${name} — a rotating session/CSRF cookie (${agg.values.size} distinct values)${where}; promote-on-quit persists it and it poisons re-auth (verify it isn't the session you replay)`
      })
    }
  }

  if (flags.length === 0) {
    return {
      value: [],
      confidence: 'low',
      evidence: ['no transient auth/session cookies detected — leave clearCookiesBeforeCapture empty']
    }
  }

  // Highest-confidence first, then alphabetical — the order they'd read best in the plugin's cookie list.
  flags.sort((a, b) =>
    a.confidence === b.confidence ? a.name.localeCompare(b.name) : a.confidence === 'high' ? -1 : 1
  )

  return {
    value: flags.map((f) => f.name),
    confidence: flags.some((f) => f.confidence === 'high') ? 'high' : 'medium',
    evidence: flags.map((f) => f.reason)
  }
}

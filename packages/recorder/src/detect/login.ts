import type { Guess, LoginMode, RunData } from './types.js'
import { hostOf } from './url.js'

const IDP_HOSTS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'github.com/login',
  'appleid.apple.com',
  'auth0.com',
  'okta.com'
]
// OAuth/SSO markers that don't ride a known IdP host: the provider strategy on a Clerk/Supabase sign-in, the
// authorize/callback hops of the code flow. Catch these so federated sign-in isn't mistaken for a password POST.
const OAUTH_HINTS = ['strategy=oauth', 'oauth_callback', '/sso-callback', '/oauth/authorize', 'response_type=code']
const MFA_HINTS = ['/mfa', '/otp', '/2fa', '/totp', '/challenge', '/verify']
const MAGIC_HINTS = ['/magic', '/email-link', '/passwordless']
// A real credential submission. NOT a token mint or session refresh: Clerk's `/v1/client/sessions/<id>/tokens`
// is token minting, not a login, so `/tokens` and `/sessions/<id>/…` sub-resources are excluded below.
const LOGIN_POST = /\/(log[-_]?in|sign[-_]?in|sign_in|authenticate)(\/|\?|$)/
// Rails-style `POST /session(s)` creates a session = a login — but only as a terminal segment, not a parent
// path like `/sessions/<id>/tokens` (token mint) which a bare `/sessions` match would wrongly flag.
const SESSION_CREATE = /\/sessions?(\?|$)/
const TOKEN_MINT = /\/tokens?(\/|\?|$)/

// The sign-in flow (how you authenticate), distinct from the auth kind (how you replay). It feeds the
// plugin's session block — login markers + the clearCookiesBeforeCapture OAuth-state-cookie trap.
export const detectLoginMode = (run: RunData): Guess<LoginMode> => {
  const urls = [...run.navigation.map((n) => n.url), ...run.requests.map((r) => r.request.url)]
  const has = (needles: string[]): string | undefined =>
    urls.find((u) => needles.some((n) => u.toLowerCase().includes(n)))

  const idp = has(IDP_HOSTS)

  if (idp) {
    return { value: 'oauth-sso', confidence: 'high', evidence: [`journey hops through ${hostOf(idp)}`] }
  }

  const oauth = has(OAUTH_HINTS)

  if (oauth) {
    return { value: 'oauth-sso', confidence: 'medium', evidence: [`a federated sign-in marker at ${oauth}`] }
  }

  const mfa = has(MFA_HINTS)

  if (mfa) {
    return { value: 'mfa', confidence: 'medium', evidence: [`a second-factor step at ${mfa}`] }
  }

  const magic = has(MAGIC_HINTS)

  if (magic) {
    return { value: 'magic-link', confidence: 'medium', evidence: [`a passwordless endpoint at ${magic}`] }
  }

  // A credential POST, but never a token mint: a session-token endpoint (e.g. Clerk's `/sessions/<id>/tokens`)
  // is auth *replay*, not sign-in — flagging it as a password login is the bug this guard closes.
  const post = run.requests.find(
    (r) =>
      r.request.method === 'POST' &&
      !TOKEN_MINT.test(r.request.url) &&
      (LOGIN_POST.test(r.request.url) || SESSION_CREATE.test(r.request.url))
  )

  if (post) {
    return { value: 'password', confidence: 'medium', evidence: [`credentials POST to ${post.request.url}`] }
  }

  return { value: 'unknown', confidence: 'low', evidence: ['no recognizable sign-in step in this run'] }
}

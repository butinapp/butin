import type { AuthAttachment, AuthStrategy, ButinClient, CredentialStore } from '@butinapp/sdk'

import { ensureSpaBearer } from '../session/spa-session.js'

export type AuthResolver = () => Promise<AuthAttachment>

// `rotating-refresh` rotates the credential every call, so it must never be memoized.
const neverMemo = (kind: AuthStrategy['kind']): boolean => kind === 'rotating-refresh'

export const createAuthResolver = (
  strategy: AuthStrategy,
  creds: CredentialStore,
  client: ButinClient,
  config: Record<string, unknown>,
  // `bare` skips strategy.resolve() and attaches only the stored cookie/bearer — used to build the
  // base client that resolve() hooks themselves fetch/scrape/mint against (avoids infinite recursion).
  // `pluginId` keys the spa-bearer token cache (the offscreen boot is per-plugin). `cookieField` is the
  // credential field the replayed cookie comes from — `cookie` for the primary session, `cookie:<backend>`
  // for a secondary backend that captured its OWN login. `spaBootTimeoutMs` tightens the offscreen-boot
  // budget for the latency-sensitive probe path (test-all); a real refresh leaves it to the strategy default.
  opts: { memo?: boolean; bare?: boolean; pluginId?: string; cookieField?: string; spaBootTimeoutMs?: number } = {}
): AuthResolver => {
  const cookieField = opts.cookieField ?? 'cookie'
  const memo = (opts.memo ?? true) && !neverMemo(strategy.kind)
  let cached: Promise<AuthAttachment> | null = null

  const resolveOnce = async (): Promise<AuthAttachment> => {
    // `resolve` exists only on the variants that supply one (api-key / cookie-csrf / minted-jwt /
    // rotating-refresh); the union doesn't expose it on the rest, hence the `in` narrow.
    if (!opts.bare && 'resolve' in strategy && strategy.resolve) {
      return strategy.resolve({ client, creds, config })
    }

    // spa-bearer: the credential is minted by the service's live SPA. Boot it offscreen, capture the
    // Bearer (cached per-plugin), and attach it alongside the captured cookie. Core-resolved (Electron).
    if (!opts.bare && strategy.kind === 'spa-bearer') {
      const bearer = await ensureSpaBearer(opts.pluginId ?? '', strategy, opts.spaBootTimeoutMs)

      return { headers: { Authorization: bearer }, cookie: creds.get(cookieField) ?? '' }
    }

    if (strategy.kind === 'bearer-token') {
      const token = creds.get(strategy.tokenField ?? 'accessToken') ?? ''

      return { headers: { Authorization: `Bearer ${token}` } }
    }

    // external: the plugin authenticates itself (its own SDK/client) inside collect(); core attaches
    // nothing. The handed-in client is unused — there's no cookie or header to apply.
    if (strategy.kind === 'external') {
      return {}
    }

    // default: cookie
    return { cookie: creds.get(cookieField) ?? '' }
  }

  return () => {
    if (!memo) {
      return resolveOnce()
    }

    if (!cached) {
      cached = resolveOnce()
    }

    return cached
  }
}

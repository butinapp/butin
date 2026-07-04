import type { Session } from 'electron'

// Chromium keeps session cookies (no Expires/Max-Age) in memory only and drops them on quit — even in
// a persist: partition. Most SaaS/Google auth cookies are session cookies, so without intervention they
// vanish on quit and force a re-login next launch. Promoting every session cookie to a 30-day persistent
// cookie and flushing the store at quit avoids that needless client-side re-login; server-side
// short-lived tokens still expire on the server regardless. `excludeDomains` opts a service out
// (session.persistCookies:false): its cookies are left to vanish on quit so a promoted-but-stale token
// can't poison the next sign-in.
export const promoteSessionCookies = async (
  ses: Session,
  excludeDomains: string[] = [],
  opts: { quiet?: boolean } = {}
): Promise<void> => {
  try {
    const cookies = await ses.cookies.get({})
    const thirtyDays = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30

    await Promise.all(
      cookies
        .filter((c) => c.session && !!c.domain && !excludeDomains.some((d) => (c.domain ?? '').includes(d)))
        .map((c) => {
          const host = (c.domain ?? '').replace(/^\./, '')
          // Cookie-prefix rules Chromium enforces on set: a `__Host-` cookie must be Secure, path=/, and carry
          // NO domain (host-only); a `__Secure-` cookie must be Secure. Re-setting them with the captured
          // attributes (a domain, or non-secure) is rejected (EXCLUDE_INVALID_PREFIX) — honor the rules instead.
          const hostPrefix = c.name.startsWith('__Host-')
          const secure = c.secure || hostPrefix || c.name.startsWith('__Secure-')

          return (
            ses.cookies
              .set({
                url: `${secure ? 'https' : 'http'}://${host}${hostPrefix ? '/' : c.path || '/'}`,
                name: c.name,
                value: c.value,
                // __Host- cookies are host-only — a domain attribute invalidates the prefix.
                ...(hostPrefix ? {} : { domain: c.domain }),
                path: hostPrefix ? '/' : c.path,
                secure,
                httpOnly: c.httpOnly,
                sameSite: c.sameSite,
                expirationDate: thirtyDays
              })
              // Name the host so a failure points at the service it came from (a harmless tracking cookie that
              // can't overwrite its Secure twin, vs an auth cookie that genuinely failed to persist).
              .catch((e) => console.warn(`[cookies] could not persist ${c.name} (${host}):`, e?.message ?? e))
          )
        })
    )

    await ses.cookies.flushStore()

    if (!opts.quiet) {
      console.log('[cookies] promoted session cookies to persistent')
    }
  } catch (err) {
    console.warn('[cookies] failed to persist session cookies:', (err as Error)?.message ?? err)
  }
}

// Disconnect one service WITHOUT logging you out of Google for every other service that shares the
// partition: remove only the cookies whose host matches this plugin's domains, leaving the shared
// Google/SSO session intact.
export const clearServiceCookies = async (ses: Session, domains: string[]): Promise<void> => {
  const cookies = await ses.cookies.get({})

  await Promise.all(
    cookies
      .filter((c) => domains.some((d) => (c.domain ?? '').includes(d)))
      .map((c) => {
        const host = (c.domain ?? '').replace(/^\./, '')

        return ses.cookies
          .remove(`https://${host}${c.path || '/'}`, c.name)
          .catch((e) => console.warn(`[cookies] could not clear ${c.name}:`, e?.message ?? e))
      })
  )
}

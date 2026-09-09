import type { Cookie, CookiesSetDetails, Session } from 'electron'

// One cookie as the args Electron's `cookies.set` wants, honoring the rules Chromium enforces on set — the
// single place any Butin code turns a read cookie back into a written one.
//
// `domain` is the trap. Electron normalizes it with a preceding dot to make it valid for subdomains, so handing
// one back for a HOST-ONLY cookie doesn't re-set that cookie: it writes a SECOND, subdomain-scoped cookie of the
// same name. The server, which sends no Domain attribute, then only ever updates the host-only original, and the
// twin rides along with a value frozen at write time. Two values under one name is what breaks a login — a
// Rails/Express session cookie read back stale makes an OAuth `state` mismatch.
//
// Cookie-prefix rules ride along: a `__Host-` cookie must be Secure, path `/` and carry NO domain, and a
// `__Secure-` cookie must be Secure. Re-setting either with its captured attributes is rejected outright
// (EXCLUDE_INVALID_PREFIX) and the cookie is silently lost.
//
// `expirationDate` overrides the cookie's own expiry (promotion pins a horizon); without it a persistent cookie
// keeps its expiry and a session cookie stays one.
export const toSetDetails = (c: Cookie, opts: { expirationDate?: number } = {}): CookiesSetDetails => {
  const host = (c.domain ?? '').replace(/^\./, '')
  const hostPrefix = c.name.startsWith('__Host-')
  const secure = c.secure || hostPrefix || c.name.startsWith('__Secure-')
  // The stored domain's leading dot is what marks a cookie domain-scoped; `hostOnly` states it outright.
  const hostOnly = hostPrefix || (c.hostOnly ?? !(c.domain ?? '').startsWith('.'))
  const path = hostPrefix ? '/' : c.path

  return {
    url: `${secure ? 'https' : 'http'}://${host}${path || '/'}`,
    name: c.name,
    value: c.value,
    ...(hostOnly ? {} : { domain: c.domain }),
    path,
    secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expirationDate: opts.expirationDate ?? (c.session ? undefined : c.expirationDate)
  }
}

// Copy every cookie from one session into another, returning how many landed. Carrying a login out of a
// throwaway partition into the profile's real one is the use: the isolated jar dies with its window, so the copy
// has to happen while it is still alive. A rejected cookie is named rather than swallowed.
export const copyCookies = async (from: Session, to: Session): Promise<number> => {
  let count = 0

  for (const c of await from.cookies.get({})) {
    try {
      await to.cookies.set(toSetDetails(c))
      count++
    } catch (err) {
      console.warn(`[cookies] could not copy ${c.name} (${c.domain ?? ''}):`, (err as Error)?.message ?? err)
    }
  }

  return count
}

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
        .map((c) =>
          ses.cookies
            .set(toSetDetails(c, { expirationDate: thirtyDays }))
            // Name the host so a failure points at the service it came from (a harmless tracking cookie that
            // can't overwrite its Secure twin, vs an auth cookie that genuinely failed to persist).
            .catch((e) =>
              console.warn(
                `[cookies] could not persist ${c.name} (${(c.domain ?? '').replace(/^\./, '')}):`,
                e?.message ?? e
              )
            )
        )
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

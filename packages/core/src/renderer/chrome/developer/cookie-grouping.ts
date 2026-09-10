import type { DevCookieDto } from '../../../shared/ipc.js'

export type CookieGroup = {
  domain: string
  cookies: DevCookieDto[]
  count: number
  bytes: number
}

// Group cookies by their domain, summing the byte weight per group (what trips Chromium's per-domain cap),
// biggest group first. An optional case-insensitive substring filters by domain.
export const groupCookiesByDomain = (cookies: DevCookieDto[], filter = ''): CookieGroup[] => {
  const needle = filter.trim().toLowerCase()
  const byDomain = new Map<string, DevCookieDto[]>()

  for (const c of cookies) {
    if (needle && !c.domain.toLowerCase().includes(needle)) {
      continue
    }

    const list = byDomain.get(c.domain) ?? []

    list.push(c)
    byDomain.set(c.domain, list)
  }

  return [...byDomain.entries()]
    .map(([domain, list]) => ({
      domain,
      cookies: list,
      count: list.length,
      bytes: list.reduce((s, c) => s + c.size, 0)
    }))
    .sort((a, b) => b.bytes - a.bytes)
}

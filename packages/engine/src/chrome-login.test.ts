import { describe, expect, it } from 'vitest'

import { cdpCookieToElectron, chromeCandidates, isSigninBlockUrl, mapSameSite, type CdpCookie } from './chrome-login.js'

const base: CdpCookie = {
  name: 'SID',
  value: 'abc',
  domain: '.google.com',
  path: '/',
  expires: 1893456000,
  httpOnly: true,
  secure: true,
  session: false,
  sameSite: 'Lax'
}

describe('mapSameSite', () => {
  it('maps CDP sameSite to Electron values', () => {
    expect(mapSameSite('Strict')).toBe('strict')
    expect(mapSameSite('Lax')).toBe('lax')
    expect(mapSameSite('None')).toBe('no_restriction')
    expect(mapSameSite(undefined)).toBe('unspecified')
  })
})

describe('cdpCookieToElectron', () => {
  it('builds an https url from the host and keeps the expiry for a persistent cookie', () => {
    const out = cdpCookieToElectron(base)

    expect(out.url).toBe('https://google.com/')
    expect(out.name).toBe('SID')
    expect(out.domain).toBe('.google.com')
    expect(out.secure).toBe(true)
    expect(out.expirationDate).toBe(1893456000)
    expect(out.sameSite).toBe('lax')
  })

  it('uses http when not secure and drops expiry for a session cookie', () => {
    const out = cdpCookieToElectron({ ...base, secure: false, session: true, expires: -1 })

    expect(out.url).toBe('http://google.com/')
    expect(out.expirationDate).toBeUndefined()
  })

  it('strips a leading dot from the host in the url but keeps it in domain', () => {
    const out = cdpCookieToElectron({ ...base, domain: '.accounts.google.com', path: '/o/oauth2' })

    expect(out.url).toBe('https://accounts.google.com/o/oauth2')
    expect(out.domain).toBe('.accounts.google.com')
  })

  // Electron widens `domain` with a preceding dot, so a host-only cookie must carry none — otherwise it lands
  // as a subdomain-scoped twin the server never updates.
  it('omits domain for a host-only cookie (no leading dot)', () => {
    const out = cdpCookieToElectron({ ...base, name: 'LSID', domain: 'accounts.google.com' })

    expect(out.url).toBe('https://accounts.google.com/')
    expect(out.domain).toBeUndefined()
  })

  // A `__Host-` cookie with any Domain attribute is rejected outright (EXCLUDE_INVALID_PREFIX), which is how
  // Google's sign-in cookies went missing from a synced session.
  it('omits domain for a __Host- prefixed cookie', () => {
    const out = cdpCookieToElectron({ ...base, name: '__Host-GAPS', domain: 'accounts.google.com' })

    expect(out.domain).toBeUndefined()
    expect(out.path).toBe('/')
    expect(out.secure).toBe(true)
  })
})

describe('chromeCandidates', () => {
  it('returns at least one candidate path for the current platform', () => {
    expect(chromeCandidates().length).toBeGreaterThan(0)
  })
})

describe('isSigninBlockUrl', () => {
  it('flags a Google sign-in rejection url', () => {
    expect(isSigninBlockUrl('https://accounts.google.com/v3/signin/rejected?flow=glif')).toBe(true)
    expect(isSigninBlockUrl('https://accounts.google.com/signin/v2/deniedsigninrejected')).toBe(true)
  })

  it('does not flag a normal Google sign-in page or another host', () => {
    expect(isSigninBlockUrl('https://accounts.google.com/v3/signin/identifier')).toBe(false)
    expect(isSigninBlockUrl('https://github.com/login/rejected')).toBe(false)
  })
})

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

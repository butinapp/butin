import { describe, expect, it } from 'vitest'

import { clampMagicWindowBounds, computeReadiness, cookieNameMatches, matchMarkerUrl } from './magic-login.js'

const markers = ['dashboard', 'app.example.com/home']

describe('cookieNameMatches', () => {
  it('matches an exact name', () => {
    expect(cookieNameMatches('_gh_sess', ['_gh_sess'])).toBe(true)
    expect(cookieNameMatches('user_session', ['_gh_sess'])).toBe(false)
  })

  it('matches a `*`-suffixed pattern by prefix (a cookie with a dynamic suffix)', () => {
    expect(cookieNameMatches('ory_hydra_login_csrf_698966587', ['ory_hydra_login_csrf_*'])).toBe(true)
    expect(cookieNameMatches('ory_hydra_consent_csrf_698966587', ['ory_hydra_login_csrf_*'])).toBe(false)
  })

  it('leaves the durable session token intact when clearing only the CSRF prefixes', () => {
    const patterns = ['ory_hydra_login_csrf_*', 'ory_hydra_consent_csrf_*']

    expect(cookieNameMatches('__Secure-authjs.session-token.0', patterns)).toBe(false)
    expect(cookieNameMatches('ory_hydra_session', patterns)).toBe(false)
  })

  it('is false against an empty pattern list', () => {
    expect(cookieNameMatches('anything', [])).toBe(false)
  })
})

describe('clampMagicWindowBounds', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 }

  it('keeps a rectangle fully inside a display', () => {
    const b = { x: 100, y: 80, width: 1040, height: 820 }

    expect(clampMagicWindowBounds(b, [primary])).toEqual(b)
  })

  it('keeps a rectangle that still overlaps a display enough to grab', () => {
    // Mostly off the right edge but a 200px-wide strip remains on-screen.
    const b = { x: 1720, y: 80, width: 1040, height: 820 }

    expect(clampMagicWindowBounds(b, [primary])).toEqual(b)
  })

  it('rejects a rectangle stranded on an unplugged monitor', () => {
    const b = { x: 3000, y: 200, width: 1040, height: 820 }

    expect(clampMagicWindowBounds(b, [primary])).toBeNull()
  })

  it('honors a secondary display when the primary does not contain it', () => {
    const secondary = { x: 1920, y: 0, width: 1920, height: 1040 }
    const b = { x: 2200, y: 100, width: 1040, height: 820 }

    expect(clampMagicWindowBounds(b, [primary, secondary])).toEqual(b)
  })

  it('rejects when only a sliver thinner than the grab threshold overlaps', () => {
    // 40px of width remains on-screen — below the 100px needed to drag the window back.
    const b = { x: 1880, y: 80, width: 1040, height: 820 }

    expect(clampMagicWindowBounds(b, [primary])).toBeNull()
  })
})

describe('computeReadiness', () => {
  it('is ready when a marker matches and the required cookie is present', () => {
    expect(computeReadiness('https://app.example.com/dashboard', new Set(['sid']), markers, 'sid')).toEqual({
      markerMatched: true,
      cookiePresent: true,
      ready: true
    })
  })

  it('is not ready when the marker matches but the required cookie is missing', () => {
    expect(computeReadiness('https://app.example.com/dashboard', new Set(['other']), markers, 'sid')).toEqual({
      markerMatched: true,
      cookiePresent: false,
      ready: false
    })
  })

  it('is not ready when the cookie is present but no marker matches', () => {
    expect(computeReadiness('https://app.example.com/login', new Set(['sid']), markers, 'sid')).toEqual({
      markerMatched: false,
      cookiePresent: true,
      ready: false
    })
  })

  it('is not ready when neither condition is met', () => {
    expect(computeReadiness('https://app.example.com/login', new Set(), markers, 'sid')).toEqual({
      markerMatched: false,
      cookiePresent: false,
      ready: false
    })
  })

  it('with no required cookie, any cookie for the domains counts', () => {
    expect(computeReadiness('https://app.example.com/dashboard', new Set(['anything']), markers, undefined)).toEqual({
      markerMatched: true,
      cookiePresent: true,
      ready: true
    })
  })

  it('with no required cookie, an empty jar is not ready even on a marker', () => {
    expect(computeReadiness('https://app.example.com/dashboard', new Set(), markers, undefined)).toEqual({
      markerMatched: true,
      cookiePresent: false,
      ready: false
    })
  })
})

describe('matchMarkerUrl', () => {
  it('returns a popup URL that matches a marker when the main view does not', () => {
    // Main view still on the login page; the Google-OAuth popup landed on the authed page.
    const urls = ['https://app.example.com/login', 'https://app.example.com/dashboard']

    expect(matchMarkerUrl(urls, markers)).toBe('https://app.example.com/dashboard')
  })

  it('prefers the main view when it matches', () => {
    const urls = ['https://app.example.com/dashboard', 'https://accounts.google.com/o/oauth2/auth']

    expect(matchMarkerUrl(urls, markers)).toBe('https://app.example.com/dashboard')
  })

  it('falls back to the main view URL (first entry) when nothing matches', () => {
    expect(matchMarkerUrl(['https://app.example.com/login'], markers)).toBe('https://app.example.com/login')
    expect(matchMarkerUrl([], markers)).toBe('')
  })
})

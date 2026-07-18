import { describe, expect, it } from 'vitest'

import { hostOf, registrableDomain } from './url.js'

describe('hostOf', () => {
  it('extracts the host, and returns empty for a malformed URL', () => {
    expect(hostOf('https://app.acme.com/path')).toBe('app.acme.com')
    expect(hostOf('not a url')).toBe('')
  })
})

describe('registrableDomain', () => {
  it('collapses subdomains to the eTLD+1', () => {
    expect(registrableDomain('www.acme.com')).toBe('acme.com')
    expect(registrableDomain('unagi.amazon.ca')).toBe('amazon.ca')
    expect(registrableDomain('presentry.io')).toBe('presentry.io')
  })

  it('keeps multi-label public suffixes intact across the long tail', () => {
    expect(registrableDomain('us.app.foo.co.uk')).toBe('foo.co.uk')
    // qc.ca is a public-suffix second level (Quebec under .ca) — the surface is hydro.qc.ca, not qc.ca.
    expect(registrableDomain('services.hydro.qc.ca')).toBe('hydro.qc.ca')
    expect(registrableDomain('www.canada.gc.ca')).toBe('canada.gc.ca')
  })

  it('returns empty for an unparseable host', () => {
    expect(registrableDomain('')).toBe('')
  })
})

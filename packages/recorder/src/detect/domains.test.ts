import { describe, expect, it } from 'vitest'

import type { RecordingManifest } from '../main/recording/types.js'

import { primaryHost, resolveSurface } from './domains.js'

const m = (hostCounts: Record<string, number>, startUrl = 'https://app.x.com/login'): RecordingManifest => ({
  runId: 'r',
  label: '',
  startUrl,
  partition: '',
  captureAll: false,
  startedAt: '',
  endedAt: '',
  requestCount: 0,
  navigationCount: 0,
  hostCounts
})

describe('primaryHost', () => {
  it('picks the dominant registrable domain, excluding the login IdP and analytics', () => {
    const host = primaryHost(m({ 'accounts.google.com': 9, 'api.x.com': 20, 'www.google-analytics.com': 30 }))

    expect(host).toBe('x.com')
  })

  it('collapses every subdomain of a site to one registrable domain', () => {
    expect(primaryHost(m({ 'www.acme.com': 5 }))).toBe('acme.com')
    expect(primaryHost(m({ 'app.acme.com': 5 }))).toBe('acme.com')
  })

  it('folds a service spread across subdomains, so the summed domain wins over a stray third party', () => {
    const host = primaryHost(m({ 'www.amazon.ca': 49, 'unagi.amazon.ca': 42, 'm.media-amazon.com': 8 }))

    expect(host).toBe('amazon.ca')
  })

  it('keeps a two-label public suffix intact', () => {
    expect(primaryHost(m({ 'app.foo.co.uk': 5 }))).toBe('foo.co.uk')
  })

  it('does not exclude a host that merely contains an excluded substring', () => {
    expect(primaryHost(m({ 'presentry.io': 7 }))).toBe('presentry.io')
  })

  it('prefers the start URL domain over higher-count challenge / consent third parties', () => {
    const host = primaryHost(
      m(
        {
          'serper.dev': 4,
          'api.serper.dev': 3,
          'challenges.cloudflare.com': 12,
          'ot.www.cloudflare.com': 6,
          'developers.cloudflare.com': 5,
          'geolocation.onetrust.com': 4
        },
        'https://serper.dev/'
      )
    )

    expect(host).toBe('serper.dev')
  })

  it('falls back to the counted leader when the start URL is a login host with no own traffic', () => {
    const host = primaryHost(m({ 'app.acme.com': 20, 'accounts.google.com': 5 }, 'https://accounts.google.com/signin'))

    expect(host).toBe('acme.com')
  })
})

describe('resolveSurface', () => {
  it('applies a merge decision', () => {
    expect(resolveSurface('monespace.videotron.com', { 'monespace.videotron.com': 'videotron' })).toBe('videotron')
  })

  it('returns the host unchanged with no merge', () => {
    expect(resolveSurface('x.com', {})).toBe('x.com')
  })
})

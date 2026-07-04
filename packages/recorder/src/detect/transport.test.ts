import { describe, expect, it } from 'vitest'

import type { RecordedRequest } from '../main/recording/types.js'

import { classifyTransport } from './transport.js'

const req = (over: Partial<RecordedRequest['response']>, url = 'https://api.x.com/v1'): RecordedRequest => ({
  index: 1,
  timestamp: '',
  type: 'XHR',
  request: { url, method: 'GET', headers: {}, body: null },
  response: { status: 200, headers: {}, body: '', base64Encoded: false, mimeType: 'application/json', ...over },
  timing: { requestSentMs: 0, responseReceivedMs: 1 }
})

describe('classifyTransport', () => {
  it('flags browser-engine → electron when a verification response is seen', () => {
    const g = classifyTransport([req({ status: 403, headers: { server: 'cloudflare', 'cf-mitigated': 'challenge' } })])

    expect(g.value).toEqual({ engine: 'electron', requiresBrowserEngine: true })
    expect(g.confidence).toBe('high')
    expect(g.evidence.join(' ')).toContain('cf-mitigated')
  })

  it('flags electron when a cf_clearance cookie is present', () => {
    const g = classifyTransport([req({ setCookieHeaders: ['cf_clearance=abc; Path=/'] })])

    expect(g.value.requiresBrowserEngine).toBe(true)
  })

  it('defaults to node when no browser-engine signal is present', () => {
    const g = classifyTransport([req({})])

    expect(g.value).toEqual({ engine: 'node', requiresBrowserEngine: false })
  })
})

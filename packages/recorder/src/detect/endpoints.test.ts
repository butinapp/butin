import { describe, expect, it } from 'vitest'

import type { RecordedRequest } from '../main/recording/types.js'

import { classifyEndpoints } from './endpoints.js'

const req = (url: string, over: { method?: string; type?: string; mimeType?: string } = {}): RecordedRequest => ({
  index: 1,
  timestamp: '',
  type: over.type ?? 'Fetch',
  request: { url, method: over.method ?? 'GET', headers: {}, body: null },
  response: {
    status: 200,
    headers: {},
    body: '',
    base64Encoded: false,
    mimeType: over.mimeType ?? 'application/json'
  },
  timing: { requestSentMs: 0, responseReceivedMs: 1 }
})

describe('classifyEndpoints', () => {
  it('files data paths under the right categories', () => {
    const hints = classifyEndpoints([
      req('https://api.upstash.com/v2/teams'),
      req('https://api.upstash.com/listkeys'),
      req('https://api.upstash.com/invoices'),
      req('https://console.upstash.com/redis/abc/usage'),
      req('https://api.x.com/account/balance')
    ])
    const byCat = (c: string) => hints.filter((h) => h.category === c)

    expect(byCat('members').length).toBe(1)
    expect(byCat('api-keys').length).toBe(1)
    expect(byCat('invoices').length).toBe(1)
    expect(byCat('usage').length).toBe(1)
    expect(byCat('totals').length).toBe(1)
  })

  it('ignores static assets whose path merely contains a category word', () => {
    const hints = classifyEndpoints([
      req('https://app.x.com/_next/static/chunks/app/account/members/page-abc.js', {
        type: 'Script',
        mimeType: 'application/javascript'
      }),
      req('https://app.x.com/assets/billing.css', { mimeType: 'text/css' })
    ])

    expect(hints).toHaveLength(0)
  })

  it('ignores OPTIONS preflights', () => {
    const hints = classifyEndpoints([req('https://api.x.com/v2/teams', { method: 'OPTIONS' })])

    expect(hints).toHaveLength(0)
  })

  it('dedupes the same shape across id-bearing paths', () => {
    const hints = classifyEndpoints([
      req('https://api.x.com/v2/teams/fe84ae13-9b27-4071-bae8-3157c5f8623c'),
      req('https://api.x.com/v2/teams/aa11bb22-9b27-4071-bae8-3157c5f8623c')
    ])

    expect(hints).toHaveLength(1)
  })

  it('does not treat a Clerk session-token mint as an api-key endpoint', () => {
    const hints = classifyEndpoints([req('https://clerk.x.com/v1/client/sessions/sess_123/tokens', { method: 'POST' })])

    expect(hints).toHaveLength(0)
  })

  it('drops a sendBeacon Ping telemetry sink even though it answers JSON', () => {
    const hints = classifyEndpoints([
      req('https://unagi-na.amazon.com/1/events/com.amazon.eel.p.D16GClientSideMetrics.nexus', {
        type: 'Ping',
        method: 'POST'
      })
    ])

    expect(hints).toHaveLength(0)
  })

  it('drops an event/metrics beacon path so an ad-metrics sink is not mis-read as usage', () => {
    const hints = classifyEndpoints([
      req('https://unagi-na.amazon.com/1/events/com.amazon.eel.ApertureService.NA.Prod.ClientSideMetricsData', {
        type: 'Fetch',
        method: 'POST'
      })
    ])

    expect(hints).toHaveLength(0)
  })

  it('still flags a genuine metrics read as usage', () => {
    const hints = classifyEndpoints([req('https://api.x.com/v1/metrics')])

    expect(hints.map((h) => h.category)).toEqual(['usage'])
  })
})

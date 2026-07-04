import { describe, expect, it } from 'vitest'

import { aggregateProfile, profileRun } from './profile.js'
import type { RunData } from './types.js'

const cookieRun: RunData = {
  manifest: {
    runId: 'r1',
    label: '',
    startUrl: 'https://app.x.com',
    partition: '',
    captureAll: false,
    startedAt: '',
    endedAt: '',
    requestCount: 1,
    navigationCount: 0,
    hostCounts: { 'api.x.com': 5 }
  },
  navigation: [],
  requests: [
    {
      index: 1,
      timestamp: '',
      type: 'XHR',
      request: { url: 'https://api.x.com/me', method: 'GET', headers: { cookie: 's=1' }, body: null },
      response: { status: 200, headers: {}, body: '', base64Encoded: false, mimeType: 'application/json' },
      timing: { requestSentMs: 0, responseReceivedMs: 1 }
    }
  ]
}

describe('profileRun / aggregateProfile', () => {
  it('profiles a single cookie-auth run', () => {
    expect(profileRun(cookieRun).auth.value).toBe('cookie')
  })

  it('aggregates and reports the run count', () => {
    const p = aggregateProfile('x.com', [cookieRun, cookieRun])

    expect(p.surface).toBe('x.com')
    expect(p.runCount).toBe(2)
    expect(p.auth.value).toBe('cookie')
    expect(p.conflicts).toHaveLength(0)
  })

  it('surfaces a secondary auth method seen in another session', () => {
    const bearerRun: RunData = {
      ...cookieRun,
      requests: [
        {
          ...cookieRun.requests[0],
          request: { ...cookieRun.requests[0].request, headers: { authorization: 'Bearer tok' } }
        }
      ]
    }
    const p = aggregateProfile('x.com', [cookieRun, bearerRun])

    expect(p.auth.value).toBe('cookie')
    expect(p.authAlternatives).toContain('bearer-token')
  })

  it('flags a Cookie riding alongside a Bearer as a second auth method', () => {
    const dualRun: RunData = {
      ...cookieRun,
      requests: [
        {
          ...cookieRun.requests[0],
          request: {
            ...cookieRun.requests[0].request,
            headers: { cookie: 's=1', authorization: 'Bearer tok' }
          }
        }
      ]
    }
    const p = aggregateProfile('x.com', [dualRun])

    expect(p.auth.value).toBe('bearer-token')
    expect(p.authAlternatives).toContain('cookie')
  })
})

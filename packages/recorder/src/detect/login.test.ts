import { describe, expect, it } from 'vitest'

import { detectLoginMode } from './login.js'
import type { RunData } from './types.js'

const run = (navUrls: string[], reqUrls: string[] = []): RunData => ({
  manifest: {
    runId: 'r',
    label: '',
    startUrl: navUrls[0] ?? '',
    partition: '',
    captureAll: false,
    startedAt: '',
    endedAt: '',
    requestCount: 0,
    navigationCount: navUrls.length
  },
  navigation: navUrls.map((url, i) => ({
    index: i + 1,
    ts: '',
    url,
    title: '',
    screenshot: '',
    context: 'page' as const
  })),
  requests: reqUrls.map((url, i) => ({
    index: i + 1,
    timestamp: '',
    type: 'Document',
    request: { url, method: 'POST', headers: {}, body: null },
    response: { status: 200, headers: {}, body: '', base64Encoded: false, mimeType: 'text/html' },
    timing: { requestSentMs: 0, responseReceivedMs: 1 }
  }))
})

describe('detectLoginMode', () => {
  it('oauth-sso when the journey hops through an IdP authorize endpoint', () => {
    const g = detectLoginMode(
      run([
        'https://app.x.com/login',
        'https://accounts.google.com/o/oauth2/v2/auth?client_id=1',
        'https://app.x.com/dashboard'
      ])
    )

    expect(g.value).toBe('oauth-sso')
  })

  it('password when a credentials POST is seen with no IdP hop', () => {
    const g = detectLoginMode(
      run(['https://app.x.com/login', 'https://app.x.com/dashboard'], ['https://app.x.com/api/login'])
    )

    expect(g.value).toBe('password')
  })

  it('NOT password when the only POST is a token mint (Clerk session-token endpoint)', () => {
    // An already-logged-in run: no sign-in step, only Clerk minting a session token. Must not read "password".
    const g = detectLoginMode(
      run(
        ['https://console.x.com'],
        ['https://clerk.x.com/v1/client/sessions/sess_123/tokens?__clerk_api_version=2025-11-10']
      )
    )

    expect(g.value).toBe('unknown')
  })

  it('oauth-sso when a federated strategy marker is present without an IdP host hop', () => {
    const g = detectLoginMode(
      run(['https://app.x.com/sign-in'], ['https://clerk.x.com/v1/client/sign_ins?strategy=oauth_google'])
    )

    expect(g.value).toBe('oauth-sso')
  })
})

import { describe, expect, it } from 'vitest'

import type { RecordedRequest } from '../main/recording/types.js'

import { detectClearBeforeCapture } from './cookies.js'
import type { RunData } from './types.js'

const req = (url: string, setCookieHeaders: string[]): RecordedRequest => ({
  index: 1,
  timestamp: '',
  type: 'Document',
  request: { url, method: 'GET', headers: {}, body: null },
  response: { status: 200, headers: {}, body: '', base64Encoded: false, mimeType: 'text/html', setCookieHeaders },
  timing: { requestSentMs: 0, responseReceivedMs: 1 }
})

const run = (requests: RecordedRequest[]): RunData => ({
  manifest: {} as RunData['manifest'],
  requests,
  navigation: []
})

describe('detectClearBeforeCapture', () => {
  it('flags an IdP session cookie set on the auth leg (high)', () => {
    const g = detectClearBeforeCapture(
      run([
        req('https://login.baseten.co/?client_id=client_abc&redirect_uri=https://app.baseten.co/api/auth/callback', [
          'workos_session=eyJ...; Path=/; HttpOnly'
        ])
      ])
    )

    expect(g.value).toEqual(['workos_session'])
    expect(g.confidence).toBe('high')
    expect(g.evidence[0]).toContain('identity-provider session cookie')
  })

  it('flags multiple IdP cookies (Stytch pair, Auth0)', () => {
    const groq = detectClearBeforeCapture(
      run([req('https://console.groq.com/login', ['stytch_session=a; Path=/', 'stytch_session_jwt=b; Path=/'])])
    )

    expect(new Set(groq.value)).toEqual(new Set(['stytch_session', 'stytch_session_jwt']))

    const clickhouse = detectClearBeforeCapture(
      run([req('https://auth.clickhouse.cloud/oauth/authorize', ['auth0=xyz; Path=/'])])
    )

    expect(clickhouse.value).toEqual(['auth0'])
  })

  it('flags a rotating session/CSRF cookie by value volatility (GitHub _gh_sess)', () => {
    const g = detectClearBeforeCapture(
      run([
        req('https://github.com/login/oauth/authorize?client_id=x&state=s1', ['_gh_sess=VALUE_ONE; Path=/; HttpOnly']),
        req('https://github.com/dashboard', ['_gh_sess=VALUE_TWO; Path=/; HttpOnly'])
      ])
    )

    expect(g.value).toEqual(['_gh_sess'])
    expect(g.evidence[0]).toContain('rotating session/CSRF cookie (2 distinct values)')
  })

  it('does NOT flag the durable session you replay — a stable, non-IdP session cookie', () => {
    // Baseten's Django `sessionid` (the replay cookie) is stable across the run, and GitHub's `user_session` is
    // the durable login token — neither should be flagged, or pasting the suggestion in would break reuse.
    const g = detectClearBeforeCapture(
      run([
        req('https://app.baseten.co/settings/billing', ['sessionid=STABLE; Path=/; HttpOnly']),
        req('https://app.baseten.co/graphql/', ['sessionid=STABLE; Path=/; HttpOnly']),
        req('https://github.com/dashboard', ['user_session=STABLE_TOKEN; Path=/; HttpOnly'])
      ])
    )

    expect(g.value).toEqual([])
    expect(g.confidence).toBe('low')
  })

  it('lowers confidence to medium when a flagged cookie was not seen on the auth leg', () => {
    const g = detectClearBeforeCapture(run([req('https://app.example.com/home', ['workos_session=z; Path=/'])]))

    expect(g.value).toEqual(['workos_session'])
    expect(g.confidence).toBe('medium')
  })

  it('returns an empty low guess when nothing is transient', () => {
    const g = detectClearBeforeCapture(run([req('https://api.example.com/v1', ['theme=dark; Path=/'])]))

    expect(g.value).toEqual([])
    expect(g.confidence).toBe('low')
  })
})

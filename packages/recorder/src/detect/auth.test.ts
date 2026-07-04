import { describe, expect, it } from 'vitest'

import type { RecordedRequest } from '../main/recording/types.js'

import { classifyAuth } from './auth.js'

const mk = (reqHeaders: Record<string, string>, over: Partial<RecordedRequest> = {}): RecordedRequest => ({
  index: 1,
  timestamp: '',
  type: 'XHR',
  request: { url: 'https://api.x.com/v1/me', method: 'GET', headers: reqHeaders, body: null, ...(over.request ?? {}) },
  response: {
    status: 200,
    headers: {},
    body: '',
    base64Encoded: false,
    mimeType: 'application/json',
    ...(over.response ?? {})
  },
  timing: { requestSentMs: 0, responseReceivedMs: 1 }
})

describe('classifyAuth', () => {
  it('cookie when requests carry only a Cookie header, no Authorization', () => {
    const g = classifyAuth([mk({ cookie: 'session=abc' })])

    expect(g.value).toBe('cookie')
  })

  it('bearer-token when a stable Authorization: Bearer is reused', () => {
    const g = classifyAuth([mk({ authorization: 'Bearer tok123' }), mk({ authorization: 'Bearer tok123' })])

    expect(g.value).toBe('bearer-token')
  })

  it('cookie-csrf when a CSRF header rides alongside the cookie', () => {
    const g = classifyAuth([mk({ cookie: 'session=abc', 'x-csrf-token': 'nonce42' })])

    expect(g.value).toBe('cookie-csrf')
  })

  it('minted-jwt when a Bearer JWT is issued by a distinct identity host seen in the trace', () => {
    // The api.upstash.com ⇄ clerk.upstash.com shape: the API Bearer is a JWT whose iss is the (separate)
    // Clerk host, which also serves requests in the run. No mint POST is captured (token predates the run).
    const payload = Buffer.from(JSON.stringify({ iss: 'https://clerk.x.com', exp: 9999999999 })).toString('base64url')
    const jwt = `h.${payload}.s`
    const apiCall = mk(
      { authorization: `Bearer ${jwt}` },
      {
        request: {
          url: 'https://api.x.com/v1/me',
          method: 'GET',
          headers: { authorization: `Bearer ${jwt}` },
          body: null
        }
      }
    )
    const idpCall = mk(
      {},
      { request: { url: 'https://clerk.x.com/v1/client', method: 'GET', headers: {}, body: null } }
    )

    const g = classifyAuth([idpCall, apiCall])

    expect(g.value).toBe('minted-jwt')
  })

  it('bearer-token (not minted) when a JWT is issued by the same host it is sent to', () => {
    const payload = Buffer.from(JSON.stringify({ iss: 'https://api.x.com', exp: 9999999999 })).toString('base64url')
    const jwt = `h.${payload}.s`
    const g = classifyAuth([mk({ authorization: `Bearer ${jwt}` }), mk({ authorization: `Bearer ${jwt}` })])

    expect(g.value).toBe('bearer-token')
  })

  it('minted-jwt when a token-mint POST precedes a short-exp Bearer', () => {
    const jwt = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.s`
    const mint = mk(
      { cookie: 'session=abc' },
      {
        request: { url: 'https://x.com/api/session', method: 'POST', headers: { cookie: 'session=abc' }, body: null },
        response: {
          status: 200,
          headers: {},
          body: JSON.stringify({ jwt }),
          base64Encoded: false,
          mimeType: 'application/json'
        }
      }
    )
    const use = mk({ authorization: `Bearer ${jwt}` })

    const g = classifyAuth([mint, use])

    expect(g.value).toBe('minted-jwt')
  })
})

import { describe, expect, it } from 'vitest'

import type { RecordedRequest } from '../main/recording/types.js'

import { classifyRender } from './render.js'

const mk = (url: string, mimeType: string, over: Partial<RecordedRequest['request']> = {}): RecordedRequest => ({
  index: 1,
  timestamp: '',
  type: 'XHR',
  request: { url, method: 'GET', headers: {}, body: null, ...over },
  response: { status: 200, headers: {}, body: '', base64Encoded: false, mimeType },
  timing: { requestSentMs: 0, responseReceivedMs: 1 }
})

describe('classifyRender', () => {
  it('detects GraphQL from a graphqlOperation', () => {
    const g = classifyRender([
      mk('https://api.x.com/graphql', 'application/json', { graphqlOperation: 'GetBilling', method: 'POST' })
    ])

    expect(g[0]).toMatchObject({ host: 'api.x.com', shape: 'graphql' })
  })

  it('detects tRPC from the /api/trpc path', () => {
    const g = classifyRender([mk('https://x.com/api/trpc/billing.get?batch=1', 'application/json')])

    expect(g[0].shape).toBe('trpc')
  })

  it('detects RSC flight from text/x-component', () => {
    const g = classifyRender([mk('https://x.com/dashboard', 'text/x-component')])

    expect(g[0].shape).toBe('rsc-flight')
  })

  it('falls back to json for a plain JSON API', () => {
    const g = classifyRender([mk('https://api.x.com/v1/me', 'application/json')])

    expect(g[0].shape).toBe('json')
  })
})

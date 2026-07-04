import { describe, expect, it } from 'vitest'

import { buildHarLog, toHarEntry } from './har.js'
import type { RecordedRequest } from './types.js'

function record(over: Partial<RecordedRequest> = {}): RecordedRequest {
  return {
    index: 1,
    timestamp: '2026-05-26T12:00:00.000Z',
    type: 'XHR',
    request: {
      url: 'https://api.example.com/v2/users?page=2',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"a"}'
    },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
      mimeType: 'application/json',
      base64Encoded: false,
      protocol: 'h2',
      bodyBytes: 11
    },
    timing: { requestSentMs: 1000, responseReceivedMs: 1080 },
    ...over
  }
}

describe('toHarEntry', () => {
  it('maps a record to a HAR 1.2 entry', () => {
    const e = toHarEntry(record()) as any

    expect(e.request.method).toBe('POST')
    expect(e.request.url).toBe('https://api.example.com/v2/users?page=2')
    expect(e.request.httpVersion).toBe('HTTP/2.0')
    expect(e.request.queryString).toEqual([{ name: 'page', value: '2' }])
    expect(e.request.headers).toContainEqual({ name: 'content-type', value: 'application/json' })
    expect(e.request.postData).toEqual({ mimeType: 'application/json', text: '{"name":"a"}' })
    expect(e.response.status).toBe(200)
    expect(e.response.content).toMatchObject({
      mimeType: 'application/json',
      text: '{"ok":true}',
      size: 11
    })
    expect(e.time).toBe(80)
  })

  it('marks base64 bodies with an encoding', () => {
    const e = toHarEntry(record({ response: { ...record().response, body: 'AAAA', base64Encoded: true } })) as any

    expect(e.response.content.encoding).toBe('base64')
  })

  it('prefers wire headers when present', () => {
    const e = toHarEntry(
      record({
        request: {
          ...record().request,
          wireHeaders: { authorization: 'Bearer xyz', 'content-type': 'application/json' }
        }
      })
    ) as any

    expect(e.request.headers).toContainEqual({ name: 'authorization', value: 'Bearer xyz' })
  })
})

describe('buildHarLog', () => {
  it('wraps entries in a HAR 1.2 log sorted by index', () => {
    const log = buildHarLog([record({ index: 2 }), record({ index: 1 })]) as any

    expect(log.log.version).toBe('1.2')
    expect(log.log.creator.name).toBe('Butin Recorder')
    expect(log.log.entries).toHaveLength(2)
  })
})

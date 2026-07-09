import { describe, expect, it } from 'vitest'

import { shouldStreamResponse } from './streaming.js'

describe('shouldStreamResponse', () => {
  it('streams Server-Sent Events by mime, even with a length', () => {
    expect(shouldStreamResponse('Fetch', 'text/event-stream', { 'content-length': '10' })).toBe(true)
  })

  it('streams the EventSource resource type', () => {
    expect(shouldStreamResponse('EventSource', 'text/plain', {})).toBe(true)
  })

  it('streams a Firestore Listen channel (data fetch, text/plain, no content-length)', () => {
    expect(shouldStreamResponse('Fetch', 'text/plain; charset=utf-8', { 'x-content-type-options': 'nosniff' })).toBe(
      true
    )
  })

  it('streams a chunked XHR regardless of header casing', () => {
    expect(shouldStreamResponse('XHR', 'application/grpc-web+proto', { 'Transfer-Encoding': 'chunked' })).toBe(true)
  })

  it('keeps the single-shot path for a finite JSON response', () => {
    expect(shouldStreamResponse('Fetch', 'application/json', { 'content-length': '3400' })).toBe(false)
  })

  it('keeps the single-shot path when Content-Length casing varies', () => {
    expect(shouldStreamResponse('XHR', 'application/json', { 'Content-Length': '12' })).toBe(false)
  })

  it('does not stream non-fetch resource types', () => {
    expect(shouldStreamResponse('Document', 'text/html', {})).toBe(false)
    expect(shouldStreamResponse('Image', 'image/png', {})).toBe(false)
    expect(shouldStreamResponse('Script', 'application/javascript', {})).toBe(false)
  })
})

import { describe, expect, test } from 'vitest'

import { encodeBody } from './body.js'

describe('encodeBody', () => {
  test('no body encodes to nothing', () => {
    expect(encodeBody(undefined)).toEqual({ isJson: false })
  })

  test('a string is its own body and is never assumed to be JSON', () => {
    expect(encodeBody('a=1&b=2')).toEqual({ data: 'a=1&b=2', isJson: false, cacheKey: 'a=1&b=2' })
  })

  test('a plain object encodes as a JSON document', () => {
    const { data, isJson } = encodeBody({ query: '{ me }' })

    expect(data).toBe('{"query":"{ me }"}')
    expect(isJson).toBe(true)
  })

  // The regression: a Buffer is `typeof 'object'`, so encoding it as JSON sent `{"type":"Buffer","data":[…]}`
  // to endpoints expecting raw bytes (a gRPC-Web frame), which answer with an undecodable body rather than an
  // error — surfacing as empty data instead of a thrown request.
  test('a Buffer goes out verbatim and is not JSON', () => {
    const frame = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x02, 0x08, 0x96])
    const { data, isJson } = encodeBody(frame)

    expect(Buffer.isBuffer(data)).toBe(true)
    expect(data).toEqual(frame)
    expect(isJson).toBe(false)
  })

  test('a Uint8Array view sends only its own bytes', () => {
    const view = new Uint8Array([1, 2, 3, 4, 5, 6]).subarray(2, 5)
    const { data, isJson } = encodeBody(view)

    expect(data).toEqual(Buffer.from([3, 4, 5]))
    expect(isJson).toBe(false)
  })

  test('an ArrayBuffer goes out verbatim', () => {
    const { data, isJson } = encodeBody(Uint8Array.from([9, 8, 7]).buffer)

    expect(data).toEqual(Buffer.from([9, 8, 7]))
    expect(isJson).toBe(false)
  })

  test('binary bodies key the cache by content, so two frames never collide', () => {
    const a = encodeBody(Buffer.from([1, 2, 3]))
    const b = encodeBody(Buffer.from([1, 2, 4]))

    expect(a.cacheKey).toBeDefined()
    expect(a.cacheKey).not.toBe(b.cacheKey)
  })
})

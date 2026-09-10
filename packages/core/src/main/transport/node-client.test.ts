import type { ButinResponse } from '@butinapp/sdk'
import { afterEach, expect, test, vi } from 'vitest'

import { clearLogs, getRecentLogs } from '../log.js'
import type { AuthResolver } from '../plugin/auth-resolve.js'

import { createNodeClient } from './node-client.js'
import { clearRequestCache, getRequestCache } from './request-cache.js'

const auth: AuthResolver = async () => ({ cookie: 'sessionKey=abc', headers: { 'X-Org': 'o1' } })

test('get merges auth cookie + headers and returns data', async () => {
  const request = vi.fn(async () => ({ status: 200, headers: {}, data: { ok: true } }))
  const client = createNodeClient({ engine: 'node' }, auth, request)

  const data = await client.get<{ ok: boolean }>('https://api.test/x')

  expect(data).toEqual({ ok: true })
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      method: 'GET',
      url: 'https://api.test/x',
      headers: expect.objectContaining({ Cookie: 'sessionKey=abc', 'X-Org': 'o1' })
    })
  )
})

test('a >= 400 status throws with the status', async () => {
  const request = vi.fn(async () => ({ status: 403, headers: {}, data: 'nope' }))
  const client = createNodeClient({ engine: 'node' }, auth, request)

  await expect(client.get('https://api.test/x')).rejects.toThrow(/403/)
})

test('sendAuth:false drops the resolved auth headers but keeps the cookie (cookie-only host)', async () => {
  let sent: Record<string, string> = {}
  const request = vi.fn(async (req: { headers: Record<string, string> }) => {
    sent = req.headers

    return { status: 200, headers: {}, data: { ok: true } }
  })
  const client = createNodeClient({ engine: 'node' }, auth, request)

  await client.request({ url: 'https://legacy.test/x', sendAuth: false })

  // cookie still goes (cookie-auth), but the resolved auth header (X-Org) is suppressed
  expect(sent).toEqual(expect.objectContaining({ Cookie: 'sessionKey=abc' }))
  expect(sent['X-Org']).toBeUndefined()
})

test('sendCookie:false drops the captured cookie on a single cross-origin call', async () => {
  let sent: Record<string, string> = {}
  const request = vi.fn(async (req: { headers: Record<string, string> }) => {
    sent = req.headers

    return { status: 200, headers: {}, data: { ok: true } }
  })
  const client = createNodeClient({ engine: 'node' }, auth, request)

  await client.request({ url: 'https://stripe.test/x', sendCookie: false })

  expect(sent['Cookie']).toBeUndefined()
})

test('a per-call timeout passes through to the underlying request', async () => {
  const request = vi.fn(async () => ({ status: 200, headers: {}, data: { ok: true } }))
  const client = createNodeClient({ engine: 'node' }, auth, request)

  await client.request({ url: 'https://api.test/slow', timeout: 120_000 })

  expect(request).toHaveBeenCalledWith(expect.objectContaining({ timeout: 120_000 }))
})

test('a request that throws on the wire (timeout/network) logs a net warn, then rethrows', async () => {
  clearLogs()
  const request = vi.fn(async () => {
    throw new Error('timeout of 60000ms exceeded')
  })
  const client = createNodeClient({ engine: 'node' }, auth, request, undefined, 'fake')

  await expect(client.get('https://api.test/x')).rejects.toThrow(/timeout of 60000ms/)

  const warn = getRecentLogs().find((e) => e.scope === 'net' && e.plugin === 'fake' && e.level === 'warn')

  expect(warn?.message).toContain('timeout of 60000ms exceeded')
})

test('maxRedirects passes through and a returned 3xx is delivered (not thrown)', async () => {
  const request = vi.fn(async () => ({ status: 302, headers: { location: 'https://elsewhere.test/p' }, data: '' }))
  const client = createNodeClient({ engine: 'node' }, auth, request)

  const res = await client.request({ url: 'https://api.test/redirect', maxRedirects: 0 })

  expect(res.status).toBe(302)
  expect(res.headers.location).toBe('https://elsewhere.test/p')
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ maxRedirects: 0 }))
})

const resolver = async (): Promise<{ headers: Record<string, string>; cookie: string }> => ({ headers: {}, cookie: '' })
const ok = (data: unknown): ButinResponse => ({ status: 200, headers: {}, data })

afterEach(() => clearRequestCache('test'))

test('GET/POST reads dedupe through the cache; cache:false and arraybuffer skip it', async () => {
  const raw = vi.fn(async () => ok({ v: 1 }))
  const cache = getRequestCache('test', 12_000)
  const client = createNodeClient({}, resolver, raw, cache)

  await client.get('https://x/a')
  await client.get('https://x/a') // same key → cached
  expect(raw).toHaveBeenCalledTimes(1)

  await client.get('https://x/a', undefined) // still cached
  await client.request({ url: 'https://x/a', cache: false }) // explicit skip → network
  expect(raw).toHaveBeenCalledTimes(2)

  await client.request({ url: 'https://x/bin', responseType: 'arraybuffer' })
  await client.request({ url: 'https://x/bin', responseType: 'arraybuffer' }) // never cached
  expect(raw).toHaveBeenCalledTimes(4)
})

test('without a cache, every read hits the network', async () => {
  const raw = vi.fn(async () => ok({ v: 1 }))
  const client = createNodeClient({}, resolver, raw) // no cache arg → base/auth client behaviour

  await client.get('https://x/a')
  await client.get('https://x/a')
  expect(raw).toHaveBeenCalledTimes(2)
})

// A binary body reaches the wire byte-for-byte and keeps the plugin's own content type: JSON-encoding it
// would send `{"type":"Buffer","data":[…]}`, which a binary endpoint answers with an undecodable body.
test('a binary body is sent verbatim, without a JSON content type', async () => {
  let sent: { body?: unknown; headers: Record<string, string> } | undefined
  const raw = vi.fn(async (req: { body?: unknown; headers: Record<string, string> }) => {
    sent = req

    return ok({ v: 1 })
  })
  const client = createNodeClient({}, resolver, raw)
  const frame = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x02, 0x08, 0x96])

  await client.request({
    url: 'https://x/grpc',
    method: 'POST',
    body: frame,
    headers: { 'content-type': 'application/grpc-web+proto' }
  })

  expect(sent?.body).toEqual(frame)
  expect(sent?.headers['Content-Type']).toBeUndefined()
  expect(sent?.headers['content-type']).toBe('application/grpc-web+proto')
})

test('a JSON body does not add a second content-type when the caller already declared one, any casing', () => {
  // Header names are case-insensitive on the wire, so a plugin that writes `content-type` must not also get the
  // canonical `Content-Type` default — that put the header on the request twice.
  const seen: Record<string, string>[] = []
  const raw = vi.fn(async (req: { headers: Record<string, string> }) => {
    seen.push(req.headers)

    return ok({ v: 1 })
  })
  const client = createNodeClient({}, resolver, raw)

  return Promise.all([
    client.post('https://x/rpc', { a: 1 }, { 'content-type': 'application/json' }),
    client.post('https://x/other', { a: 1 })
  ]).then(() => {
    const declared = seen[0] as Record<string, string>
    const defaulted = seen[1] as Record<string, string>

    expect(Object.keys(declared).filter((k) => k.toLowerCase() === 'content-type')).toEqual(['content-type'])
    // With none declared, the canonical default still applies.
    expect(defaulted['Content-Type']).toBe('application/json')
  })
})

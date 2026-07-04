import type { ButinResponse } from '@butinapp/sdk'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { clearRequestCache, getRequestCache } from './request-cache.js'

const ok = (data: unknown): ButinResponse => ({ status: 200, headers: {}, data })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  clearRequestCache('p')
  clearRequestCache('q')
})

test('in-flight identical requests share one fetch', async () => {
  const cache = getRequestCache('p', 12_000)
  const fetch = vi.fn(async () => ok(1))

  const [a, b] = await Promise.all([
    cache.run('POST', 'https://x/gql', '{"op":"A"}', undefined, fetch),
    cache.run('POST', 'https://x/gql', '{"op":"A"}', undefined, fetch)
  ])

  expect(fetch).toHaveBeenCalledTimes(1)
  expect(a.data).toBe(1)
  expect(b.data).toBe(1)
})

test('a fresh result is reused within the TTL, refetched after it', async () => {
  const cache = getRequestCache('p', 12_000)
  const fetch = vi.fn(async () => ok(Math.random()))

  const first = await cache.run('GET', 'https://x/a', undefined, undefined, fetch)

  vi.advanceTimersByTime(5_000)
  const second = await cache.run('GET', 'https://x/a', undefined, undefined, fetch)

  expect(fetch).toHaveBeenCalledTimes(1) // within TTL → cached
  expect(second.data).toBe(first.data)

  vi.advanceTimersByTime(12_001) // past TTL (measured from completion)
  await cache.run('GET', 'https://x/a', undefined, undefined, fetch)
  expect(fetch).toHaveBeenCalledTimes(2)
})

test('different body → different key → separate fetch', async () => {
  const cache = getRequestCache('p', 12_000)
  const fetch = vi.fn(async () => ok(1))

  await cache.run('POST', 'https://x/gql', '{"op":"A"}', undefined, fetch)
  await cache.run('POST', 'https://x/gql', '{"op":"B"}', undefined, fetch)
  expect(fetch).toHaveBeenCalledTimes(2)
})

// Two requests to the SAME url/body that differ only by a discriminating header (e.g. an org-scoping header)
// must NOT collide — otherwise the second org gets the first org's cached response.
test('different discriminating header → different key → separate fetch', async () => {
  const cache = getRequestCache('p', 12_000)
  const fetch = vi.fn(async () => ok(Math.random()))

  const a = await cache.run('GET', 'https://x/billing', undefined, { 'openai-organization': 'org-A' }, fetch)
  const b = await cache.run('GET', 'https://x/billing', undefined, { 'openai-organization': 'org-B' }, fetch)

  expect(fetch).toHaveBeenCalledTimes(2)
  expect(b.data).not.toBe(a.data)

  // Same header again → cached (header order/case is irrelevant to the key).
  await cache.run('GET', 'https://x/billing', undefined, { 'Openai-Organization': 'org-A' }, fetch)
  expect(fetch).toHaveBeenCalledTimes(2)
})

test('a rejected fetch is evicted (errors are not cached)', async () => {
  const cache = getRequestCache('p', 12_000)
  const fetch = vi.fn(async () => {
    throw new Error('boom')
  })

  await expect(cache.run('GET', 'https://x/a', undefined, undefined, fetch)).rejects.toThrow('boom')
  await expect(cache.run('GET', 'https://x/a', undefined, undefined, fetch)).rejects.toThrow('boom')
  expect(fetch).toHaveBeenCalledTimes(2) // not memoized
})

test('namespaces are isolated; clearRequestCache drops a plugin + its backends', async () => {
  const p = getRequestCache('p', 12_000)
  const pb = getRequestCache('p::api', 12_000)
  const q = getRequestCache('q', 12_000)
  const fp = vi.fn(async () => ok(1))
  const fpb = vi.fn(async () => ok(1))
  const fq = vi.fn(async () => ok(1))

  await p.run('GET', 'https://x/a', undefined, undefined, fp)
  await pb.run('GET', 'https://x/a', undefined, undefined, fpb)
  await q.run('GET', 'https://x/a', undefined, undefined, fq)

  clearRequestCache('p') // drops 'p' and 'p::api', leaves 'q'

  await p.run('GET', 'https://x/a', undefined, undefined, fp)
  await pb.run('GET', 'https://x/a', undefined, undefined, fpb)
  await q.run('GET', 'https://x/a', undefined, undefined, fq)

  expect(fp).toHaveBeenCalledTimes(2)
  expect(fpb).toHaveBeenCalledTimes(2)
  expect(fq).toHaveBeenCalledTimes(1) // 'q' untouched → still cached
})

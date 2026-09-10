import type { ButinResponse } from '@butinapp/sdk'

import { logCachedRequest } from './log.js'

// A module-level, per-plugin-namespace read cache shared by EVERY capability run. It dedupes identical reads:
// concurrent calls share one in-flight promise; a settled result is reused for `ttlMs` measured FROM COMPLETION
// (so an 8s query is still reused back-to-back). The window comfortably spans a refresh-all batch — where the
// request pacer trickles dispatches 100–500ms apart, so back-to-back capabilities still hit the same endpoint
// within the TTL. A rejected fetch is evicted immediately — errors are never cached. INVARIANT: callers
// receive a shared, read-only ButinResponse on a hit; collectors only read `.data`.
export const QUERY_CACHE_TTL_MS = 30_000

type Entry = {
  at: number // ms timestamp; set at fetch start, refreshed to completion time when the promise settles
  promise: Promise<ButinResponse>
}

export type RequestCache = {
  run: (
    method: string,
    url: string,
    body: string | undefined,
    headers: Record<string, string> | undefined,
    fetch: () => Promise<ButinResponse>
  ) => Promise<ButinResponse>
}

const registry = new Map<string, Map<string, Entry>>()

// A deterministic key fragment for the caller-supplied per-call headers (e.g. `openai-organization`), so two
// requests to the SAME url/body that differ only by such a header don't collide on one cache entry. Sorted so
// key order is irrelevant; header names lowercased since HTTP treats them case-insensitively.
const headerKey = (headers: Record<string, string> | undefined): string =>
  headers
    ? Object.entries(headers)
        .map(([k, v]) => `${k.toLowerCase()}:${v}`)
        .sort()
        .join('|')
    : ''

const bucket = (namespace: string): Map<string, Entry> => {
  const existing = registry.get(namespace)

  if (existing) {
    return existing
  }

  const created = new Map<string, Entry>()

  registry.set(namespace, created)

  return created
}

export const getRequestCache = (namespace: string, ttlMs: number = QUERY_CACHE_TTL_MS): RequestCache => {
  return {
    run: (method, url, body, headers, fetch) => {
      // Look up the bucket on each call so clearRequestCache eviction is immediately visible — a closure
      // captured at getRequestCache() time would still point to the old (deleted) map.
      const cache = bucket(namespace)
      const key = `${method} ${url}\n${body ?? ''}\n${headerKey(headers)}`
      const hit = cache.get(key)

      if (hit && Date.now() - hit.at < ttlMs) {
        logCachedRequest(method, url, Date.now() - hit.at, namespace.split('::')[0])

        return hit.promise
      }

      const promise = fetch()
      const entry: Entry = { at: Date.now(), promise }

      cache.set(key, entry)
      void promise.then(
        () => {
          if (cache.get(key) === entry) {
            entry.at = Date.now() // measure the TTL from when the data actually landed
          }
        },
        () => {
          if (cache.get(key) === entry) {
            cache.delete(key) // never cache a failure
          }
        }
      )

      return promise
    }
  }
}

// Drop a plugin's cache: its primary namespace (`pluginId`) and every backend (`pluginId::<backend>`). Called
// on an explicit refresh (batch boundary) and on disconnect/uninstall.
export const clearRequestCache = (pluginId: string): void => {
  for (const namespace of registry.keys()) {
    if (namespace === pluginId || namespace.startsWith(`${pluginId}::`)) {
      registry.delete(namespace)
    }
  }
}

import { BROWSER_UA, SEC_CH_UA_HEADERS } from '@butinapp/engine'
import type { ButinClient, ButinResponse, RequestOptions, TransportConfig } from '@butinapp/sdk'
import axios from 'axios'

import type { AuthResolver } from '../plugin/auth-resolve.js'

import { encodeBody } from './body.js'
import { REQUEST_TIMEOUT_MS } from './constants.js'
import { graphqlOver } from './graphql.js'
import { logPacedRequest, logRequest, logRequestError } from './log.js'
import type { RequestCache } from './request-cache.js'
import { isStaticAsset, paceRequest } from './request-pacer.js'

// The provider key a request paces against — its host, so a plugin's secondary backends pace independently.
const pacingKey = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// Low-level request fn, injectable for tests. Production passes the axios-backed one below.
export type RawRequest = (opts: {
  method: string
  url: string
  headers: Record<string, string>
  data?: unknown
  responseType?: 'json' | 'text' | 'arraybuffer'
  maxRedirects?: number
  timeout?: number
}) => Promise<ButinResponse>

const axiosRequest: RawRequest = async (opts) => {
  const res = await axios.request({
    method: opts.method,
    url: opts.url,
    headers: opts.headers,
    data: opts.data,
    timeout: opts.timeout ?? REQUEST_TIMEOUT_MS,
    responseType: opts.responseType === 'arraybuffer' ? 'arraybuffer' : opts.responseType === 'text' ? 'text' : 'json',
    // Leave axios's redirect-following at its default unless a caller caps it (0 to capture a Location).
    ...(opts.maxRedirects !== undefined ? { maxRedirects: opts.maxRedirects } : {}),
    validateStatus: () => true
  })

  return { status: res.status, headers: res.headers as Record<string, string>, data: res.data }
}

export const createNodeClient = (
  transport: TransportConfig,
  resolveAuth: AuthResolver,
  rawRequest: RawRequest = axiosRequest,
  cache?: RequestCache,
  logTag?: string
): ButinClient => {
  const request = async <T>(opts: RequestOptions): Promise<ButinResponse<T>> => {
    const url = transport.baseUrl && !opts.url.startsWith('http') ? `${transport.baseUrl}${opts.url}` : opts.url
    const method = opts.method ?? 'GET'
    const { data: body, isJson, cacheKey } = encodeBody(opts.body)

    const doFetch = async (): Promise<ButinResponse> => {
      const auth = await resolveAuth()
      const headers: Record<string, string> = {
        ...(transport.defaultHeaders ?? {}),
        // Inject the canonical browser fingerprint centrally so node-transport plugins don't hand-copy
        // sec-ch-ua + a hardcoded UA — and so the advertised Chromium version always tracks the real engine
        // instead of drifting from the capture window.
        ...SEC_CH_UA_HEADERS,
        'User-Agent': transport.userAgent ?? BROWSER_UA,
        ...(opts.sendAuth === false ? {} : (auth.headers ?? {})),
        ...(auth.cookie && transport.sendCookie !== false && opts.sendCookie !== false ? { Cookie: auth.cookie } : {}),
        ...(opts.referer ? { Referer: opts.referer } : {}),
        ...(opts.headers ?? {})
      }

      if (isJson) {
        headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
      }

      const t0 = Date.now()
      let res: ButinResponse

      try {
        res = await rawRequest({
          method,
          url,
          headers,
          data: body,
          responseType: opts.responseType,
          maxRedirects: opts.maxRedirects,
          timeout: opts.timeout
        })
      } catch (err) {
        logRequestError(method, url, Date.now() - t0, logTag, err)
        throw err
      }

      logRequest(method, url, res.status, Date.now() - t0, logTag, res.data, headers)

      if (res.status >= 400) {
        throw Object.assign(new Error(`HTTP ${res.status} ${opts.method ?? 'GET'} ${url}`), { status: res.status })
      }

      return res
    }

    // Pace the real fetch, not cache hits: cache.run() invokes its fn only on a miss, so wrapping doFetch
    // means a dedup hit returns instantly while a genuine network call is gap-spaced per host.
    const pacedFetch = (): Promise<ButinResponse> =>
      paceRequest(pacingKey(url), doFetch, (ms) => logPacedRequest(method, url, ms, logTag))
    // pace:false runs un-spaced (the collector owns its own concurrency); static assets are never paced (see
    // isStaticAsset); everything else is gap-spaced per host.
    const runFetch = opts.pace === false || isStaticAsset(url) ? doFetch : pacedFetch
    const cacheable =
      cache && opts.cache !== false && opts.responseType !== 'arraybuffer' && (method === 'GET' || method === 'POST')
    const res = cacheable ? await cache.run(method, url, cacheKey, opts.headers, runFetch) : await runFetch()

    return res as ButinResponse<T>
  }

  return {
    request,
    get: async <T = unknown>(url: string, headers?: Record<string, string>): Promise<T> =>
      (await request<T>({ url, headers })).data,
    post: async <T = unknown>(url: string, body?: unknown, headers?: Record<string, string>): Promise<T> =>
      (await request<T>({ url, method: 'POST', body, headers })).data,
    graphql: graphqlOver(request),
    getText: async (url: string, headers?: Record<string, string>): Promise<string> =>
      (await request<string>({ url, headers, responseType: 'text' })).data
  }
}

import { BROWSER_UA, SEC_CH_UA_HEADERS } from '@butinapp/engine'
import type { ButinClient, ButinResponse, RequestOptions, TransportConfig } from '@butinapp/sdk'

import type { AuthResolver } from '../plugin/auth-resolve.js'

import { encodeBody } from './body.js'
import { graphqlOver } from './graphql.js'
import { logPacedRequest, logRequest, logRequestError } from './log.js'
import type { RequestCache } from './request-cache.js'
import { isStaticAsset, paceRequest } from './request-pacer.js'

// Everything a request does either side of the wire call — url join, auth + identity headers, pacing, caching,
// logging, the status throw — with the wire call itself injected. A transport supplies only what is genuinely
// its own: how bytes go out, and (where its raw call doesn't) how the body comes back.

// The transport-specific wire call. Returns the response with `data` in whatever form that transport produces:
// already-parsed for a client that honours `responseType`, raw bytes for one that doesn't (see `decode`).
export type RawSend = (req: {
  method: string
  url: string
  headers: Record<string, string>
  body?: string | Buffer
  responseType?: RequestOptions['responseType']
  maxRedirects?: number
  timeout?: number
}) => Promise<ButinResponse>

// The header names a transport writes for the values applied centrally. HTTP header names are case-insensitive,
// but a transport sends them verbatim, so each keeps the casing it has always put on the wire.
export type HeaderNames = { userAgent: string; cookie: string; referer: string; contentType: string }

export type HttpClientOptions = {
  cache?: RequestCache
  logTag?: string
  headerNames: HeaderNames
  // Turn a raw response body into the shape the caller asked for. Runs only AFTER the status check, so an error
  // response is never parsed — a 404 that answers with an HTML page must surface as `HTTP 404`, not a JSON
  // SyntaxError. Omitted when the transport's own client already decoded.
  decode?: (raw: unknown, responseType: RequestOptions['responseType']) => unknown
}

// The provider key a request paces against — its host, so a plugin's secondary backends pace independently.
const pacingKey = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// Whether any casing of `name` is already present. Header names are case-insensitive, so a plugin that declares
// `content-type` must not also receive a `Content-Type` default — that puts the header on the wire twice.
const hasHeader = (headers: Record<string, string>, name: string): boolean => {
  const lower = name.toLowerCase()

  return Object.keys(headers).some((k) => k.toLowerCase() === lower)
}

export const createHttpClient = (
  transport: TransportConfig,
  resolveAuth: AuthResolver,
  send: RawSend,
  opts: HttpClientOptions
): ButinClient => {
  const { cache, logTag, headerNames: name, decode } = opts

  const request = async <T>(reqOpts: RequestOptions): Promise<ButinResponse<T>> => {
    const url =
      transport.baseUrl && !reqOpts.url.startsWith('http') ? `${transport.baseUrl}${reqOpts.url}` : reqOpts.url
    const method = reqOpts.method ?? 'GET'
    const { data: body, isJson, cacheKey } = encodeBody(reqOpts.body)

    const doFetch = async (): Promise<ButinResponse> => {
      const auth = await resolveAuth()
      const headers: Record<string, string> = {
        ...(transport.defaultHeaders ?? {}),
        // Inject the canonical browser fingerprint centrally so plugins don't hand-copy sec-ch-ua + a hardcoded
        // UA — and so the advertised Chromium version always tracks the real engine instead of drifting from the
        // capture window. The UA must match the capture window's: cf_clearance is bound to (IP, UA, TLS identity).
        ...SEC_CH_UA_HEADERS,
        [name.userAgent]: transport.userAgent ?? BROWSER_UA,
        ...(reqOpts.sendAuth === false ? {} : (auth.headers ?? {})),
        ...(auth.cookie && transport.sendCookie !== false && reqOpts.sendCookie !== false
          ? { [name.cookie]: auth.cookie }
          : {}),
        ...(reqOpts.referer ? { [name.referer]: reqOpts.referer } : {}),
        ...(reqOpts.headers ?? {})
      }

      if (isJson && !hasHeader(headers, name.contentType)) {
        headers[name.contentType] = 'application/json'
      }

      const t0 = Date.now()
      let res: ButinResponse

      try {
        res = await send({
          method,
          url,
          headers,
          body,
          responseType: reqOpts.responseType,
          maxRedirects: reqOpts.maxRedirects,
          timeout: reqOpts.timeout
        })
      } catch (err) {
        logRequestError(method, url, Date.now() - t0, logTag, err)
        throw err
      }

      logRequest(method, url, res.status, Date.now() - t0, logTag, res.data, headers)

      if (res.status >= 400) {
        throw Object.assign(new Error(`HTTP ${res.status} ${method} ${url}`), { status: res.status })
      }

      return decode ? { ...res, data: decode(res.data, reqOpts.responseType) } : res
    }

    // Pace the real fetch, not cache hits: cache.run() invokes its fn only on a miss, so wrapping doFetch
    // means a dedup hit returns instantly while a genuine network call is gap-spaced per host.
    const pacedFetch = (): Promise<ButinResponse> =>
      paceRequest(pacingKey(url), doFetch, (ms) => logPacedRequest(method, url, ms, logTag))
    // pace:false runs un-spaced (the collector owns its own concurrency); static assets are never paced (see
    // isStaticAsset); everything else is gap-spaced per host.
    const runFetch = reqOpts.pace === false || isStaticAsset(url) ? doFetch : pacedFetch
    const cacheable =
      cache &&
      reqOpts.cache !== false &&
      reqOpts.responseType !== 'arraybuffer' &&
      (method === 'GET' || method === 'POST')
    const res = cacheable ? await cache.run(method, url, cacheKey, reqOpts.headers, runFetch) : await runFetch()

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

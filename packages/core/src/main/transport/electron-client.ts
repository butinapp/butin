import { BROWSER_UA, SEC_CH_UA_HEADERS } from '@butinapp/engine'
import type { ButinClient, ButinResponse, RequestOptions, TransportConfig } from '@butinapp/sdk'
import { net, type Session } from 'electron'

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

// Collapse net.request's `string | string[]` response-header value to a single string (first entry of a
// repeated header).
const normalizeHeaderValue = (v: string | string[]): string => (Array.isArray(v) ? (v[0] ?? '') : String(v))

const collect = (opts: {
  method: string
  url: string
  headers: Record<string, string>
  body?: string | Buffer
  session?: Session
  maxRedirects?: number
  timeout?: number
}): Promise<ButinResponse> =>
  new Promise((resolve, reject) => {
    const timeoutMs = opts.timeout ?? REQUEST_TIMEOUT_MS
    // maxRedirects:0 means capture the 3xx instead of chasing it: ask net.request to surface the redirect so
    // the collector can read its Location (a one-time cross-origin portal handoff it must walk itself).
    const manualRedirect = opts.maxRedirects === 0
    // Bind the request to the plugin's (profile's) partition session so it reuses the SAME cookie jar the
    // capture/offscreen-boot wrote to — including HttpOnly + promote-on-quit cookies (cf_clearance, legacy
    // SSO). Without this it falls to Electron's global default session, which holds none of the captured
    // cookies.
    const request = net.request({
      method: opts.method,
      url: opts.url,
      session: opts.session,
      redirect: manualRedirect ? 'manual' : 'follow'
    })
    let settled = false

    const timer = setTimeout(() => {
      if (settled) {
        return
      }

      settled = true
      request.abort()
      reject(new Error(`Request timed out after ${timeoutMs / 1000}s: ${opts.method} ${opts.url}`))
    }, timeoutMs)

    const fail = (err: Error): void => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      reject(err)
    }

    for (const [k, v] of Object.entries(opts.headers)) {
      request.setHeader(k, v)
    }

    // In manual mode, capture the 3xx from the 'redirect' event (its headers carry Location) and stop, instead
    // of chasing it — a one-time cross-origin portal handoff the collector must walk itself. The handler is
    // registered ONLY for manual mode: Electron cancels a request whose 'redirect' listener doesn't call
    // followRedirect() synchronously, so attaching it in follow mode would break the automatic redirect chase
    // (every 3xx would abort with an empty body). With no listener, follow mode chases the redirect to its final
    // response on its own.
    if (manualRedirect) {
      request.on('redirect', (statusCode, _method, redirectUrl, responseHeaders) => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(timer)
        request.abort()
        const headers = Object.fromEntries(
          Object.entries(responseHeaders).map(([k, v]) => [k, normalizeHeaderValue(v)])
        )

        headers.location = headers.location ?? redirectUrl
        resolve({ status: statusCode, headers, data: Buffer.alloc(0) })
      })
    }

    request.on('response', (response) => {
      const chunks: Buffer[] = []

      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(timer)
        // Keep the raw Buffer — the caller decodes per responseType. Stringifying here corrupts binary
        // bodies (e.g. imaging report PDFs).
        const status = response.statusCode
        const headers = Object.fromEntries(
          Object.entries(response.headers).map(([k, v]) => [k, normalizeHeaderValue(v)])
        )

        resolve({ status, headers, data: Buffer.concat(chunks) })
      })
      response.on('error', fail)
    })
    request.on('error', fail)

    if (opts.body !== undefined) {
      request.write(opts.body)
    }

    request.end()
  })

export const createElectronClient = (
  transport: TransportConfig,
  resolveAuth: AuthResolver,
  session?: Session,
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
        ...SEC_CH_UA_HEADERS,
        // The UA must match the capture window's UA — cf_clearance is bound to (IP, UA, TLS identity). Default to
        // the canonical Butin browser identity so capture and replay always agree.
        'user-agent': transport.userAgent ?? BROWSER_UA,
        ...(opts.sendAuth === false ? {} : (auth.headers ?? {})),
        ...(auth.cookie && transport.sendCookie !== false && opts.sendCookie !== false ? { cookie: auth.cookie } : {}),
        ...(opts.referer ? { referer: opts.referer } : {}),
        ...(opts.headers ?? {})
      }

      if (isJson) {
        headers['content-type'] = headers['content-type'] ?? 'application/json'
      }

      const t0 = Date.now()
      let res: ButinResponse

      try {
        res = await collect({
          method,
          url,
          headers,
          body,
          session,
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

      const raw = res.data as Buffer
      let data: unknown

      if (opts.responseType === 'arraybuffer') {
        // A standalone ArrayBuffer copy of just this body's bytes (not the pooled Buffer's backing store).
        data = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
      } else {
        const text = raw.toString('utf8')

        data = opts.responseType === 'text' || !text ? text : JSON.parse(text)
      }

      return { status: res.status, headers: res.headers, data: data as unknown }
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

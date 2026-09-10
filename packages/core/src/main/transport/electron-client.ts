import type { ButinClient, ButinResponse, RequestOptions, TransportConfig } from '@butinapp/sdk'
import { net, type Session } from 'electron'

import type { AuthResolver } from '../plugin/auth-resolve.js'

import { REQUEST_TIMEOUT_MS } from './constants.js'
import { createHttpClient } from './http-client.js'
import type { RequestCache } from './request-cache.js'

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

// net.request hands back raw bytes whatever was asked for, so the body is decoded here. Runs only after the
// shared client's status check, so an error page is never parsed.
const decodeBody = (raw: unknown, responseType: RequestOptions['responseType']): unknown => {
  const buffer = raw as Buffer

  if (responseType === 'arraybuffer') {
    // A standalone ArrayBuffer copy of just this body's bytes (not the pooled Buffer's backing store).
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  }

  const text = buffer.toString('utf8')

  return responseType === 'text' || !text ? text : JSON.parse(text)
}

export const createElectronClient = (
  transport: TransportConfig,
  resolveAuth: AuthResolver,
  session?: Session,
  cache?: RequestCache,
  logTag?: string
): ButinClient =>
  createHttpClient(transport, resolveAuth, (req) => collect({ ...req, session }), {
    cache,
    logTag,
    decode: decodeBody,
    // net.request lowercases on the wire; these are the names this transport has always written.
    headerNames: { userAgent: 'user-agent', cookie: 'cookie', referer: 'referer', contentType: 'content-type' }
  })

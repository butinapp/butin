import type { ButinClient, ButinResponse, TransportConfig } from '@butinapp/sdk'
import axios from 'axios'

import type { AuthResolver } from '../plugin/auth-resolve.js'

import { REQUEST_TIMEOUT_MS } from './constants.js'
import { createHttpClient, type RawSend } from './http-client.js'
import type { RequestCache } from './request-cache.js'

// axios over Node TLS. It honours `responseType` itself, so the shared client needs no decode step; the header
// names are the canonical HTTP casing, which is what a service echoing headers back sees.
const axiosRequest: RawSend = async (opts) => {
  const res = await axios.request({
    method: opts.method,
    url: opts.url,
    headers: opts.headers,
    data: opts.body,
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
  rawRequest: RawSend = axiosRequest,
  cache?: RequestCache,
  logTag?: string
): ButinClient =>
  createHttpClient(transport, resolveAuth, rawRequest, {
    cache,
    logTag,
    headerNames: { userAgent: 'User-Agent', cookie: 'Cookie', referer: 'Referer', contentType: 'Content-Type' }
  })

export type { RawSend as RawRequest }
export type { ButinResponse }

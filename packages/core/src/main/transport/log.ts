import { createLogger } from '../log.js'

// Collapse a response body to a short, single-line diagnostic. Used ONLY for failures (the error message
// the server returned — e.g. Stripe's `{error:{message}}`); never for successful bodies, which can carry
// minted tokens / account data. Handles JSON, text, and the Electron transport's raw Buffer/ArrayBuffer.
const summarizeBody = (body: unknown): string => {
  if (body == null) {
    return ''
  }

  let text: string

  if (typeof body === 'string') {
    text = body
  } else if (Buffer.isBuffer(body)) {
    text = body.toString('utf8')
  } else if (body instanceof ArrayBuffer) {
    text = Buffer.from(body).toString('utf8')
  } else {
    try {
      text = JSON.stringify(body)
    } catch {
      return ''
    }
  }

  text = text.replace(/\s+/g, ' ').trim()

  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

// What we put on the wire, summarized for a FAILURE only — header NAMES + the cookie NAMES (never values:
// the cookie/Bearer/CSRF values stay secret). The one signal that says whether auth was actually attached:
// `cookies: none` on a 401 means the Cookie header never made it onto the request.
const summarizeRequestHeaders = (headers?: Record<string, string>): Record<string, unknown> => {
  if (!headers) {
    return {}
  }

  const names = Object.keys(headers)
  const cookieKey = names.find((k) => k.toLowerCase() === 'cookie')
  const cookieNames = cookieKey
    ? headers[cookieKey]!.split(';')
        .map((c) => c.split('=')[0]?.trim())
        .filter(Boolean)
    : []

  return {
    sentHeaders: names.filter((k) => k.toLowerCase() !== 'cookie').sort(),
    cookies: cookieNames.length > 0 ? cookieNames : 'none'
  }
}

// Net logging routed through the structured logger under scope 'net' + the originating plugin, so the Logs
// view filters network traffic by service. A success logs method + URL + status + duration only at debug
// (verbose) — NEVER headers or a success body (they carry the Bearer/cookie / minted tokens). A failure
// (>= 400) logs at warn (surfaces at the default level) and attaches the response body (the server's error
// message) plus a header/cookie-NAME summary of what we sent — the two details that make a 401/403/422
// diagnosable instead of opaque. Values are never logged.
export const logRequest = (
  method: string,
  url: string,
  status: number,
  ms: number,
  plugin?: string,
  // Passed on every call; summarized ONLY on a failure (success bodies/headers carry the Bearer/cookie).
  body?: unknown,
  requestHeaders?: Record<string, string>
): void => {
  const logger = createLogger({ scope: 'net', plugin })

  if (status >= 400) {
    const detail = summarizeBody(body)

    logger.warn(`✗ ${method} ${url} → ${status} (${ms}ms)${detail ? ` — ${detail}` : ''}`, {
      method,
      url,
      status,
      ms,
      body: detail || undefined,
      ...summarizeRequestHeaders(requestHeaders)
    })

    return
  }

  logger.debug(`✓ ${method} ${url} → ${status} (${ms}ms)`, { method, url, status, ms })
}

// A request that threw before any response — a timeout, DNS miss, or dropped connection — so `logRequest`
// (which needs a status) never runs. Logged at warn (surfaces at the default level), symmetric with the
// >= 400 case: the one line that says a fetch died on the wire even when the collector swallows the throw to
// degrade gracefully. No body / headers — there's no response to summarize.
export const logRequestError = (
  method: string,
  url: string,
  ms: number,
  plugin: string | undefined,
  err: unknown
): void => {
  const message = err instanceof Error ? err.message : String(err)

  createLogger({ scope: 'net', plugin }).warn(`✗ ${method} ${url} → ${message} (${ms}ms)`, {
    method,
    url,
    ms,
    error: message
  })
}

// A read served from the in-memory query cache (no network). `age` = ms since the cached response landed.
// No status: only successful (status < 400) reads are ever cached. Debug-level — pure diagnostic noise.
export const logCachedRequest = (method: string, url: string, ageMs: number, plugin?: string): void => {
  createLogger({ scope: 'net', plugin }).debug(`⟳ ${method} ${url} → cached (age ${(ageMs / 1000).toFixed(1)}s)`, {
    method,
    url,
    cachedAgeMs: ageMs
  })
}

// A request held by the per-host pacer before it dispatched. `waitMs` = the actual delay this request
// incurred — its jittered gap plus any time queued behind earlier same-host requests. Debug-level: visible
// only when the net scope is raised, so a normal run isn't noisy but a "why is this slow?" investigation can
// see the pacing contribution.
export const logPacedRequest = (method: string, url: string, waitMs: number, plugin?: string): void => {
  createLogger({ scope: 'net', plugin }).debug(`⏳ ${method} ${url} → paced (waited ${waitMs}ms)`, {
    method,
    url,
    pacedWaitMs: waitMs
  })
}

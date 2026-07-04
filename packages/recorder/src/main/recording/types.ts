// The schema Butin Recorder writes to a run directory. The intended reader is an LLM /
// agent that opens a finished recording and reverse-engineers the site's API
// from it — so every field is captured faithfully and named to be self-evident.
// A run carries no source code, only observed traffic and state; the in-run
// AGENTS.md guide explains how to interpret these structures.

export const SCHEMA_VERSION = 1

/** User-editable capture filter (defaults in filters.ts). */
export interface FilterConfig {
  /** CDP resourceTypes to skip (e.g. Image, Font, Script). */
  skipResourceTypes: string[]
  /** Drop requests whose host contains any of these substrings. */
  blockHosts: string[]
}

export type ContextKind = 'page' | 'popup' | 'iframe' | 'worker' | 'service_worker'

export interface CaptureContext {
  /** Which browsing context emitted the request. */
  kind: ContextKind
  /** URL of the iframe/worker/popup target, when the request came from a sub-target. */
  targetUrl?: string
  /** Top-document URL active in the tab when the request fired (grouping key). */
  pageUrl?: string
  /** Top-document title active when the request fired — human-friendly grouping. */
  pageTitle?: string
  /** CDP flattened session id of the sub-target, if any. */
  sessionId?: string
}

export interface RecordedRequest {
  /** Monotonic capture order across every context in the run (1-based). */
  index: number
  /** ISO timestamp when this record was written (≈ when the response finished). */
  timestamp: string
  /** CDP resource type: Document, XHR, Fetch, EventSource, WebSocket, Script, ... */
  type: string
  /** The browsing context that produced this request. */
  context?: CaptureContext
  /** CDP frame id, useful to group requests from the same iframe. */
  frameId?: string

  request: {
    url: string
    method: string
    /** Headers as the app/JS set them (what you'd send from code). */
    headers: Record<string, string>
    /** Request body as text (form-encoded, JSON, GraphQL, ...), or null. */
    body: string | null
    /**
     * The exact headers the browser put on the wire — a superset of `headers`
     * that includes cookies and the sec-* / accept-* headers the browser adds.
     * Use THIS for a faithful replay; fall back to `headers` if absent.
     */
    wireHeaders?: Record<string, string>
    /** Cookies actually sent with this request (parsed from the wire). */
    cookies?: Array<{ name: string; value: string; domain?: string; path?: string }>
    /** True when the body was too large / unavailable to capture in full. */
    bodyTruncated?: boolean
    /** GraphQL operation name(s), when the body is a GraphQL POST. Disambiguates same-URL calls. */
    graphqlOperation?: string
    /** Next.js Server Action id (from the Next-Action header), when present. */
    nextAction?: string
    /** CDP initiator: how the request was triggered (parser, script + stack, preload). */
    initiator?: unknown
  }

  response: {
    status: number
    headers: Record<string, string>
    /** Response body. If `base64Encoded` is true this is binary in base64. */
    body: string
    /** True ⇒ `body` is base64-encoded binary; false ⇒ `body` is text. */
    base64Encoded: boolean
    mimeType: string
    statusText?: string
    /** Exact response headers from the wire (includes raw Set-Cookie, etc.). */
    wireHeaders?: Record<string, string>
    /** Raw Set-Cookie header lines the server returned. */
    setCookieHeaders?: string[]
    /** Size of the (decoded) body in bytes. */
    bodyBytes?: number
    /** sha256 of the decoded body, for dedup / integrity. */
    bodySha256?: string
    remoteIPAddress?: string
    /** Negotiated protocol: http/1.1, h2, h3, ... */
    protocol?: string
    fromDiskCache?: boolean
    fromServiceWorker?: boolean
    /** True ⇒ body was assembled from streamed chunks (e.g. SSE). */
    streamed?: boolean
    /** Present only when the body is empty/partial — explains why. */
    bodyNote?: string
  }

  timing: {
    /** ms since epoch (approx) when the request was sent. */
    requestSentMs: number
    /** ms since epoch (approx) when the response was received. */
    responseReceivedMs: number
    /** Convenience: responseReceivedMs − requestSentMs. */
    durationMs?: number
    /** Raw CDP ResourceTiming (DNS/connect/TLS/send/wait phases), when available. */
    resourceTiming?: unknown
  }
}

export interface RecordedWebSocketFrame {
  ts: string
  direction: 'sent' | 'received'
  /** WebSocket opcode: 1 text, 2 binary, 8 close, 9 ping, 10 pong. */
  opcode: number
  /** Frame payload. Text for opcode 1; base64 for opcode 2 (binary). */
  payload: string
  base64Encoded: boolean
}

export interface RecordedWebSocket {
  index: number
  url: string
  context?: CaptureContext
  openedAt: string
  closedAt?: string
  /** Handshake request headers (the HTTP upgrade). */
  requestHeaders?: Record<string, string>
  /** Handshake response headers (the 101 Switching Protocols). */
  responseHeaders?: Record<string, string>
  frames: RecordedWebSocketFrame[]
  closeCode?: number
}

export interface RecordingManifest {
  runId: string
  label: string
  startUrl: string
  /** Browser session partition used (persistent reuse vs ephemeral). */
  partition: string
  captureAll: boolean
  startedAt: string
  endedAt: string
  requestCount: number
  navigationCount: number
  /** Format version of the files in this run. */
  schemaVersion?: number
  /** Tool + version that produced the run, e.g. "butin-recorder@0.0.0". */
  generator?: string
  webSocketCount?: number
  /** Number of distinct browsing contexts (pages/popups/iframes/workers) seen. */
  contextsAttached?: number
  /** Requests per host — a quick map of the API surface. */
  hostCounts?: Record<string, number>
  /** True if any capture step errored (the run may be incomplete). */
  hadErrors?: boolean
}

export interface RecordingSummary {
  runId: string
  label: string
  startedAt: string
  requestCount: number
  /** Number of WebSocket connections captured (0 when absent). */
  webSocketCount?: number
  /** Host of the recorded start URL — often more identifying than the label. */
  host?: string
}

export interface StartRecordingPayload {
  label: string
  startUrl: string
  reuseSession: boolean
  captureAll: boolean
  /** Also emit a HAR 1.2 export at stop time. */
  exportHar?: boolean
}

export interface StartRecordingResult {
  runId: string
}

/** One line of network.jsonl — a fast, tail-able index over a run. */
export interface NetworkLogLine {
  index: number
  ts: string
  method: string
  url: string
  status: number
  type: string
  bytes: number
  durationMs: number
  context: ContextKind
  /** Title of the page that was active when this request fired. */
  pageTitle?: string
  /** GraphQL operation name(s), when applicable. */
  graphqlOperation?: string
  /** Next.js Server Action id, when applicable. */
  nextAction?: string
}

/** One line of navigation.jsonl — the page-by-page journey, linked to screenshots. */
export interface NavigationLogLine {
  index: number
  ts: string
  url: string
  title: string
  screenshot: string
  context: ContextKind
}

export type LogLevel = 'info' | 'warn' | 'error'

/**
 * One line of log.jsonl — a human/agent-readable trace of what the recorder did and anything that
 * went wrong (navigations, Electron load failures, pause/resume, capture errors). Separate from
 * network.jsonl (the request index): this is the run's diagnostic narrative, not its captured traffic.
 */
export interface RecorderLogLine {
  ts: string
  level: LogLevel
  /** Short machine tag: 'start' | 'navigate' | 'load-failed' | 'pause' | 'resume' | 'stop' | 'warning'. */
  event: string
  /** Human-readable one-liner. */
  message: string
  /** Optional structured payload (url, errorCode, host, …). */
  data?: Record<string, unknown>
}

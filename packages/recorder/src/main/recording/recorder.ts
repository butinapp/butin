import type { DownloadItem, Session, WebContents, WebFrameMain } from 'electron'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import { classifyDownload, mergeDownloads } from '../../detect/downloads.js'
import type { DetectedDownload } from '../../detect/types.js'

import { shouldCapture } from './filters.js'
import { extractGraphqlOperation } from './graphql.js'
import { screenshotFileName } from './naming.js'
import { extractNextAction } from './nextjs.js'
import {
  appendNavigationLog,
  appendNetworkLog,
  appendNetworkMarker,
  appendRunLog,
  writeCookieJournal,
  writeCookies,
  writeDownloads,
  writeStartCookies,
  writeManifest,
  writeRequestFile,
  writeRunSummary,
  writeScreenshot,
  writeSessionGuide,
  writeStorageSnapshot,
  writeWebSocketFile
} from './storage.js'
import { shouldStreamResponse } from './streaming.js'
import {
  SCHEMA_VERSION,
  type CaptureContext,
  type ContextKind,
  type FilterConfig,
  type LogLevel,
  type RecordedRequest,
  type RecorderLogLine,
  type RecordedWebSocket,
  type RecordingManifest
} from './types.js'

// CDP gives us request ids that are unique only within a single session, so we
// key every pending entry by (webContents id | session id | request id).
function pendingKey(wcId: number, sessionId: string, requestId: string): string {
  return `${wcId}|${sessionId}|${requestId}`
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function mapTargetType(type: string): ContextKind {
  switch (type) {
    case 'iframe':
      return 'iframe'
    case 'worker':
    case 'shared_worker':
      return 'worker'
    case 'service_worker':
      return 'service_worker'
    default:
      return 'page'
  }
}

// CDP saying the request is no longer streamable: it completed, or its id has already been retired. Either way
// the single-shot read is the right path, not a sign anything went wrong.
function isRequestAlreadySettled(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)

  return /already finished loading|does not exists?/i.test(message)
}

// The Network-domain commands that read a body out of the network agent. Refused on a session that has not
// reported Network.enable — see canReadBody.
const BODY_COMMANDS = new Set([
  'Network.getResponseBody',
  'Network.getRequestPostData',
  'Network.streamResourceContent'
])

function isTextLike(mimeType: string): boolean {
  return /json|text|xml|javascript|event-stream|x-www-form-urlencoded/i.test(mimeType)
}

interface Pending {
  wcId: number
  sessionId: string
  kind: ContextKind
  targetUrl?: string
  pageUrl?: string
  pageTitle?: string
  // request
  url: string
  method: string
  requestHeaders: Record<string, string>
  postData: string | null
  hasPostData: boolean
  type: string
  requestSentMs: number
  initiator?: unknown
  frameId?: string
  // request extra-info (wire)
  wireReqHeaders?: Record<string, string>
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string }>
  // response
  status?: number
  statusText?: string
  respHeaders?: Record<string, string>
  mimeType?: string
  remoteIPAddress?: string
  protocol?: string
  fromDiskCache?: boolean
  fromServiceWorker?: boolean
  resourceTiming?: unknown
  responseReceivedMs?: number
  // response extra-info (wire)
  wireRespHeaders?: Record<string, string>
  setCookie?: string[]
  // streaming
  streamed: boolean
  streamChunks: Buffer[]
}

interface WsPending {
  index: number
  wcId: number
  sessionId: string
  kind: ContextKind
  ws: RecordedWebSocket
}

interface Attachment {
  wc: WebContents
  kind: ContextKind
  /**
   * child-session id -> {kind,url,ready}, learned via Target.attachedToTarget. `ready` flips once that session's
   * Network.enable has come back — see canReadBody for why nothing may read a body before it does.
   */
  sessionKinds: Map<string, { kind: ContextKind; url?: string; ready: boolean }>
  /** Latest top-document URL/title, stamped onto requests for grouping. */
  currentUrl: string
  currentTitle: string
  onMessage: (event: unknown, method: string, params: any, sessionId?: string) => void
  onNavigate: (event: unknown, url: string) => void
  onWillNavigate: (event: unknown, url: string) => void
  onTitleUpdated: (event: unknown, title: string) => void
  onDidFinishLoad: () => void
  onDidFrameFinishLoad: () => void
  suspended: boolean
}

/** What names a run in its manifest — supplied by the window layer, which owns the recording's identity. */
export interface RunIdentity {
  label: string
  startUrl: string
  partition: string
}

export interface RecorderOptions {
  runDir: string
  captureAll: boolean
  /** User-editable skip-list; undefined falls back to built-in defaults. */
  filters?: FilterConfig
  /** Begin capturing immediately. When false, the recorder starts paused. */
  autoRecord?: boolean
  /** Auto-pause capture after recording a response with an HTTP error status (>= 400). */
  autoPauseOnError?: boolean
  onProgress: (counts: { requests: number; websockets: number }) => void
  /** Emitted for every diagnostic log line (also persisted to log.jsonl). */
  onLog?: (line: RecorderLogLine) => void
  /** Emitted when a browser-native download finishes and is saved into the run — for a UI confirmation. */
  onDownload?: (info: { filename?: string; bytes?: number; savedAs: string }) => void
}

export class Recorder {
  private runDir: string
  private captureAll: boolean
  private filters?: FilterConfig
  private onProgress: (counts: { requests: number; websockets: number }) => void
  private onLog?: (line: RecorderLogLine) => void
  private onDownload?: (info: { filename?: string; bytes?: number; savedAs: string }) => void
  private autoPauseOnError: boolean

  private attachments = new Map<number, Attachment>()
  private pending = new Map<string, Pending>()
  // Main-frame document records held between loadingFinished and the page's did-finish-load, where their
  // rendered HTML is snapshotted (the raw navigation body isn't retrievable via Network.getResponseBody).
  private docsAwaitingHtml = new Map<string, Pending>()
  private wsPending = new Map<string, WsPending>()

  private index = 0
  private wsIndex = 0
  private requestCount = 0
  private webSocketCount = 0
  private navigationCount = 0
  // Single-slot coalescing for navigation screenshots (see captureScreenshot): the latest pending
  // request, whether a capturePage() is currently running, and a circuit-breaker that gives up on
  // screenshots for the rest of the run once captures fail repeatedly (a wedged GPU compositor).
  private screenshotQueued: { wc: WebContents; url: string; index: number } | null = null
  private screenshotBusy = false
  private screenshotsDisabled = false
  private origins = new Set<string>()
  private hostCounts: Record<string, number> = {}
  private storageSnapshots = new Map<
    string,
    { localStorage: Record<string, string>; sessionStorage: Record<string, string> }
  >()
  private hadErrors = false
  // BUTIN_RECORDER_TRACE=1 writes trace.log: one SYNCHRONOUS line per attached-only action, before and after.
  // log.jsonl is appended asynchronously, so a hard abort discards its tail and the last thing the recorder did
  // is exactly what goes missing. A sync line survives, so the final `>` with no matching `<` names the call the
  // process died inside. Off by default — a sync write per CDP command is far too slow for a normal run.
  private tracing = process.env.BUTIN_RECORDER_TRACE === '1'
  // BUTIN_RECORDER_NO_PAGE_TOUCH=1 keeps the debugger attached and every network record intact, but stops the
  // recorder reaching INTO the page: no capturePage, no storage snapshot, no rendered-DOM snapshot. Pausing
  // drops the debugger and these together, so this is the way to record a site's full network surface while
  // leaving the page itself untouched.
  private pageTouch = process.env.BUTIN_RECORDER_NO_PAGE_TOUCH !== '1'
  // Responses that finished before their streamResourceContent call landed — expected on any chunked API, so
  // they're counted rather than logged one by one, and reported once at stop.
  private streamRaceCount = 0
  // Responses whose body was left unread because their session never reported Network.enable — see canReadBody.
  private unreadableBodies = 0
  private startedAt = new Date()
  // When paused, the page must run like an ordinary browser with nothing a browser-verification check can
  // detect: the CDP debugger is detached from every contents, in-flight network / WebSocket events are
  // dropped, AND every page-touch capture artifact is suppressed — no capturePage() (its GPU readback churns
  // WebGL contexts and can make a WebGL verification challenge fail) and no executeJavaScript storage snapshot.
  // Attaching the debugger + resuming those artifacts is what begins capture.
  private paused = false
  // Accumulated for summary.md.
  private pages = new Map<string, string>()
  private typeCounts: Record<string, number> = {}
  private endpoints = new Map<string, { count: number; lastStatus: number }>()
  // Every Set-Cookie a response issued, in order — recorded as it arrives (not at record-write) so a cookie set
  // on a redirect hop or a dropped record still shows. Traces where a session cookie is minted, which the final
  // jar can't reveal for a cookie already present before the recording. See cookie-journal.json.
  private cookieJournal: Array<{ url?: string; status?: number; setCookie: string; kind: string }> = []
  // The cookie jar snapshotted the moment capture attaches — so a session cookie ALREADY present (minted in an
  // earlier browsing session, its birth therefore uncapturable this run) is distinguishable from one minted during
  // the run. A session-like name here but absent from the journal ⇒ re-record with it cleared to see its mint.
  private cookiesAtStart: Array<{ name: string; domain?: string; path?: string }> = []
  // Downloadable documents (PDF invoices/statements): passive ones classified off captured responses, native
  // ones captured via the session's will-download (a browser navigation that became a download). Merged at stop.
  private passiveDownloads: DetectedDownload[] = []
  private nativeDownloads: DetectedDownload[] = []
  private downloads: DetectedDownload[] = []
  private downloadIndex = 0

  private session: Session | null = null
  private mainWc: WebContents | null = null

  constructor(opts: RecorderOptions) {
    this.runDir = opts.runDir
    this.captureAll = opts.captureAll
    this.filters = opts.filters
    this.onProgress = opts.onProgress
    this.onLog = opts.onLog
    this.onDownload = opts.onDownload
    this.autoPauseOnError = opts.autoPauseOnError ?? false
    // "Auto-record" off ⇒ open paused; the user resumes from the toolbar.
    this.paused = !(opts.autoRecord ?? true)
  }

  /** Toggle the "pause when an HTTP error response is recorded" debug aid mid-recording. */
  setAutoPauseOnError(value: boolean): void {
    this.autoPauseOnError = value
  }

  /** Toggle capture on/off mid-recording. Pausing drops anything in flight. */
  setPaused(paused: boolean): void {
    if (this.paused === paused) {
      return
    }

    this.paused = paused

    if (paused) {
      // Drop half-captured requests so they aren't written when they finish.
      this.pending.clear()
      this.docsAwaitingHtml.clear()

      // Detach the debugger from every contents so the page runs with nothing a verification check can see while
      // capture is off. A contents DevTools currently holds is left alone — its handoff owns the debugger.
      for (const a of this.attachments.values()) {
        if (!a.suspended) {
          this.detachDebugger(a)
        }
      }
    } else {
      // Re-attach to resume capture. Child-session ids from the prior attach are stale, so clear them; a
      // contents suspended for DevTools re-attaches when DevTools closes (see resume), not here.
      for (const a of this.attachments.values()) {
        if (!a.suspended && !a.wc.isDestroyed()) {
          a.sessionKinds.clear()
          this.openDebugger(a)
        }
      }
    }

    // Mark the boundary in the timeline so an agent can tell deliberate action
    // (after a resume) from earlier exploratory clicking.
    void appendNetworkMarker(this.runDir, paused ? 'pause' : 'resume').catch(() => {})
    this.log('info', paused ? 'pause' : 'resume', paused ? 'Capture paused' : 'Capture resumed')
  }

  isPaused(): boolean {
    return this.paused
  }

  // --- public API -----------------------------------------------------------

  /** Attach capture to a webContents (the site view, or a popup/child window). */
  attachTo(wc: WebContents, kind: ContextKind): void {
    if (wc.isDestroyed() || this.attachments.has(wc.id)) {
      return
    }

    if (!this.mainWc) {
      this.mainWc = wc
      this.session = wc.session
      // Capture browser-native downloads (a navigation that becomes a file) on the shared session — the one
      // download shape that never leaves a retrievable Network body, so it's invisible without this hook.
      this.session.on('will-download', this.onWillDownload)
      // Snapshot the jar now so pre-existing session cookies are told apart from ones minted during the run.
      void this.snapshotStartCookies()
    }

    const attachment: Attachment = {
      wc,
      kind,
      sessionKinds: new Map(),
      currentUrl: wc.getURL(),
      currentTitle: wc.getTitle(),
      suspended: false,
      onMessage: (_e, method, params, sessionId) => this.onMessage(wc.id, method, params, sessionId ?? ''),
      onNavigate: (_e, url) => this.onNavigate(wc, kind, url),
      onWillNavigate: (_e, _url) => this.onWillNavigate(wc),
      onTitleUpdated: (_e, title) => {
        const a = this.attachments.get(wc.id)

        if (a) {
          a.currentTitle = title
        }
      },
      onDidFinishLoad: () => void this.flushDeferredDocs(wc),
      // A subframe finishes on its own event (after the top page's did-finish-load), so flush again to catch a
      // late cross-origin frame (a framed portal list) the page-level flush was too early to see.
      onDidFrameFinishLoad: () => void this.flushDeferredDocs(wc)
    }

    this.attachments.set(wc.id, attachment)

    // Attach the CDP debugger only while capturing. Opening paused (auto-record off) leaves the page with no
    // debugger, so a browser-verification challenge sees an ordinary browser; hitting Record attaches it. The
    // Electron navigation listeners below stay bound regardless — they don't use CDP and aren't detectable.
    if (!this.paused) {
      this.openDebugger(attachment)
    }

    wc.on('did-navigate', attachment.onNavigate)
    wc.on('did-navigate-in-page', attachment.onNavigate)
    wc.on('will-navigate', attachment.onWillNavigate)
    wc.on('page-title-updated', attachment.onTitleUpdated)
    wc.on('did-finish-load', attachment.onDidFinishLoad)
    wc.on('did-frame-finish-load', attachment.onDidFrameFinishLoad)
    wc.once('destroyed', () => this.detach(wc.id))
    // When DevTools closes on this contents, resume capture (see suspendForDevTools).
    wc.on('devtools-closed', () => this.resume(wc.id))
  }

  /**
   * Yield the debugger so DevTools can attach to `wc` (Electron allows only one
   * debugger per webContents). Call this right before openDevTools(); capture
   * for this contents pauses and auto-resumes on the 'devtools-closed' event.
   */
  suspendForDevTools(wc: WebContents): void {
    const a = this.attachments.get(wc.id)

    if (!a || a.suspended) {
      return
    }

    a.suspended = true
    this.detachDebugger(a)
  }

  private resume(wcId: number): void {
    const a = this.attachments.get(wcId)

    if (!a || !a.suspended || a.wc.isDestroyed()) {
      return
    }

    a.suspended = false

    // DevTools can close while the recording is paused — only re-attach if capture is actually running.
    if (!this.paused) {
      a.sessionKinds.clear()
      this.openDebugger(a)
    }
  }

  /**
   * Write the manifest for a run still in progress. ipc.ts lists only run dirs that hold a manifest.json, so
   * without this a run that ends abruptly is invisible in the UI even though every request it captured is
   * already on disk. The window layer calls this on an interval; stop overwrites it with the final one.
   */
  async checkpoint(opts: RunIdentity): Promise<void> {
    await writeManifest(this.runDir, this.buildManifest(opts, false)).catch((err) =>
      this.warn('manifest checkpoint failed', err)
    )
  }

  // `complete` is false for a checkpoint and true only once stop has flushed everything, so a run cut short by a
  // crash is distinguishable from one that ended cleanly.
  private buildManifest(opts: RunIdentity, complete: boolean): RecordingManifest {
    return {
      runId: basename(this.runDir),
      label: opts.label,
      startUrl: opts.startUrl,
      partition: opts.partition,
      captureAll: this.captureAll,
      startedAt: this.startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      requestCount: this.requestCount,
      navigationCount: this.navigationCount,
      schemaVersion: SCHEMA_VERSION,
      generator: 'butin-recorder@0.0.0',
      webSocketCount: this.webSocketCount,
      contextsAttached: this.attachments.size,
      hostCounts: this.hostCounts,
      hadErrors: this.hadErrors,
      complete
    }
  }

  async stop(opts: RunIdentity): Promise<RecordingManifest> {
    // Flush still-open streamed responses (e.g. long-lived SSE) as partial records.
    for (const [key, p] of this.pending) {
      if (p.streamed) {
        await this.writeRecord(key, p, true)
      }
    }

    // Flush any document records still waiting on their frame's HTML snapshot (a page/frame open at stop time, or
    // one whose load event never fired): snapshot from the frame tree for any frame still present, then write the
    // rest body-less (frame gone / never loaded).
    for (const a of this.attachments.values()) {
      await this.flushDeferredDocs(a.wc)
    }

    for (const [key, p] of this.docsAwaitingHtml) {
      await this.writeRecord(key, p, false)
    }

    this.docsAwaitingHtml.clear()

    // Finalize any WebSockets that never emitted a close event. finishWebSocket
    // deletes the current key only, which is safe during live Map iteration.
    for (const key of this.wsPending.keys()) {
      await this.finishWebSocket(key)
    }

    for (const a of this.attachments.values()) {
      this.detachDebugger(a)

      if (!a.wc.isDestroyed()) {
        a.wc.off('did-navigate', a.onNavigate)
        a.wc.off('did-navigate-in-page', a.onNavigate)
        a.wc.off('will-navigate', a.onWillNavigate)
        a.wc.off('page-title-updated', a.onTitleUpdated)
        a.wc.off('did-finish-load', a.onDidFinishLoad)
        a.wc.off('did-frame-finish-load', a.onDidFrameFinishLoad)
      }
    }

    this.session?.off('will-download', this.onWillDownload)

    await this.dumpStorage()
    await this.dumpCookies()

    if (this.cookieJournal.length) {
      await writeCookieJournal(this.runDir, this.cookieJournal).catch((err) =>
        this.warn('cookie journal write failed', err)
      )
    }

    if (this.cookiesAtStart.length) {
      await writeStartCookies(this.runDir, this.cookiesAtStart).catch((err) =>
        this.warn('start cookies write failed', err)
      )
    }

    // Fold native downloads into the passively-classified ones (a native download inherits its captured request's
    // headers by URL) → downloads.json + the summary section. Written only when a run actually produced downloads.
    this.downloads = mergeDownloads(this.passiveDownloads, this.nativeDownloads)

    if (this.downloads.length) {
      await writeDownloads(this.runDir, this.downloads).catch((err) => this.warn('downloads write failed', err))
    }

    // Drop an agent-oriented reading guide into the run so any LLM pointed at
    // the folder knows how to interpret the captured data.
    await writeSessionGuide(this.runDir)

    const manifest = this.buildManifest(opts, true)

    await writeManifest(this.runDir, manifest)
    await writeRunSummary(this.runDir, this.buildSummaryMarkdown(manifest)).catch((err) =>
      this.warn('summary write failed', err)
    )

    this.log(
      'info',
      'stop',
      `Recording stopped — ${manifest.requestCount} requests, ${manifest.webSocketCount} websockets`,
      {
        requests: manifest.requestCount,
        websockets: manifest.webSocketCount,
        hadErrors: manifest.hadErrors,
        streamRaces: this.streamRaceCount,
        unreadableBodies: this.unreadableBodies
      }
    )

    return manifest
  }

  // --- debugger wiring ------------------------------------------------------

  private openDebugger(a: Attachment): void {
    const dbg = a.wc.debugger

    try {
      if (!dbg.isAttached()) {
        dbg.attach('1.3')
      }
    } catch (err) {
      // Most likely DevTools owns the debugger. We'll attach on devtools-closed.
      this.warn('attach failed', err)

      return
    }

    dbg.on('message', a.onMessage)
    void this.send(a.wc, 'Network.enable', {
      maxResourceBufferSize: 100 * 1024 * 1024,
      maxTotalBufferSize: 500 * 1024 * 1024
    })
    // Surface out-of-process iframes, dedicated/shared workers and service
    // workers through this same connection (flattened, with their own sessionId).
    void this.send(a.wc, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    })
  }

  // Detach the CDP debugger from one contents and drop its message listener — idempotent (a no-op if it
  // was never attached or DevTools already took it). Leaves the attachment record + Electron listeners.
  private detachDebugger(a: Attachment): void {
    try {
      const dbg = a.wc.debugger

      if (dbg.isAttached()) {
        dbg.off('message', a.onMessage)
        dbg.detach()
      }
    } catch {
      // already detached
    }
  }

  private detach(wcId: number): void {
    const a = this.attachments.get(wcId)

    if (!a) {
      return
    }

    this.detachDebugger(a)

    if (!a.wc.isDestroyed()) {
      a.wc.off('did-finish-load', a.onDidFinishLoad)
      a.wc.off('did-frame-finish-load', a.onDidFrameFinishLoad)
    }

    // The contents is gone, so its deferred documents can no longer be snapshotted — write them body-less.
    for (const [key, p] of this.docsAwaitingHtml) {
      if (p.wcId === wcId) {
        this.docsAwaitingHtml.delete(key)
        void this.writeRecord(key, p, false, null)
      }
    }

    this.attachments.delete(wcId)
  }

  /**
   * Whether a body may be fetched from this session. A Network-domain body command — getResponseBody,
   * getRequestPostData, streamResourceContent — issued on a child session whose Network.enable has not come back
   * kills the browser process outright: it is a CHECK inside Chromium's network agent, not a protocol error, so
   * there is no rejection to catch and the whole recording dies with it. The root session is enabled by
   * openDebugger before any target can attach, so only child sessions need proving.
   */
  private canReadBody(wcId: number, sessionId?: string): boolean {
    if (!sessionId) {
      return true
    }

    return this.attachments.get(wcId)?.sessionKinds.get(sessionId)?.ready === true
  }

  private send(wc: WebContents, method: string, params?: object, sessionId?: string): Promise<any> {
    // Guarded here rather than at each call site: a single missed caller is fatal, and every body read already
    // treats a rejection as "no body available".
    if (BODY_COMMANDS.has(method) && !this.canReadBody(wc.id, sessionId)) {
      this.unreadableBodies += 1
      this.trace('!', 'body-refused', `${method} sess=${sessionId}`)

      return Promise.reject(new Error(`${method} refused: session ${sessionId} has not reported Network.enable`))
    }

    this.trace('>', 'cdp', `${method} sess=${sessionId || 'root'}`)

    return this.traced('cdp', wc.debugger.sendCommand(method, params ?? {}, sessionId || undefined), method)
  }

  // --- CDP message handling -------------------------------------------------

  private contextFor(wcId: number, sessionId: string): CaptureContext {
    const a = this.attachments.get(wcId)

    if (sessionId && a) {
      const sk = a.sessionKinds.get(sessionId)

      if (sk) {
        return { kind: sk.kind, targetUrl: sk.url, sessionId }
      }
    }

    return { kind: a?.kind ?? 'page', sessionId: sessionId || undefined }
  }

  private onMessage(wcId: number, method: string, params: any, sessionId: string): void {
    // While paused, ignore all traffic but keep handling Target.* so the
    // session topology (iframes/workers) stays correct for when we resume.
    if (this.paused && method.startsWith('Network.')) {
      return
    }

    // Opened only once the event is actually going to be handled, so a dropped one leaves no unmatched span.
    this.trace('>', 'evt', `${method} sess=${sessionId || 'root'}`)

    try {
      switch (method) {
        case 'Target.attachedToTarget':
          this.onTargetAttached(wcId, params, sessionId)

          return
        case 'Target.detachedFromTarget': {
          const a = this.attachments.get(wcId)

          a?.sessionKinds.delete(params?.sessionId)

          return
        }
        case 'Network.requestWillBeSent':
          this.onRequestWillBeSent(wcId, sessionId, params)

          return
        case 'Network.requestWillBeSentExtraInfo':
          this.onRequestExtraInfo(wcId, sessionId, params)

          return
        case 'Network.responseReceived':
          this.onResponseReceived(wcId, sessionId, params)

          return
        case 'Network.responseReceivedExtraInfo':
          this.onResponseExtraInfo(wcId, sessionId, params)

          return
        case 'Network.dataReceived':
          this.onDataReceived(wcId, sessionId, params)

          return
        case 'Network.loadingFinished':
          void this.finish(wcId, sessionId, params.requestId)

          return
        case 'Network.loadingFailed':
          this.pending.delete(pendingKey(wcId, sessionId, params.requestId))

          return
        // WebSockets
        case 'Network.webSocketCreated':
          this.onWsCreated(wcId, sessionId, params)

          return
        case 'Network.webSocketWillSendHandshakeRequest':
          this.withWs(wcId, sessionId, params.requestId, (w) => {
            w.ws.requestHeaders = params.request?.headers ?? {}
          })

          return
        case 'Network.webSocketHandshakeResponseReceived':
          this.withWs(wcId, sessionId, params.requestId, (w) => {
            w.ws.responseHeaders = params.response?.headers ?? {}
          })

          return
        case 'Network.webSocketFrameSent':
          this.onWsFrame(wcId, sessionId, params, 'sent')

          return
        case 'Network.webSocketFrameReceived':
          this.onWsFrame(wcId, sessionId, params, 'received')

          return
        case 'Network.webSocketFrameError':
          this.hadErrors = true

          return
        case 'Network.webSocketClosed':
          this.withWs(wcId, sessionId, params.requestId, (w) => {
            w.ws.closedAt = new Date().toISOString()
          })
          void this.finishWebSocket(pendingKey(wcId, sessionId, params.requestId))

          return
        default:
          return
      }
    } catch (err) {
      this.hadErrors = true
      this.warn(`handler ${method} threw`, err)
    } finally {
      this.trace('<', 'evt', `${method} sess=${sessionId || 'root'}`)
    }
  }

  private onTargetAttached(wcId: number, params: any, parentSessionId: string): void {
    const a = this.attachments.get(wcId)

    if (!a) {
      return
    }

    const childSession: string = params?.sessionId
    const info = params?.targetInfo ?? {}

    const session = { kind: mapTargetType(info.type ?? ''), url: info.url, ready: false }

    a.sessionKinds.set(childSession, session)
    // Enable network on the child session and cascade auto-attach for nesting. A target can accept the attach
    // and never answer Network.enable (its renderer never gets far enough), so readiness is what the reply
    // proves — not the attach.
    void this.send(a.wc, 'Network.enable', {}, childSession).then(
      () => {
        session.ready = true
      },
      () => {
        // stays unready — no body will be read from it
      }
    )
    void this.send(
      a.wc,
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      childSession
    )

    if (params?.waitingForDebugger) {
      void this.send(a.wc, 'Runtime.runIfWaitingForDebugger', {}, childSession)
    }

    void parentSessionId
  }

  private onRequestWillBeSent(wcId: number, sessionId: string, params: any): void {
    const key = pendingKey(wcId, sessionId, params.requestId)

    // A redirect reuses the same requestId — finalize the previous hop first.
    if (params.redirectResponse) {
      const prev = this.pending.get(key)

      if (prev) {
        prev.status = params.redirectResponse.status
        prev.statusText = params.redirectResponse.statusText
        prev.respHeaders = params.redirectResponse.headers ?? {}
        prev.mimeType = params.redirectResponse.mimeType ?? ''
        prev.responseReceivedMs = Date.now()
        void this.writeRecord(key, prev, false)
        this.pending.delete(key)
      }
    }

    const existingExtra = this.pending.get(key)
    const req = params.request ?? {}
    const ctx = this.contextFor(wcId, sessionId)
    const owner = this.attachments.get(wcId)

    this.pending.set(key, {
      wcId,
      sessionId,
      kind: ctx.kind,
      targetUrl: ctx.targetUrl,
      pageUrl: owner?.currentUrl,
      pageTitle: owner?.currentTitle,
      url: req.url ?? '',
      method: req.method ?? 'GET',
      requestHeaders: req.headers ?? {},
      postData: req.postData ?? null,
      hasPostData: Boolean(req.hasPostData),
      type: params.type ?? 'Other',
      requestSentMs: params.timestamp ? params.timestamp * 1000 : Date.now(),
      initiator: params.initiator,
      frameId: params.frameId,
      // carry over extra-info that may have arrived first
      wireReqHeaders: existingExtra?.wireReqHeaders,
      cookies: existingExtra?.cookies,
      streamed: false,
      streamChunks: []
    })
  }

  private onRequestExtraInfo(wcId: number, sessionId: string, params: any): void {
    const key = pendingKey(wcId, sessionId, params.requestId)
    const p = this.pending.get(key)
    const cookies = (params.associatedCookies ?? [])
      .filter((c: any) => !c.blockedReasons || c.blockedReasons.length === 0)
      .map((c: any) => ({
        name: c.cookie?.name,
        value: c.cookie?.value,
        domain: c.cookie?.domain,
        path: c.cookie?.path
      }))

    if (p) {
      p.wireReqHeaders = params.headers ?? {}
      p.cookies = cookies
    } else {
      // arrived before requestWillBeSent — stash a stub to merge later
      this.pending.set(key, {
        wcId,
        sessionId,
        kind: this.contextFor(wcId, sessionId).kind,
        url: '',
        method: 'GET',
        requestHeaders: {},
        postData: null,
        hasPostData: false,
        type: 'Other',
        requestSentMs: Date.now(),
        wireReqHeaders: params.headers ?? {},
        cookies,
        streamed: false,
        streamChunks: []
      })
    }
  }

  private onResponseReceived(wcId: number, sessionId: string, params: any): void {
    const key = pendingKey(wcId, sessionId, params.requestId)
    const p = this.pending.get(key)

    if (!p) {
      return
    }

    const r = params.response ?? {}

    p.status = r.status ?? 0
    p.statusText = r.statusText
    p.respHeaders = r.headers ?? {}
    p.mimeType = r.mimeType ?? ''
    p.remoteIPAddress = r.remoteIPAddress
    p.protocol = r.protocol
    p.fromDiskCache = r.fromDiskCache
    p.fromServiceWorker = r.fromServiceWorker
    p.resourceTiming = r.timing
    p.responseReceivedMs = params.timestamp ? params.timestamp * 1000 : Date.now()

    if (params.type) {
      p.type = params.type
    }

    // A long-lived / unbounded body (SSE, a Firestore Listen WebChannel, gRPC-web, a chunked NDJSON feed) can
    // never be read with a single getResponseBody at loadingFinished — the stream may outlive the recording, so
    // loadingFinished never fires and the record is dropped at stop. Switch those to streamResourceContent so we
    // accumulate dataReceived chunks and can flush whatever arrived. The tell is no Content-Length on a data
    // fetch (unknown-length / chunked); see shouldStreamResponse.
    if (shouldStreamResponse(p.type, p.mimeType ?? '', p.respHeaders ?? {})) {
      p.streamed = true
      void this.startStreaming(wcId, sessionId, params.requestId, p)
    }
  }

  private async startStreaming(wcId: number, sessionId: string, requestId: string, p: Pending): Promise<void> {
    const a = this.attachments.get(wcId)

    if (!a) {
      return
    }

    if (!this.canReadBody(wcId, sessionId)) {
      p.streamed = false

      return
    }

    try {
      const res = await this.send(a.wc, 'Network.streamResourceContent', { requestId }, sessionId)

      if (res?.bufferedData) {
        p.streamChunks.push(Buffer.from(res.bufferedData, 'base64'))
      }
    } catch (err) {
      // The optimistic streaming path lost its race: a finite response routed here for advertising no
      // Content-Length (a chunked JSON API — most of them) completed before this call landed, so CDP has no
      // stream left to open. Expected, not a fault: put the record back on the single-shot path, which reads
      // the body CDP still holds. Only a genuinely unexpected failure is worth a warning.
      p.streamed = false

      if (isRequestAlreadySettled(err)) {
        this.streamRaceCount += 1
      } else {
        this.warn('streamResourceContent failed', err)
      }
    }
  }

  private onResponseExtraInfo(wcId: number, sessionId: string, params: any): void {
    const key = pendingKey(wcId, sessionId, params.requestId)
    const p = this.pending.get(key)

    if (!p) {
      return
    }

    p.wireRespHeaders = params.headers ?? {}
    const sc = params.headers?.['set-cookie'] ?? params.headers?.['Set-Cookie']

    if (sc) {
      p.setCookie = String(sc).split('\n')

      // Journal each Set-Cookie as it arrives — even a redirect hop or a record later dropped contributes, so the
      // exact request that mints a session cookie is always traceable.
      for (const line of p.setCookie) {
        this.cookieJournal.push({ url: p.url || undefined, status: p.status, setCookie: line, kind: p.kind })
      }
    }
  }

  private onDataReceived(wcId: number, sessionId: string, params: any): void {
    const key = pendingKey(wcId, sessionId, params.requestId)
    const p = this.pending.get(key)

    if (!p || !p.streamed) {
      return
    }

    if (typeof params.data === 'string') {
      p.streamChunks.push(Buffer.from(params.data, 'base64'))
    }
  }

  private async finish(wcId: number, sessionId: string, requestId: string): Promise<void> {
    const key = pendingKey(wcId, sessionId, requestId)
    const p = this.pending.get(key)

    if (!p) {
      return
    }

    this.pending.delete(key)

    // A navigation document's raw body isn't retrievable (the renderer consumes it, the network service doesn't
    // retain it) — for the main frame AND every subframe, including a cross-origin iframe (a legacy portal view
    // embedded in an SPA). Hold the record until its frame settles, then snapshot that frame's rendered DOM.
    if (this.isSnapshotDocument(p)) {
      this.docsAwaitingHtml.set(key, p)

      return
    }

    await this.writeRecord(key, p, false)
  }

  // A navigation document (any frame, non-redirect, 2xx). getResponseBody returns nothing for these, so they're
  // captured as a rendered-DOM snapshot once their frame finishes loading (see flushDeferredDocs).
  private isSnapshotDocument(p: Pending): boolean {
    const status = p.status ?? 0

    return p.type === 'Document' && status >= 200 && status < 300
  }

  // Snapshot every deferred document whose frame has now loaded, reading each frame's OWN rendered DOM from the
  // frame tree — so a cross-origin subframe (unreadable from the top frame's JS, e.g. a framed legacy portal
  // list) is captured through Electron's frame API, which is above the same-origin policy. Fires on every page /
  // subframe load; a doc whose frame isn't present yet waits for a later load (or the stop flush). First
  // URL-matching frame wins (duplicate-URL frames are rare).
  private async flushDeferredDocs(wc: WebContents): Promise<void> {
    if (wc.isDestroyed()) {
      return
    }

    let frames: WebFrameMain[] = []

    try {
      frames = wc.mainFrame?.framesInSubtree ?? []
    } catch {
      return // frame tree gone (contents torn down mid-flush)
    }

    this.trace('>', 'flush-docs', `${this.docsAwaitingHtml.size} pending`)

    for (const [key, p] of this.docsAwaitingHtml) {
      if (p.wcId !== wc.id) {
        continue
      }

      // A frame destroyed since the subtree was read throws from its own url getter, and this runs across
      // awaits while a page tears its iframes down — so every frame is checked live before it is read, or one
      // dead frame would abort the flush and strand every document behind it.
      const frame = frames.find((f) => !f.isDestroyed() && f.url === p.url)

      if (!frame) {
        continue // its frame isn't present/loaded yet — a later load event retries
      }

      this.docsAwaitingHtml.delete(key)
      await this.writeRecord(key, p, false, await this.captureRenderedHtml(frame))
    }

    this.trace('<', 'flush-docs')
  }

  // A frame's rendered HTML (`document.documentElement.outerHTML`), DOCTYPE-prefixed, or null on failure. Post-
  // hydration DOM, not the raw response bytes — but for a server-rendered page it carries the same data an
  // HTML-scrape collector reads, and for an SPA it's strictly more (the data the client rendered in).
  private async captureRenderedHtml(frame: WebFrameMain): Promise<string | null> {
    try {
      if (frame.isDestroyed() || !this.pageTouch) {
        return null
      }

      this.trace('>', 'dom-snapshot')

      const html = await this.traced(
        'dom-snapshot',
        frame.executeJavaScript('document.documentElement ? document.documentElement.outerHTML : ""')
      )

      return typeof html === 'string' && html ? `<!DOCTYPE html>\n${html}` : null
    } catch {
      return null
    }
  }

  private async writeRecord(
    key: string,
    p: Pending,
    partialStream: boolean,
    renderedHtml?: string | null
  ): Promise<void> {
    if (!shouldCapture(p.type, p.url, this.captureAll, this.filters, p.pageUrl)) {
      return
    }

    // Lazily fetch a large POST body the inline event didn't include.
    let postData = p.postData
    let bodyTruncated = false

    if (p.hasPostData && (postData === null || postData === '')) {
      try {
        const res = await this.send(
          this.attachments.get(p.wcId)!.wc,
          'Network.getRequestPostData',
          { requestId: key.split('|').pop() },
          p.sessionId
        )

        postData = res?.postData ?? null
      } catch {
        bodyTruncated = true
      }
    }

    const graphqlOperation = extractGraphqlOperation(postData)
    const nextAction = extractNextAction(p.wireReqHeaders) ?? extractNextAction(p.requestHeaders)
    // One label for the summary/endpoint grouping: GraphQL op, else Server Action.
    const opLabel = graphqlOperation ?? (nextAction ? `action ${nextAction.slice(0, 8)}` : undefined)

    // Resolve the response body.
    let body = ''
    let base64Encoded = false
    let bodyNote: string | undefined

    if (p.streamed) {
      let buf = Buffer.concat(p.streamChunks)

      // The stream produced no bytes — either streamResourceContent isn't supported here, or a finite response
      // (routed to streaming because it advertised no Content-Length) finished before streaming engaged. Fall
      // back to a one-shot read so a retrievable body isn't lost. Skip when the run stopped mid-stream: the
      // request is still in flight and getResponseBody would only reject.
      if (buf.length === 0 && !partialStream) {
        try {
          const a = this.attachments.get(p.wcId)

          if (a) {
            const res = await this.send(
              a.wc,
              'Network.getResponseBody',
              { requestId: key.split('|').pop() },
              p.sessionId
            )

            buf = Buffer.from(res?.body ?? '', res?.base64Encoded ? 'base64' : 'utf8')
          }
        } catch {
          // in-flight or already gone — leave the body empty
        }
      }

      if (isTextLike(p.mimeType ?? '')) {
        body = buf.toString('utf8')
      } else {
        body = buf.toString('base64')
        base64Encoded = true
      }

      if (partialStream) {
        bodyNote = 'stream still open when recording stopped — body is partial'
      }
    } else if (this.isSnapshotDocument(p)) {
      // The raw navigation body isn't retrievable; the rendered DOM snapshot taken at frame-load stands in.
      if (renderedHtml) {
        body = renderedHtml
        bodyNote =
          'rendered DOM snapshot (document.documentElement.outerHTML after load) — the browser does not retain the raw navigation-document response body for retrieval'
      } else {
        bodyNote = 'document body unavailable — the frame did not settle for a DOM snapshot before the run ended'
      }
    } else if (p.status !== undefined) {
      try {
        const a = this.attachments.get(p.wcId)

        if (a) {
          const res = await this.send(a.wc, 'Network.getResponseBody', { requestId: key.split('|').pop() }, p.sessionId)

          body = res?.body ?? ''
          base64Encoded = Boolean(res?.base64Encoded)
        }
      } catch {
        bodyNote =
          'response body unavailable from the browser (served from cache, empty, or the connection closed before it was read)'
      }
    }

    if (!body && !bodyNote && p.fromDiskCache) {
      bodyNote = 'empty body — response was served from disk cache'
    }

    const rawBytes = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8')

    this.index += 1
    const idx = this.index

    const record: RecordedRequest = {
      index: idx,
      timestamp: new Date().toISOString(),
      type: p.type,
      context: {
        kind: p.kind,
        targetUrl: p.targetUrl,
        pageUrl: p.pageUrl,
        pageTitle: p.pageTitle,
        sessionId: p.sessionId || undefined
      },
      frameId: p.frameId,
      request: {
        url: p.url,
        method: p.method,
        headers: p.requestHeaders,
        body: postData,
        wireHeaders: p.wireReqHeaders,
        cookies: p.cookies,
        bodyTruncated: bodyTruncated || undefined,
        graphqlOperation,
        nextAction,
        initiator: p.initiator
      },
      response: {
        status: p.status ?? 0,
        headers: p.respHeaders ?? {},
        body,
        mimeType: p.mimeType ?? '',
        base64Encoded,
        statusText: p.statusText,
        wireHeaders: p.wireRespHeaders,
        setCookieHeaders: p.setCookie,
        bodyBytes: rawBytes.length,
        bodySha256: rawBytes.length ? sha256Hex(rawBytes) : undefined,
        remoteIPAddress: p.remoteIPAddress,
        protocol: p.protocol,
        fromDiskCache: p.fromDiskCache,
        fromServiceWorker: p.fromServiceWorker,
        streamed: p.streamed || undefined,
        bodyNote
      },
      timing: {
        requestSentMs: p.requestSentMs,
        responseReceivedMs: p.responseReceivedMs ?? Date.now(),
        durationMs: Math.max(0, Math.round((p.responseReceivedMs ?? Date.now()) - p.requestSentMs)),
        resourceTiming: p.resourceTiming
      }
    }

    try {
      await writeRequestFile(this.runDir, record)
      this.requestCount += 1
      this.countHost(p.url)
      this.tallyForSummary(p, record.response.status, opLabel)

      const download = classifyDownload(record)

      if (download) {
        this.passiveDownloads.push(download)
      }

      await appendNetworkLog(this.runDir, {
        index: idx,
        ts: record.timestamp,
        method: p.method,
        url: p.url,
        status: record.response.status,
        type: p.type,
        bytes: rawBytes.length,
        durationMs: Math.max(0, Math.round(record.timing.responseReceivedMs - p.requestSentMs)),
        context: p.kind,
        pageTitle: p.pageTitle,
        graphqlOperation,
        nextAction
      })
      this.onProgress({ requests: this.requestCount, websockets: this.webSocketCount })

      // Debug aid: stop on the first error response so the user can inspect it (the record is already
      // written above, so the triggering request is captured before we pause). Stays paused until resumed.
      if (this.autoPauseOnError && !this.paused && record.response.status >= 400) {
        this.log('warn', 'auto-pause', `Paused on HTTP ${record.response.status} — ${p.method} ${p.url}`, {
          status: record.response.status,
          method: p.method,
          url: p.url
        })
        this.setPaused(true)
      }
    } catch (err) {
      this.hadErrors = true
      this.warn('failed to write request file', err)
    }
  }

  // --- WebSockets -----------------------------------------------------------

  private onWsCreated(wcId: number, sessionId: string, params: any): void {
    const key = pendingKey(wcId, sessionId, params.requestId)

    this.wsIndex += 1
    const ctx = this.contextFor(wcId, sessionId)

    this.wsPending.set(key, {
      index: this.wsIndex,
      wcId,
      sessionId,
      kind: ctx.kind,
      ws: {
        index: this.wsIndex,
        url: params.url ?? '',
        context: ctx,
        openedAt: new Date().toISOString(),
        frames: []
      }
    })
  }

  private withWs(wcId: number, sessionId: string, requestId: string, fn: (w: WsPending) => void): void {
    const w = this.wsPending.get(pendingKey(wcId, sessionId, requestId))

    if (w) {
      fn(w)
    }
  }

  private onWsFrame(wcId: number, sessionId: string, params: any, direction: 'sent' | 'received'): void {
    this.withWs(wcId, sessionId, params.requestId, (w) => {
      const opcode = params.response?.opcode ?? 1

      w.ws.frames.push({
        ts: new Date().toISOString(),
        direction,
        opcode,
        payload: params.response?.payloadData ?? '',
        base64Encoded: opcode === 2
      })
    })
  }

  private async finishWebSocket(key: string): Promise<void> {
    const w = this.wsPending.get(key)

    if (!w) {
      return
    }

    this.wsPending.delete(key)

    if (!w.ws.closedAt) {
      w.ws.closedAt = new Date().toISOString()
    }

    try {
      await writeWebSocketFile(this.runDir, w.ws)
      this.webSocketCount += 1
      this.onProgress({ requests: this.requestCount, websockets: this.webSocketCount })
    } catch (err) {
      this.hadErrors = true
      this.warn('failed to write websocket file', err)
    }
  }

  // --- navigation side channels --------------------------------------------

  private onNavigate(wc: WebContents, kind: ContextKind, url: string): void {
    this.navigationCount += 1

    try {
      this.origins.add(new URL(url).origin)
    } catch {
      // ignore non-http urls
    }

    const a = this.attachments.get(wc.id)
    let title = ''

    try {
      title = wc.getTitle()
    } catch {
      // title unavailable
    }

    if (a) {
      a.currentUrl = url

      if (title) {
        a.currentTitle = title
      }
    }

    if (kind === 'page' || kind === 'popup') {
      this.pages.set(url, a?.currentTitle ?? title)
      this.log('info', 'navigate', url, { context: kind, title: a?.currentTitle ?? title })

      // Screenshots (and their nav-log entry, which names the screenshot file) only happen while capturing.
      // capturePage() forces GPU frames that churn WebGL contexts and can break a paused page's
      // browser-verification challenge, so a paused page is left untouched.
      if (!this.paused) {
        this.captureScreenshot(wc, url, this.navigationCount)
        void appendNavigationLog(this.runDir, {
          index: this.navigationCount,
          ts: new Date().toISOString(),
          url,
          title: a?.currentTitle ?? title,
          screenshot: screenshotFileName(this.navigationCount, url),
          context: kind
        }).catch((err) => this.warn('navigation log failed', err))
      }
    }
  }

  private onWillNavigate(wc: WebContents): void {
    // The storage snapshot runs executeJavaScript in the page — a capture artifact, so it's suppressed while
    // paused to keep the page untouched (see the paused-field contract).
    if (this.paused) {
      return
    }

    try {
      const fromOrigin = new URL(wc.getURL()).origin

      void this.snapshotOrigin(wc, fromOrigin)
    } catch {
      // ignore
    }
  }

  // Best-effort navigation screenshots, coalesced to one capture at a time. A busy SPA (a bank login
  // flow) fires did-navigate-in-page faster than the GPU compositor can produce a frame; letting each
  // navigation start its own capturePage() piles overlapping captures onto the viz service, which then
  // returns UnknownVizError and can wedge or crash the GPU process (taking the app down). So a request
  // arriving while a capture is in flight just replaces the queued one — only the latest navigation in a
  // burst is screenshotted, and never more than one capture runs at once.
  private captureScreenshot(wc: WebContents, url: string, index: number): void {
    if (this.screenshotsDisabled || !this.pageTouch) {
      return
    }

    this.screenshotQueued = { wc, url, index }

    if (!this.screenshotBusy) {
      void this.drainScreenshots()
    }
  }

  private async drainScreenshots(): Promise<void> {
    this.screenshotBusy = true

    try {
      while (this.screenshotQueued && !this.screenshotsDisabled) {
        const { wc, url, index } = this.screenshotQueued

        this.screenshotQueued = null

        if (wc.isDestroyed()) {
          continue
        }

        try {
          this.trace('>', 'capture-page', url)

          const image = await this.traced('capture-page', wc.capturePage())

          await writeScreenshot(this.runDir, index, url, image.toPNG())
        } catch (err) {
          // A failed capturePage means the compositor refused a frame (UnknownVizError). Repeating the capture
          // drives it further into "GPU state invalid" and crashes the GPU process, so the first failure
          // disables screenshots for the rest of the run: never give a wedged compositor a second capture. The
          // recording (network/storage) is unaffected — screenshots are best-effort.
          this.screenshotsDisabled = true
          this.screenshotQueued = null
          this.warn('screenshots disabled for this run after a capture failure', err)
        }
      }
    } finally {
      this.screenshotBusy = false
    }
  }

  private async snapshotOrigin(wc: WebContents, origin: string): Promise<void> {
    try {
      if (wc.isDestroyed() || !this.pageTouch) {
        return
      }

      this.trace('>', 'storage-snapshot', origin)
      const result = (await this.traced(
        'storage-snapshot',
        wc.executeJavaScript(
          `(() => {
          if (location.origin !== ${JSON.stringify(origin)}) return null
          return {
            localStorage: Object.fromEntries(Object.entries(localStorage)),
            sessionStorage: Object.fromEntries(Object.entries(sessionStorage))
          }
        })()`
        )
      )) as { localStorage: Record<string, string>; sessionStorage: Record<string, string> } | null

      if (result) {
        this.storageSnapshots.set(origin, result)
      }
    } catch {
      // origin not currently loaded / worker context — skip
    }
  }

  private async dumpStorage(): Promise<void> {
    for (const a of this.attachments.values()) {
      if (a.kind !== 'page' && a.kind !== 'popup') {
        continue
      }

      try {
        const origin = new URL(a.wc.getURL()).origin

        await this.snapshotOrigin(a.wc, origin)
      } catch {
        // ignore
      }
    }

    const snapshot: Record<string, unknown> = {}

    for (const [origin, data] of this.storageSnapshots) {
      snapshot[origin] = data
    }

    try {
      await writeStorageSnapshot(this.runDir, snapshot)
    } catch (err) {
      this.warn('storage dump failed', err)
    }
  }

  private async snapshotStartCookies(): Promise<void> {
    if (!this.session) {
      return
    }

    try {
      this.cookiesAtStart = (await this.session.cookies.get({})).map((c) => ({
        name: c.name,
        domain: c.domain,
        path: c.path
      }))
    } catch (err) {
      this.warn('start cookie snapshot failed', err)
    }
  }

  private async dumpCookies(): Promise<void> {
    if (!this.session) {
      return
    }

    try {
      const cookies = await this.session.cookies.get({})
      const visitedHosts = new Set<string>()

      for (const origin of this.origins) {
        try {
          visitedHosts.add(new URL(origin).hostname)
        } catch {
          // skip
        }
      }

      const filtered = cookies.filter((c) => {
        const dom = c.domain?.replace(/^\./, '') ?? ''

        if (!dom) {
          return false
        }

        for (const host of visitedHosts) {
          if (host === dom || host.endsWith(`.${dom}`)) {
            return true
          }
        }

        return false
      })

      await writeCookies(this.runDir, filtered)
    } catch (err) {
      this.warn('cookie dump failed', err)
    }
  }

  private countHost(url: string): void {
    try {
      const host = new URL(url).host

      this.hostCounts[host] = (this.hostCounts[host] ?? 0) + 1
    } catch {
      // ignore
    }
  }

  // A browser-native download: save it straight into the run's downloads/ dir (no Save dialog) and record it as
  // a native-navigation download (the shape a plugin must reproduce with ctx.browser, not a headless fetch). On
  // completion `onDownload` fires so the UI can confirm what was saved and where — otherwise a headless save
  // looks like nothing happened. Skipped while paused so an exploratory-click download isn't recorded.
  private onWillDownload = (_e: unknown, item: DownloadItem): void => {
    if (this.paused) {
      return
    }

    this.downloadIndex += 1
    const idx = this.downloadIndex
    const url = item.getURL()
    const filename = item.getFilename() || undefined
    const safeName = (filename || `download-${idx}`).replace(/[^\w.-]+/g, '_')
    const rel = `downloads/${String(idx).padStart(4, '0')}_${safeName}`

    try {
      mkdirSync(join(this.runDir, 'downloads'), { recursive: true })
      item.setSavePath(join(this.runDir, rel))
    } catch (err) {
      this.warn('download save-path failed', err)
    }

    item.once('done', (_ev, state) => {
      const mime = item.getMimeType() || undefined
      const bytes = item.getReceivedBytes() || undefined
      const savedAs = state === 'completed' ? rel : null

      this.nativeDownloads.push({
        mechanism: 'native-navigation',
        confidence: 'high',
        origin: 'native',
        request: { url, method: 'GET', initiator: 'navigation' },
        response: {
          mime,
          filename,
          bytes,
          pdfConfirmed: /pdf/i.test(mime ?? '') || /\.pdf$/i.test(filename ?? ''),
          looksSigned: /expir|signature|x-amz-|token|jeton/i.test(url)
        },
        sourceFile: null,
        savedAs
      })
      this.log('info', 'download', `Captured browser download — ${filename ?? url} (${state})`, { url, state })

      if (savedAs) {
        this.onDownload?.({ filename, bytes, savedAs })
      }
    })
  }

  private tallyForSummary(p: Pending, status: number, opLabel?: string): void {
    this.typeCounts[p.type] = (this.typeCounts[p.type] ?? 0) + 1

    if (p.type !== 'XHR' && p.type !== 'Fetch' && p.type !== 'EventSource') {
      return
    }

    try {
      const u = new URL(p.url)
      const suffix = opLabel ? ` (${opLabel})` : ''
      const key = `${p.method} ${u.host}${u.pathname}${suffix}`
      const e = this.endpoints.get(key)

      if (e) {
        e.count += 1
        e.lastStatus = status
      } else if (this.endpoints.size < 300) {
        this.endpoints.set(key, { count: 1, lastStatus: status })
      }
    } catch {
      // ignore unparseable url
    }
  }

  // A prominent, up-front list of downloadable documents (PDF invoices/statements) and the mechanism each maps
  // to — the thing that's otherwise slow to dig out when writing a plugin's files/fetchFile. Empty ⇒ no section.
  private buildDownloadsSection(): string[] {
    if (!this.downloads.length) {
      return []
    }

    const lines = [
      '## Detected downloads',
      '',
      `${this.downloads.length} downloadable document(s). Full detail in \`downloads.json\`.`,
      ''
    ]

    for (const d of this.downloads) {
      const parts = [`**${d.mechanism}** (${d.confidence})`, `${d.request.method} ${d.request.url}`]

      if (d.request.accept) {
        parts.push(`Accept: ${d.request.accept}`)
      }

      if (d.response.filename || d.response.bytes) {
        parts.push(
          [d.response.filename, d.response.bytes ? `${d.response.bytes} bytes` : null].filter(Boolean).join(' · ')
        )
      }

      lines.push(`- ${parts.join(' — ')}`)

      const notes = [
        d.request.referer ? `referer: ${d.request.referer}` : null,
        d.response.looksSigned ? 'one-time/signed URL — mint at download time' : null,
        d.mechanism === 'native-navigation' ? 'browser navigation download — replay with ctx.browser' : null,
        d.savedAs ? `saved: ${d.savedAs}` : null,
        d.sourceFile ? `source: ${d.sourceFile}` : null
      ].filter(Boolean)

      for (const note of notes) {
        lines.push(`  - ${note}`)
      }
    }

    lines.push('')

    return lines
  }

  // Every Set-Cookie the run observed, in order — the session cookies (SESSION/JSESSIONID/auth) first, so the
  // request that mints a stateful-portal session is obvious. A session-like cookie present at start but never Set
  // here is flagged as pre-existing: its mint can't be seen without re-recording with it cleared.
  private buildCookieJournalSection(): string[] {
    const name = (line: string): string => line.split('=', 1)[0]!.trim()
    const sessionLike = (n: string): boolean => /session|jsessionid|auth|token|sso/i.test(n)
    const mintedNames = new Set(this.cookieJournal.map((c) => name(c.setCookie)))
    const preExisting = this.cookiesAtStart.filter((c) => sessionLike(c.name) && !mintedNames.has(c.name))

    if (!this.cookieJournal.length && !preExisting.length) {
      return []
    }

    const lines = ['## Set-Cookie journal (session establishment)', '']

    if (preExisting.length) {
      lines.push(
        '⚠ **Pre-existing session cookies** — present when recording began, NOT minted during this run, so their establishment is NOT captured. To see how each is minted, clear it and re-record:',
        ...preExisting.map((c) => `- **${c.name}** (${c.domain ?? '?'}; ${c.path ?? '/'})`),
        ''
      )
    }

    if (this.cookieJournal.length) {
      const ordered = [...this.cookieJournal].sort(
        (a, b) => Number(sessionLike(name(b.setCookie))) - Number(sessionLike(name(a.setCookie)))
      )

      lines.push(
        `${this.cookieJournal.length} Set-Cookie(s) observed, session-like names first. Detail in \`cookie-journal.json\`.`,
        ''
      )

      for (const c of ordered.slice(0, 60)) {
        const attrs = c.setCookie
          .slice(name(c.setCookie).length)
          .replace(/^=[^;]*/, '')
          .trim()

        lines.push(`- **${name(c.setCookie)}** ${attrs} — ${c.status ?? '?'} ${c.url ?? '(pending)'} [${c.kind}]`)
      }

      lines.push('')
    }

    return lines
  }

  private buildSummaryMarkdown(manifest: RecordingManifest): string {
    const lines: string[] = [`# ${manifest.label} — Butin Recorder run summary`, '']

    lines.push(`- Recorded: ${manifest.startedAt} → ${manifest.endedAt}`)
    lines.push(
      `- Requests: ${manifest.requestCount} · WebSockets: ${manifest.webSocketCount ?? 0} · Navigations: ${manifest.navigationCount}`
    )
    lines.push(`- Start URL: ${manifest.startUrl}`)

    if (manifest.hadErrors) {
      lines.push('- ⚠ Some capture steps errored — this run may be incomplete.')
    }

    lines.push('', 'Read `AGENTS.md` in this folder for how to interpret the files.', '')

    lines.push(...this.buildDownloadsSection())
    lines.push(...this.buildCookieJournalSection())

    if (this.pages.size) {
      lines.push('## Pages visited', '')

      for (const [url, title] of this.pages) {
        lines.push(`- ${title || '(untitled)'} — ${url}`)
      }

      lines.push('')
    }

    const hosts = Object.entries(this.hostCounts).sort((a, b) => b[1] - a[1])

    if (hosts.length) {
      lines.push('## API hosts (requests per host)', '')

      for (const [host, n] of hosts.slice(0, 30)) {
        lines.push(`- ${host} — ${n}`)
      }

      lines.push('')
    }

    const endpoints = [...this.endpoints.entries()].sort((a, b) => b[1].count - a[1].count)

    if (endpoints.length) {
      lines.push('## Endpoints (XHR / Fetch / SSE)', '')

      for (const [key, e] of endpoints.slice(0, 50)) {
        lines.push(`- ${key} — ${e.count}× (last ${e.lastStatus})`)
      }

      lines.push('')
    }

    const types = Object.entries(this.typeCounts).sort((a, b) => b[1] - a[1])

    if (types.length) {
      lines.push('## Resource types', '')

      for (const [t, n] of types) {
        lines.push(`- ${t}: ${n}`)
      }

      lines.push('')
    }

    return lines.join('\n')
  }

  /** Close a trace span when `work` settles, however it settles — so an unmatched '>' always means a real hang. */
  private traced<T>(action: string, work: Promise<T>, detail?: string): Promise<T> {
    return this.tracing ? work.finally(() => this.trace('<', action, detail)) : work
  }

  /** One synchronous trace line. `dir` is '>' entering a call, '<' leaving it, '!' a one-shot event. */
  private trace(dir: '>' | '<' | '!', action: string, detail?: string): void {
    if (!this.tracing) {
      return
    }

    try {
      appendFileSync(
        join(this.runDir, 'trace.log'),
        `${Date.now()} ${dir} ${action}${detail ? ' ' + detail : ''}
`
      )
    } catch {
      // tracing must never break a run
    }
  }

  private warn(msg: string, err?: unknown): void {
    const detail = err instanceof Error ? err.message : err
    const message = detail === undefined ? msg : `${msg}: ${detail}`

    console.error(`[recorder] ${message}`)
    this.log('warn', 'warning', message)
  }

  /**
   * Emit one diagnostic log line: persist it to log.jsonl and push it to the live panel via onLog.
   * Public so the window layer can report Electron-level events (load failures) through the same trace.
   */
  log(level: LogLevel, event: string, message: string, data?: Record<string, unknown>): void {
    const line: RecorderLogLine = { ts: new Date().toISOString(), level, event, message, data }

    this.onLog?.(line)
    void appendRunLog(this.runDir, line).catch(() => {})
  }
}

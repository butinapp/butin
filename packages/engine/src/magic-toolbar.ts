import { app, clipboard, WebContentsView } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// A thin chrome strip docked above the page: Back/Forward + Reload buttons + an editable URL bar (type a
// URL and press Enter to navigate, Esc to revert) and force-captures the session when the page never settles
// on a `dashboardMarker` (e.g. GitHub drops you on its home page after a social login). Lives in its own
// WebContentsView so the page can't style over it or reach its buttons.
//
// The `variant` selects the chrome: `capture` (Magic Login) shows the readiness status + Capture button;
// `navigate` (the plugin-less navigation browser) drops the capture-specific controls; `record` (the Butin
// Recorder's capture window) swaps in a REC/elapsed/counts readout plus Pause + Stop and a record-specific
// debug panel (Auto-open DevTools, Match Chrome headers), keeping the shared nav + Freeze/Auto-pause toggles.
//
// A `Debug ▾` disclosure expands the strip into a panel for diagnosing a stuck/looping sign-in: the
// recent navigation chain (with HTTP status), the per-host cookie footprint (the thing that explains an
// ADFS "Header Field Too Long"), and controls — Freeze redirects (stop the page following navigations so
// a loop can't run away), Auto-pause on HTTP error, DevTools, and Clear-domain-cookies-&-reload. The
// panel's expanded state and the Freeze/Auto-pause toggles are remembered across opens (alongside whether
// DevTools was open); their initial values are pushed once the toolbar HTML loads.

export const TOOLBAR_HEIGHT = 48

// Height when the debug panel is open. magic-login's layout() reads `expandedHeight()` so the site view
// shrinks to make room; collapsing restores TOOLBAR_HEIGHT.
export const TOOLBAR_EXPANDED_HEIGHT = 300

// One main-frame navigation in the recent-history strip. status: an HTTP code, -1 for a redirect hop
// (no committed status), 0 for a pending/unknown one.
export type NavEntry = { status: number; url: string }

// Toolbar renderer → main. Wired per-webContents via `view.webContents.ipc`, so they never leak to the
// global ipcMain or collide with another window.
const IPC = {
  copy: 'butin-magic:copy',
  navigate: 'butin-magic:navigate',
  back: 'butin-magic:back',
  forward: 'butin-magic:forward',
  forceCapture: 'butin-magic:force-capture',
  chromeFallback: 'butin-magic:chrome-fallback',
  expand: 'butin-magic:expand',
  freeze: 'butin-magic:freeze',
  autoPause: 'butin-magic:auto-pause',
  autoCapture: 'butin-magic:auto-capture',
  devtools: 'butin-magic:devtools',
  reload: 'butin-magic:reload',
  clearCookies: 'butin-magic:clear-cookies',
  // record variant
  stop: 'butin-magic:stop',
  togglePause: 'butin-magic:toggle-pause',
  setBrowserHeaders: 'butin-magic:set-browser-headers',
  setAutoOpenDevTools: 'butin-magic:set-auto-devtools'
} as const

// contextIsolation:true keeps the toolbar's privileged bridge out of the page's main world; main→toolbar
// updates go through `executeJavaScript` (main world), which is where the inline script defines __setUrl.
const PRELOAD_SOURCE = `
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('__magic', {
  copy: (text) => ipcRenderer.send('${IPC.copy}', text),
  navigate: (url) => ipcRenderer.send('${IPC.navigate}', url),
  back: () => ipcRenderer.send('${IPC.back}'),
  forward: () => ipcRenderer.send('${IPC.forward}'),
  forceCapture: () => ipcRenderer.send('${IPC.forceCapture}'),
  chromeFallback: () => ipcRenderer.send('${IPC.chromeFallback}'),
  setExpanded: (on) => ipcRenderer.send('${IPC.expand}', on),
  setFreeze: (on) => ipcRenderer.send('${IPC.freeze}', on),
  setAutoPause: (on) => ipcRenderer.send('${IPC.autoPause}', on),
  setAutoCapture: (on) => ipcRenderer.send('${IPC.autoCapture}', on),
  openDevTools: () => ipcRenderer.send('${IPC.devtools}'),
  reload: () => ipcRenderer.send('${IPC.reload}'),
  clearCookies: () => ipcRenderer.send('${IPC.clearCookies}'),
  stop: () => ipcRenderer.send('${IPC.stop}'),
  togglePause: () => ipcRenderer.send('${IPC.togglePause}'),
  setBrowserHeaders: (on) => ipcRenderer.send('${IPC.setBrowserHeaders}', on),
  setAutoOpenDevTools: (on) => ipcRenderer.send('${IPC.setAutoOpenDevTools}', on)
})
`

const HTML_SOURCE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      :root { color-scheme: dark }
      * { box-sizing: border-box }
      html, body { margin: 0; height: 100% }
      body {
        display: flex; flex-direction: column; align-items: stretch;
        background: #18181b; color: #e4e4e7;
        font: 12px/1.4 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
        user-select: none;
      }
      #bar { display: flex; align-items: center; gap: 8px; height: 48px; flex: none; padding: 0 12px }
      #url {
        flex: 1 1 auto; min-width: 0; padding: 6px 10px; border-radius: 6px; user-select: text;
        border: 1px solid #3f3f46; background: #0f0f11; color: #e4e4e7; outline: none;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      #url:focus { border-color: #52525b }
      #copied { flex: none; color: #4ade80; font-weight: 500; opacity: 0; transition: opacity .12s; white-space: nowrap }
      body.copied #copied { opacity: 1 }
      #warn { flex: 0 1 auto; color: #fbbf24; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
      #status {
        flex: none; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
        font-weight: 500; color: #a1a1aa;
      }
      #status::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor }
      #status[data-tone="ready"] { color: #4ade80 }
      #status[data-tone="waiting"] { color: #a1a1aa }
      #status:empty { display: none }
      button {
        flex: none; cursor: pointer; border-radius: 6px; padding: 6px 12px; font: inherit; font-weight: 500;
        border: 1px solid #3f3f46; background: #27272a; color: #e4e4e7;
      }
      button:hover:not(:disabled) { background: #3f3f46 }
      button:disabled { opacity: .35; cursor: default }
      #back, #fwd, #reload { padding: 6px 10px; font-size: 15px; line-height: 1 }
      #capture { border-color: #15803d; background: #166534; color: #f0fdf4 }
      #capture:hover { background: #15803d }
      /* Shown only when a sign-in blocks the built-in browser (e.g. Google's "may not be secure"). */
      #chrome { display: none; border-color: #1d4ed8; background: #1e40af; color: #eff6ff }
      #chrome:hover:not(:disabled) { background: #1d4ed8 }
      #debug[aria-expanded="true"] { background: #3f3f46 }

      /* Navigate variant: a plugin-less browser on the shared session, so the capture-specific chrome is gone. */
      body.navigate #capture,
      body.navigate #status,
      body.navigate #autocapture-row,
      body.navigate #footprint-section,
      body.navigate #clear { display: none }

      /* Record variant (Butin Recorder capture window): swap the capture chrome for a REC/elapsed/counts
         readout plus Pause + Stop, and a record-specific debug panel. */
      #all, #recmeta, #pause, #stop, #autodevtools-row, #browser-headers-row { display: none }
      body.record #all { display: inline-block }
      body.record #recmeta { display: inline-flex }
      body.record #pause, body.record #stop { display: inline-block }
      body.record #autodevtools-row, body.record #browser-headers-row { display: inline-flex }
      body.record #capture, body.record #chrome, body.record #autocapture-row,
      body.record #footprint-section, body.record #history-section, body.record #clear,
      body.record #devtools { display: none }
      #all {
        flex: none; background: #3f3f46; color: #e4e4e7; padding: 2px 7px; border-radius: 4px;
        font-size: 11px; font-weight: 600; letter-spacing: .4px;
      }
      #recmeta {
        flex: none; align-items: center; gap: 8px; white-space: nowrap; color: #a1a1aa;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
      }
      #stop { border-color: #b91c1c; background: #991b1b; color: #fef2f2 }
      #stop:hover:not(:disabled) { background: #b91c1c }
      #status[data-tone="rec"] { color: #f87171 }
      #status[data-tone="rec"]::before { animation: recpulse 1.6s ease-in-out infinite }
      #status[data-tone="paused"] { color: #fbbf24 }
      @keyframes recpulse { 50% { opacity: .25 } }
      @media (prefers-reduced-motion: reduce) { #status[data-tone="rec"]::before { animation: none } }

      #panel {
        display: none; flex: 1 1 auto; flex-direction: column; gap: 10px; padding: 10px 12px;
        border-top: 1px solid #27272a; overflow: auto;
      }
      body.expanded #panel { display: flex }
      #controls { display: flex; align-items: center; gap: 14px; flex-wrap: wrap }
      label.chk { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; color: #d4d4d8 }
      #panel h4 {
        margin: 0 0 4px; font-size: 11px; font-weight: 600; text-transform: uppercase;
        letter-spacing: .04em; color: #71717a;
      }
      #footprint {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #a1a1aa;
        white-space: pre-wrap; word-break: break-all;
      }
      #footprint.over { color: #f87171 }
      #history {
        display: flex; flex-direction: column; gap: 3px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
      }
      .h-row { display: flex; gap: 8px; align-items: baseline }
      .h-status { flex: none; width: 38px; text-align: right; color: #71717a }
      .h-status.err { color: #f87171; font-weight: 600 }
      .h-url { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d4d4d8; cursor: pointer }
      .h-url:hover { color: #fff }
      .muted { color: #71717a }
    </style>
  </head>
  <body>
    <div id="bar">
      <button id="back" title="Back" disabled>‹</button>
      <button id="fwd" title="Forward" disabled>›</button>
      <button id="reload" title="Reload">⟳</button>
      <input id="url" type="text" spellcheck="false" autocomplete="off" placeholder="Enter a URL and press Enter" />
      <span id="copied">Copied ✓</span>
      <span id="warn"></span>
      <span id="status"></span>
      <span id="recmeta"></span>
      <span id="all">ALL</span>
      <button id="debug" aria-expanded="false">Debug ▾</button>
      <button id="chrome">Sign in with Chrome</button>
      <button id="capture">Capture session</button>
      <button id="pause">Pause</button>
      <button id="stop">Stop &amp; save</button>
    </div>
    <div id="panel">
      <div id="controls">
        <label class="chk" id="autocapture-row"><input type="checkbox" id="autocapture" /> Auto-capture when ready</label>
        <label class="chk"><input type="checkbox" id="freeze" /> Freeze redirects</label>
        <label class="chk"><input type="checkbox" id="autopause" /> Auto-pause on HTTP error</label>
        <label class="chk" id="autodevtools-row"><input type="checkbox" id="autodevtools" /> Auto-open DevTools</label>
        <label class="chk" id="browser-headers-row"><input type="checkbox" id="browser-headers" /> Match Chrome headers</label>
        <button id="devtools">DevTools</button>
        <button id="clear">Clear domain cookies &amp; reload</button>
      </div>
      <div id="footprint-section">
        <h4>Cookie footprint</h4>
        <div id="footprint" class="muted">(waiting for first navigation)</div>
      </div>
      <div id="history-section">
        <h4>Recent navigations</h4>
        <div id="history" class="muted">(none yet)</div>
      </div>
    </div>
    <script>
      var current = ''
      var urlEl = document.getElementById('url')
      var backBtn = document.getElementById('back')
      var fwdBtn = document.getElementById('fwd')
      var warnEl = document.getElementById('warn')
      var statusEl = document.getElementById('status')
      var debugBtn = document.getElementById('debug')
      var footprintEl = document.getElementById('footprint')
      var historyEl = document.getElementById('history')
      var freezeCb = document.getElementById('freeze')
      var autoPauseCb = document.getElementById('autopause')
      var autoCaptureCb = document.getElementById('autocapture')
      var copiedTimer = null

      // Copy a URL to the clipboard and flash the "Copied ✓" hint. Shared by the live URL and the
      // Debug panel's history rows — anything showing a URL is click-to-copy.
      function copyUrl(u) {
        if (!u) return
        window.__magic.copy(u)
        document.body.classList.add('copied')
        clearTimeout(copiedTimer)
        copiedTimer = setTimeout(function () { document.body.classList.remove('copied') }, 1200)
      }

      // Reflect the live URL, but never clobber what the user is mid-typing — only sync the input value when
      // it isn't focused.
      window.__setUrl = function (u) {
        current = u || ''
        if (document.activeElement !== urlEl) { urlEl.value = current }
      }
      window.__setNav = function (canBack, canFwd) { backBtn.disabled = !canBack; fwdBtn.disabled = !canFwd }
      window.__setWarning = function (m) { warnEl.textContent = m || '' }
      window.__setStatus = function (text, tone) {
        statusEl.textContent = text || ''
        if (tone) { statusEl.setAttribute('data-tone', tone) } else { statusEl.removeAttribute('data-tone') }
      }
      window.__setFootprint = function (text, over) {
        footprintEl.classList.remove('muted')
        footprintEl.textContent = text || ''
        if (over) { footprintEl.classList.add('over') } else { footprintEl.classList.remove('over') }
      }
      window.__setHistory = function (entries) {
        if (!entries || !entries.length) { historyEl.className = 'muted'; historyEl.textContent = '(none yet)'; return }
        historyEl.className = ''
        historyEl.textContent = ''
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i]
          var row = document.createElement('div'); row.className = 'h-row'
          var st = document.createElement('span'); st.className = 'h-status'
          var code = e.status
          if (code === -1) { st.textContent = '↪' }
          else if (code >= 400) { st.textContent = String(code); st.className += ' err' }
          else if (code > 0) { st.textContent = String(code) }
          else { st.textContent = '·' }
          var u = document.createElement('span'); u.className = 'h-url'; u.textContent = e.url
          u.title = 'Click to copy'
          ;(function (url) { u.addEventListener('click', function () { copyUrl(url) }) })(e.url)
          row.appendChild(st); row.appendChild(u); historyEl.appendChild(row)
        }
      }
      window.__setFrozen = function (on) { freezeCb.checked = !!on }
      window.__setAutoPause = function (on) { autoPauseCb.checked = !!on }
      window.__setAutoCapture = function (on) { autoCaptureCb.checked = !!on }
      window.__setCaptureLabel = function (text) {
        document.getElementById('capture').textContent = text || 'Capture session'
      }

      // Drop the capture-specific chrome for the plugin-less navigation browser (no session to capture), or
      // swap in the recorder's REC chrome for the 'record' variant.
      window.__setVariant = function (v) {
        document.body.classList.toggle('navigate', v === 'navigate')
        document.body.classList.toggle('record', v === 'record')
      }

      // Reveal the "Sign in with Chrome" button when the page blocks the built-in browser.
      window.__setChromeFallback = function (on) {
        document.getElementById('chrome').style.display = on ? 'inline-block' : 'none'
      }

      // Reflect the remembered Debug-panel state without firing setExpanded back to main (main already knows
      // the initial value and has sized the site view for it).
      window.__setExpanded = function (on) {
        document.body.classList.toggle('expanded', !!on)
        debugBtn.setAttribute('aria-expanded', on ? 'true' : 'false')
        debugBtn.textContent = on ? 'Debug ▴' : 'Debug ▾'
      }

      // Enter navigates to the typed URL; Esc reverts the field to the live URL and drops focus.
      urlEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { window.__magic.navigate(urlEl.value) }
        else if (e.key === 'Escape') { urlEl.value = current; urlEl.blur() }
      })
      backBtn.addEventListener('click', function () { window.__magic.back() })
      fwdBtn.addEventListener('click', function () { window.__magic.forward() })
      document.getElementById('capture').addEventListener('click', function () { window.__magic.forceCapture() })
      document.getElementById('chrome').addEventListener('click', function () { window.__magic.chromeFallback() })
      debugBtn.addEventListener('click', function () {
        var on = !document.body.classList.contains('expanded')
        window.__setExpanded(on)
        window.__magic.setExpanded(on)
      })
      freezeCb.addEventListener('change', function () { window.__magic.setFreeze(freezeCb.checked) })
      autoPauseCb.addEventListener('change', function () { window.__magic.setAutoPause(autoPauseCb.checked) })
      autoCaptureCb.addEventListener('change', function () { window.__magic.setAutoCapture(autoCaptureCb.checked) })
      document.getElementById('devtools').addEventListener('click', function () { window.__magic.openDevTools() })
      document.getElementById('reload').addEventListener('click', function () { window.__magic.reload() })
      document.getElementById('clear').addEventListener('click', function () {
        var b = document.getElementById('clear'); var prev = b.textContent
        b.textContent = 'Clearing…'; window.__magic.clearCookies()
        setTimeout(function () { b.textContent = prev }, 1500)
      })

      // ---- record variant: REC status, elapsed timer, request counts, Pause/Stop, record toggles ----
      var recmetaEl = document.getElementById('recmeta')
      var allEl = document.getElementById('all')
      var pauseBtn = document.getElementById('pause')
      var browserHeadersCb = document.getElementById('browser-headers')
      var autoDevtoolsCb = document.getElementById('autodevtools')
      var reqCount = 0, wsCount = 0, elapsedMs = 0, recRunning = false, lastTick = Date.now()

      function fmtElapsed(ms) {
        var total = Math.floor(ms / 1000)
        var h = Math.floor(total / 3600)
        var mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
        var ss = String(total % 60).padStart(2, '0')
        return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss
      }
      function renderRecMeta() {
        recmetaEl.textContent = fmtElapsed(elapsedMs) + ' · ' + reqCount + ' req' + (reqCount === 1 ? '' : 's') +
          ' · ' + wsCount + ' ws'
      }
      // Elapsed advances only while actively recording (frozen while paused), like a camera timer.
      setInterval(function () {
        var now = Date.now()
        if (recRunning) { elapsedMs += now - lastTick }
        lastTick = now
        if (document.body.classList.contains('record')) { renderRecMeta() }
      }, 250)

      window.__setCounts = function (req, ws) {
        reqCount = req || 0; wsCount = typeof ws === 'number' ? ws : wsCount; renderRecMeta()
      }
      window.__setPaused = function (paused) {
        recRunning = !paused; lastTick = Date.now()
        window.__setStatus(paused ? 'PAUSED' : 'REC', paused ? 'paused' : 'rec')
        pauseBtn.textContent = paused ? 'Resume' : 'Pause'
      }
      window.__setCaptureAll = function (on) { allEl.style.display = on ? 'inline-block' : 'none' }
      window.__setBrowserHeaders = function (on) { browserHeadersCb.checked = !!on }
      window.__setAutoOpenDevTools = function (on) { autoDevtoolsCb.checked = !!on }

      pauseBtn.addEventListener('click', function () { window.__magic.togglePause() })
      document.getElementById('stop').addEventListener('click', function () { window.__magic.stop() })
      browserHeadersCb.addEventListener('change', function () { window.__magic.setBrowserHeaders(browserHeadersCb.checked) })
      autoDevtoolsCb.addEventListener('change', function () { window.__magic.setAutoOpenDevTools(autoDevtoolsCb.checked) })
    </script>
  </body>
</html>`

let cached: { htmlUrl: string; preloadPath: string } | null = null

// Write the toolbar's HTML + preload to a stable userData path once and reuse them — bundler-agnostic,
// so it works in dev, a built main, and a packaged app.
const ensureFiles = (): { htmlUrl: string; preloadPath: string } => {
  if (!cached) {
    const htmlPath = join(app.getPath('userData'), 'butin-magic-toolbar.html')
    const preloadPath = join(app.getPath('userData'), 'butin-magic-toolbar.cjs')

    writeFileSync(htmlPath, HTML_SOURCE)
    writeFileSync(preloadPath, PRELOAD_SOURCE)
    cached = { htmlUrl: pathToFileURL(htmlPath).toString(), preloadPath }
  }

  return cached
}

// The status indicator's tone: capture readiness (ready/waiting) or the recorder's REC/paused state.
export type ToolbarStatus = { text: string; tone: 'ready' | 'waiting' | 'rec' | 'paused' }

export interface MagicToolbar {
  view: WebContentsView
  setUrl: (url: string) => void
  setNav: (canBack: boolean, canForward: boolean) => void
  setWarning: (msg: string) => void
  setStatus: (status: ToolbarStatus) => void
  setHistory: (entries: NavEntry[]) => void
  setFootprint: (text: string, over: boolean) => void
  setFrozen: (on: boolean) => void
  // Relabel the capture button — used to turn it into a "Done" close action after an incomplete capture.
  setCaptureLabel: (text: string) => void
  // Reveal/hide the "Sign in with Chrome" button — shown when the page blocks the built-in browser.
  setChromeFallback: (on: boolean) => void
  // --- record variant ---
  // Update the live request / WebSocket counts in the REC readout.
  setCounts: (requests: number, websockets: number) => void
  // Reflect the paused state: toggles the REC/PAUSED badge and freezes/resumes the elapsed timer.
  setPaused: (paused: boolean) => void
  // Show/hide the "ALL" badge (capture-everything mode).
  setCaptureAll: (on: boolean) => void
}

export interface MagicToolbarOpts {
  // Capture-variant callbacks (Magic Login) — optional so the navigate/record variants can omit them.
  onForceCapture?: () => void
  // Clicked when the page blocks the built-in browser — hands off to a real-Chrome sign-in. Capture flow only.
  onChromeFallback?: () => void
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onSetExpanded: (on: boolean) => void
  onSetFreeze: (on: boolean) => void
  onSetAutoPause: (on: boolean) => void
  // Toggle auto-capture for the live window: when off, the page never captures on its own — only an explicit
  // Capture click does. Persisted globally so it mirrors the app Settings' manual-capture toggle.
  onSetAutoCapture?: (on: boolean) => void
  onOpenDevTools?: () => void
  onReload: () => void
  onClearCookies?: () => void
  // --- record variant callbacks ---
  onStop?: () => void
  onTogglePause?: () => void
  onSetBrowserHeaders?: (on: boolean) => void
  onSetAutoOpenDevTools?: (on: boolean) => void
  // Remembered control state, pushed once the toolbar HTML loads so the panel/checkboxes open matching the
  // last session.
  initialFreeze?: boolean
  initialAutoPause?: boolean
  initialAutoCapture?: boolean
  initialDebugExpanded?: boolean
  // record-variant initial state.
  initialBrowserHeaders?: boolean
  initialAutoOpenDevTools?: boolean
  initialCaptureAll?: boolean
  // Initial paused state — drives the first REC/PAUSED badge (record variant only).
  initialPaused?: boolean
  // 'navigate' drops the capture chrome (Capture button, readiness status, auto-capture, footprint,
  // clear-cookies) for the plugin-less navigation browser; 'record' swaps in the recorder's REC chrome;
  // 'capture' (default) is the full Magic Login toolbar.
  variant?: 'capture' | 'navigate' | 'record'
}

// Build the toolbar view, wire its controls (click-a-URL → Electron clipboard, Capture → onForceCapture,
// plus the debug-panel controls), and hand back push helpers. `setUrl` is buffered until the toolbar HTML has
// loaded so an early call from the first navigation isn't lost; the live-update pushes (history /
// footprint / frozen) all fire after the first navigation, well past load.
export const createMagicToolbar = (opts: MagicToolbarOpts): MagicToolbar => {
  const { htmlUrl, preloadPath } = ensureFiles()
  const view = new WebContentsView({ webPreferences: { preload: preloadPath, contextIsolation: true, sandbox: true } })

  let loaded = false
  let lastUrl = ''

  const exec = (code: string): void => void view.webContents.executeJavaScript(code).catch(() => {})
  const apply = (): void => exec(`window.__setUrl(${JSON.stringify(lastUrl)})`)

  view.webContents.on('did-finish-load', () => {
    loaded = true
    apply()
    exec(`window.__setFrozen(${JSON.stringify(Boolean(opts.initialFreeze))})`)
    exec(`window.__setAutoPause(${JSON.stringify(Boolean(opts.initialAutoPause))})`)
    exec(`window.__setAutoCapture(${JSON.stringify(Boolean(opts.initialAutoCapture))})`)
    exec(`window.__setExpanded(${JSON.stringify(Boolean(opts.initialDebugExpanded))})`)
    exec(`window.__setVariant(${JSON.stringify(opts.variant ?? 'capture')})`)
    // record-variant initial state.
    exec(`window.__setBrowserHeaders(${JSON.stringify(Boolean(opts.initialBrowserHeaders))})`)
    exec(`window.__setAutoOpenDevTools(${JSON.stringify(Boolean(opts.initialAutoOpenDevTools))})`)
    exec(`window.__setCaptureAll(${JSON.stringify(Boolean(opts.initialCaptureAll))})`)

    // Seed the REC/PAUSED badge for the record variant (other variants drive #status via setStatus).
    if ((opts.variant ?? 'capture') === 'record') {
      exec(`window.__setPaused(${JSON.stringify(Boolean(opts.initialPaused))})`)
    }
  })

  view.webContents.ipc.on(IPC.copy, (_e, text: unknown) => clipboard.writeText(String(text ?? '')))
  view.webContents.ipc.on(IPC.navigate, (_e, url: unknown) => opts.onNavigate(String(url ?? '')))
  view.webContents.ipc.on(IPC.back, () => opts.onBack())
  view.webContents.ipc.on(IPC.forward, () => opts.onForward())
  view.webContents.ipc.on(IPC.forceCapture, () => opts.onForceCapture?.())
  view.webContents.ipc.on(IPC.chromeFallback, () => opts.onChromeFallback?.())
  view.webContents.ipc.on(IPC.expand, (_e, on: unknown) => opts.onSetExpanded(Boolean(on)))
  view.webContents.ipc.on(IPC.freeze, (_e, on: unknown) => opts.onSetFreeze(Boolean(on)))
  view.webContents.ipc.on(IPC.autoPause, (_e, on: unknown) => opts.onSetAutoPause(Boolean(on)))
  view.webContents.ipc.on(IPC.autoCapture, (_e, on: unknown) => opts.onSetAutoCapture?.(Boolean(on)))
  view.webContents.ipc.on(IPC.devtools, () => opts.onOpenDevTools?.())
  view.webContents.ipc.on(IPC.reload, () => opts.onReload())
  view.webContents.ipc.on(IPC.clearCookies, () => opts.onClearCookies?.())
  view.webContents.ipc.on(IPC.stop, () => opts.onStop?.())
  view.webContents.ipc.on(IPC.togglePause, () => opts.onTogglePause?.())
  view.webContents.ipc.on(IPC.setBrowserHeaders, (_e, on: unknown) => opts.onSetBrowserHeaders?.(Boolean(on)))
  view.webContents.ipc.on(IPC.setAutoOpenDevTools, (_e, on: unknown) => opts.onSetAutoOpenDevTools?.(Boolean(on)))

  void view.webContents.loadURL(htmlUrl)

  return {
    view,
    setUrl: (url) => {
      lastUrl = url

      if (loaded) {
        apply()
      }
    },
    setNav: (canBack, canForward) => exec(`window.__setNav(${JSON.stringify(canBack)}, ${JSON.stringify(canForward)})`),
    setWarning: (msg) => exec(`window.__setWarning(${JSON.stringify(msg)})`),
    setStatus: (status) => exec(`window.__setStatus(${JSON.stringify(status.text)}, ${JSON.stringify(status.tone)})`),
    setHistory: (entries) => exec(`window.__setHistory(${JSON.stringify(entries)})`),
    setFootprint: (text, over) => exec(`window.__setFootprint(${JSON.stringify(text)}, ${JSON.stringify(over)})`),
    setFrozen: (on) => exec(`window.__setFrozen(${JSON.stringify(on)})`),
    setCaptureLabel: (text) => exec(`window.__setCaptureLabel(${JSON.stringify(text)})`),
    setChromeFallback: (on) => exec(`window.__setChromeFallback(${JSON.stringify(on)})`),
    setCounts: (requests, websockets) =>
      exec(`window.__setCounts(${JSON.stringify(requests)}, ${JSON.stringify(websockets)})`),
    setPaused: (paused) => exec(`window.__setPaused(${JSON.stringify(paused)})`),
    setCaptureAll: (on) => exec(`window.__setCaptureAll(${JSON.stringify(on)})`)
  }
}

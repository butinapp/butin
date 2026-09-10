import { app, WebContentsView, type WebContents } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// A thin status strip docked below the page: an indeterminate progress sweep while a page loads plus a line
// of text — "Loading <host>…" during a load, the page title when idle, and the hovered link's URL while the
// pointer is over a link (classic browser status bar). Display-only (no controls), so it needs no preload or
// IPC — main pushes state in via executeJavaScript. Its own WebContentsView so the page can't style over it.

export const STATUS_BAR_HEIGHT = 24

const HTML_SOURCE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      :root { color-scheme: dark }
      * { box-sizing: border-box }
      html, body { margin: 0; height: 100% }
      body {
        position: relative; display: flex; align-items: center; height: 100%; padding: 0 12px;
        background: #18181b; color: #a1a1aa; border-top: 1px solid #27272a; overflow: hidden;
        font: 11px/1.4 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; user-select: none;
      }
      /* Indeterminate progress sweep along the top edge while loading. */
      #progress { position: absolute; top: 0; left: 0; right: 0; height: 2px; opacity: 0; transition: opacity .15s }
      body.loading #progress { opacity: 1 }
      #progress::before {
        content: ''; position: absolute; top: 0; height: 100%; width: 40%; border-radius: 2px;
        background: #4ade80; animation: sweep 1.1s ease-in-out infinite;
      }
      @keyframes sweep { 0% { left: -40% } 100% { left: 100% } }
      #text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
      #text.target { color: #d4d4d8; font-family: ui-monospace, SFMono-Regular, Menlo, monospace }
      #text.flash { color: #4ade80 }
    </style>
  </head>
  <body>
    <div id="progress"></div>
    <div id="text"></div>
    <script>
      var textEl = document.getElementById('text')
      var loading = false, loadingText = '', idleText = '', targetText = '', flashText = ''

      // A transient flash (e.g. "saved …") wins over everything while active; then the hovered link (you want to
      // see where a click goes); otherwise the loading line, else the idle title.
      function render() {
        document.body.classList.toggle('loading', loading)
        textEl.classList.remove('target', 'flash')
        if (flashText) { textEl.classList.add('flash'); textEl.textContent = flashText; return }
        if (targetText) { textEl.classList.add('target'); textEl.textContent = targetText; return }
        textEl.textContent = loading ? (loadingText || 'Loading…') : idleText
      }
      window.__setLoading = function (on, text) { loading = !!on; loadingText = text || ''; render() }
      window.__setIdle = function (text) { idleText = text || ''; render() }
      window.__setTarget = function (url) { targetText = url || ''; render() }
      window.__setFlash = function (text) { flashText = text || ''; render() }
      render()
    </script>
  </body>
</html>`

let cachedUrl: string | null = null

const ensureFile = (): string => {
  if (!cachedUrl) {
    const htmlPath = join(app.getPath('userData'), 'butin-magic-statusbar.html')

    writeFileSync(htmlPath, HTML_SOURCE)
    cachedUrl = pathToFileURL(htmlPath).toString()
  }

  return cachedUrl
}

export type StatusBar = {
  view: WebContentsView
  // `text` overrides the default "Loading…" with e.g. "Loading github.com…".
  setLoading: (on: boolean, text?: string) => void
  setIdle: (text: string) => void
  setTarget: (url: string) => void
  // Show a transient message (highest priority) that auto-clears after `ms` — e.g. "saved invoice.pdf".
  flash: (text: string, ms?: number) => void
}

export const createStatusBar = (): StatusBar => {
  const view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } })
  const exec = (code: string): void => void view.webContents.executeJavaScript(code).catch(() => {})

  // Buffer the latest state until the HTML has loaded so an early did-start-loading isn't dropped.
  let loaded = false
  let loading = false
  let loadingText = ''
  let idleText = ''
  let targetText = ''
  let flashText = ''
  let flashTimer: ReturnType<typeof setTimeout> | undefined

  view.webContents.on('did-finish-load', () => {
    loaded = true
    exec(`window.__setIdle(${JSON.stringify(idleText)})`)
    exec(`window.__setTarget(${JSON.stringify(targetText)})`)
    exec(`window.__setFlash(${JSON.stringify(flashText)})`)
    exec(`window.__setLoading(${JSON.stringify(loading)}, ${JSON.stringify(loadingText)})`)
  })

  void view.webContents.loadURL(ensureFile())

  return {
    view,
    setLoading: (on, text) => {
      loading = on
      loadingText = text ?? ''

      if (loaded) {
        exec(`window.__setLoading(${JSON.stringify(on)}, ${JSON.stringify(loadingText)})`)
      }
    },
    setIdle: (text) => {
      idleText = text

      if (loaded) {
        exec(`window.__setIdle(${JSON.stringify(text)})`)
      }
    },
    setTarget: (url) => {
      targetText = url

      if (loaded) {
        exec(`window.__setTarget(${JSON.stringify(url)})`)
      }
    },
    flash: (text, ms = 6000) => {
      clearTimeout(flashTimer)

      const push = (value: string) => {
        flashText = value

        if (loaded) {
          exec(`window.__setFlash(${JSON.stringify(value)})`)
        }
      }

      push(text)
      flashTimer = setTimeout(() => push(''), ms)
    }
  }
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// Drive a status bar off a page's load lifecycle: progress on while loading (labelled with the navigating
// host), the title once settled, and the hovered link URL on `update-target-url`. Multiple listeners on these
// events are fine, so this coexists with a window's own navigation handlers.
export const wireStatusBar = (wc: WebContents, bar: StatusBar): void => {
  wc.on('did-start-loading', () => bar.setLoading(true))
  wc.on('did-start-navigation', (_e, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) {
      bar.setLoading(true, `Loading ${hostOf(url)}…`)
    }
  })
  wc.on('did-stop-loading', () => {
    bar.setLoading(false)
    bar.setIdle(wc.getTitle() || hostOf(wc.getURL()))
  })
  wc.on('page-title-updated', (_e, title) => bar.setIdle(title))
  wc.on('update-target-url', (_e, url) => bar.setTarget(url))
}

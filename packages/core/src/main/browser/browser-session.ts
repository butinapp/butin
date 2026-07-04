import type { BrowserContext, BrowserFetchInit, BrowserPage, BrowserSession, ButinPlugin } from '@butinapp/sdk'
import { BrowserWindow, type DownloadItem, type Event } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getPluginSession, partitionFor } from './shared-session.js'

// A live authenticated browser session for collectors (ctx.browser). `open` boots an OFFSCREEN window on
// the plugin's captured partition (same one Magic Login + the spa-bearer boot use, so cookies + identity
// ride along), navigates it to `url` as a REAL navigation — which carries Sec-Fetch-*, runs the page's JS,
// and keeps a stateful server session warm where a bare net.request would get auto-logged-out — then hands
// the collector a BrowserPage and tears the window down. A page's fetches run IN the page (or a child
// frame, via loadFrame), so their Origin/Referer match that context; binary bodies cross the
// executeJavaScript bridge base64-encoded.

const NAV_TIMEOUT_MS = 30_000

// The hidden child iframe loadFrame manages (one per window; reused across loadFrame calls).
const FRAME_ID = '__butin_frame'

// The JS `Window` expression for a context — the top-level `window`, or the frame's contentWindow.
const ctxWindow = (frame: boolean): string =>
  frame ? `document.getElementById(${JSON.stringify(FRAME_ID)}).contentWindow` : 'window'

// The JS `Document` expression for a context. Reading a cross-origin frame document throws — so the frame
// html read guards with try/catch (see htmlExpression).
const ctxDocument = (frame: boolean): string =>
  frame ? `document.getElementById(${JSON.stringify(FRAME_ID)}).contentDocument` : 'document'

// Build the in-page expression that runs one fetch (from the given context's window) and returns
// { status, body }. `body` is the response text, or — for a binary fetch — a base64 string (the only
// JSON-safe way back across executeJavaScript).
const fetchExpression = (url: string, init: BrowserFetchInit | undefined, binary: boolean, frame: boolean): string => {
  const opts = JSON.stringify({
    method: init?.method ?? 'GET',
    headers: init?.headers ?? {},
    ...(init?.body !== undefined ? { body: init.body } : {}),
    credentials: 'include'
  })
  const decode = binary
    ? "const b=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return{status:r.status,body:btoa(s)}"
    : 'return{status:r.status,body:await r.text()}'

  return `(async()=>{const r=await ${ctxWindow(frame)}.fetch(${JSON.stringify(url)},${opts});${decode}})()`
}

const htmlExpression = (frame: boolean): string =>
  frame
    ? `(()=>{try{return ${ctxDocument(true)}.documentElement.outerHTML}catch(_){return ''}})()`
    : 'document.documentElement.outerHTML'

// Inject (once) the hidden iframe and navigate it to `url`, resolving when it finishes loading. A real
// child-frame navigation → Sec-Fetch-Dest: iframe, which framed-only legacy pages require.
const loadFrameExpression = (url: string): string =>
  `(async()=>{let f=document.getElementById(${JSON.stringify(FRAME_ID)});` +
  `if(!f){f=document.createElement('iframe');f.id=${JSON.stringify(FRAME_ID)};f.style.display='none';document.body.appendChild(f);}` +
  `await new Promise((res,rej)=>{f.onload=()=>res();f.onerror=()=>rej(new Error('frame load failed'));f.src=${JSON.stringify(url)};});return true})()`

// Reject if a webContents call outlives the budget, so a hung page can't pin the collector (and the UI's
// "Fetching…") forever.
const withTimeout = <T>(p: Promise<T>, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`browser ${label} timed out after ${NAV_TIMEOUT_MS / 1000}s`)), NAV_TIMEOUT_MS)
    )
  ])

export const createBrowserSession = (plugin: ButinPlugin): BrowserSession => ({
  open: async <T>(url: string, use: (page: BrowserPage) => Promise<T>): Promise<T> => {
    getPluginSession(plugin) // applies browser identity + tracks the partition for promote-on-quit
    const win = new BrowserWindow({
      show: false,
      webPreferences: { partition: partitionFor(plugin), backgroundThrottling: false }
    })

    const evaluate = <R>(expression: string, label: string): Promise<R> =>
      withTimeout(win.webContents.executeJavaScript(expression, true) as Promise<R>, label)

    // A read+fetch context bound to the top-level page (frame=false) or the child frame (frame=true).
    const contextFor = (frame: boolean): BrowserContext => ({
      html: () => evaluate<string>(htmlExpression(frame), 'html()'),
      fetchText: async (u, init) => {
        const r = await evaluate<{ status: number; body: string }>(
          fetchExpression(u, init, false, frame),
          `fetchText(${u})`
        )

        return { status: r.status, text: r.body }
      },
      fetchBytes: async (u, init) => {
        const r = await evaluate<{ status: number; body: string }>(
          fetchExpression(u, init, true, frame),
          `fetchBytes(${u})`
        )

        return { status: r.status, bytes: new Uint8Array(Buffer.from(r.body, 'base64')) }
      }
    })

    // Download a URL as a real navigation (Sec-Fetch-Dest: document) and capture its bytes via the
    // session's will-download → a temp file → read. Matches on the item URL so concurrent downloads on the
    // shared session don't cross handlers. Forced through downloadURL so an inline application/pdf (no
    // Content-Disposition) lands as bytes instead of opening Electron's PDF viewer.
    const download = (u: string, init?: { referer?: string }): Promise<Uint8Array> =>
      withTimeout(
        new Promise<Uint8Array>((resolve, reject) => {
          const ses = win.webContents.session
          const savePath = join(tmpdir(), `butin-dl-${randomUUID()}`)
          const onWillDownload = (_e: Event, item: DownloadItem): void => {
            if (item.getURL() !== u) {
              return // another concurrent download on this session — not ours
            }

            ses.off('will-download', onWillDownload)
            item.setSavePath(savePath)
            item.once('done', (_ev, state) => {
              if (state === 'completed') {
                readFile(savePath)
                  .then((b) => resolve(new Uint8Array(b)))
                  .catch(reject)
                  .finally(() => void rm(savePath, { force: true }))
              } else {
                void rm(savePath, { force: true })
                reject(new Error(`browser download ${state}: ${u}`))
              }
            })
          }

          ses.on('will-download', onWillDownload)
          win.webContents.downloadURL(u, init?.referer ? { headers: { Referer: init.referer } } : undefined)
        }),
        `download(${u})`
      )

    try {
      await withTimeout(win.webContents.loadURL(url), `navigation to ${url}`)

      const page: BrowserPage = {
        ...contextFor(false),
        navigate: (u: string) =>
          withTimeout(
            win.webContents.loadURL(u).then(() => undefined),
            `navigation to ${u}`
          ),
        loadFrame: async (u: string) => {
          await evaluate<boolean>(loadFrameExpression(u), `loadFrame(${u})`)

          return contextFor(true)
        },
        download
      }

      return await use(page)
    } finally {
      if (!win.isDestroyed()) {
        win.destroy()
      }
    }
  }
})

import { app, type CookiesSetDetails, session as electronSession, type Session, type WebContents } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { applyBrowserIdentity } from './identity.js'

// Real-Chrome sign-in fallback: when a service refuses the embedded browser (Google's "this browser or app
// may not be secure"), open the user's installed Chrome for a hand sign-in, then mirror its cookies into a
// target Electron partition. Profile-agnostic — the caller passes the partition to sync INTO and a `scopeId`
// that names the persistent Chrome user-data-dir (the app keys it by profile; the recorder by partition), so
// this lives in @butinapp/engine and both the app and the recorder can use it.

const TAG = 'chrome-login'

// engine has no app logger; route through console (the app captures console into its log buffer).
const log = {
  info: (msg: string): void => console.log(`[${TAG}] ${msg}`),
  warn: (msg: string): void => console.warn(`[${TAG}] ${msg}`)
}

// One cookie as the browser-level CDP `Storage.getCookies` returns it.
export type CdpCookie = {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  session: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

export const mapSameSite = (s: CdpCookie['sameSite']): 'unspecified' | 'no_restriction' | 'lax' | 'strict' => {
  if (s === 'Strict') {
    return 'strict'
  }

  if (s === 'Lax') {
    return 'lax'
  }

  if (s === 'None') {
    return 'no_restriction'
  }

  return 'unspecified'
}

// A CDP cookie as the args Electron's `cookies.set` wants. The url is reconstructed from the host (leading
// dot stripped) + scheme; a session cookie (or a non-positive expiry) carries no expirationDate.
export const cdpCookieToElectron = (c: CdpCookie): CookiesSetDetails => {
  const host = c.domain.replace(/^\./, '')

  return {
    url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expirationDate: !c.session && c.expires > 0 ? c.expires : undefined,
    sameSite: mapSameSite(c.sameSite)
  }
}

// Preference-ordered Chrome/Chromium exe candidates for the current OS.
export const chromeCandidates = (): string[] => {
  if (process.platform === 'win32') {
    return [
      process.env['PROGRAMFILES'] && join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['PROGRAMFILES(X86)'] &&
        join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['LOCALAPPDATA'] && join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe')
    ].filter((p): p is string => Boolean(p))
  }

  if (process.platform === 'darwin') {
    const home = process.env['HOME'] ?? ''

    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      home && join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ].filter((p): p is string => Boolean(p))
  }

  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  const onPath = (process.env['PATH'] ?? '')
    .split(':')
    .filter(Boolean)
    .flatMap((dir) => names.map((n) => join(dir, n)))

  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    ...onPath
  ]
}

export const findChromeExe = (): string | null => chromeCandidates().find((p) => existsSync(p)) ?? null

// On-page text Google shows when it refuses an embedded browser ("Couldn't sign you in — this browser or app
// may not be secure"). Lowercased for a case-insensitive contains check.
const SIGNIN_BLOCK_MARKERS = ['this browser or app may not be secure', "couldn't sign you in"]

// Does the URL look like Google's embedded-browser sign-in rejection? Pure, so it's unit-tested.
export const isSigninBlockUrl = (url: string): boolean =>
  url.includes('accounts.google.com') && /rejected|deniedsigninrejected/i.test(url)

// Whether the live page is a sign-in that refused the embedded browser. Only Google sign-in pages are
// candidates (a cheap negative for everything else); for those it trusts the URL signal, else scrapes the
// page text. The scrape runs in the page world and is best-effort (a mid-navigation read just returns false).
export const detectSigninBlock = async (wc: WebContents): Promise<boolean> => {
  const url = wc.getURL()

  if (!url.includes('accounts.google.com')) {
    return false
  }

  if (isSigninBlockUrl(url)) {
    return true
  }

  try {
    const text = String(await wc.executeJavaScript('document.body?.innerText ?? ""', true)).toLowerCase()

    return SIGNIN_BLOCK_MARKERS.some((m) => text.includes(m))
  } catch {
    return false
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// The persistent Chrome user-data-dir for a given scope. Kept under Electron's userData, NOT under
// ~/butin/profiles/<id>/ — the vault migration seals every file in a profile's tree, which would corrupt
// Chrome's own cookie store. Outside the tree, it carries Chrome's own at-rest protection instead. `scopeId`
// keys the dir (the app passes the active profile id; the recorder passes a partition-derived key) so each
// scope keeps its own logged-in Chrome profile.
export const chromeUserDataDir = (scopeId: string): string => join(app.getPath('userData'), 'chrome-login', scopeId)

export const hasChromeSession = (scopeId: string): boolean => existsSync(chromeUserDataDir(scopeId))

export const removeChromeSession = (scopeId: string): void =>
  rmSync(chromeUserDataDir(scopeId), { recursive: true, force: true })

// Chrome writes its actual debugging port into <user-data-dir>/DevToolsActivePort once it is up.
const waitForDevToolsPort = async (userDataDir: string): Promise<number> => {
  const file = join(userDataDir, 'DevToolsActivePort')

  for (let i = 0; i < 60; i++) {
    try {
      const port = Number.parseInt((await readFile(file, 'utf8')).split('\n')[0]?.trim() ?? '', 10)

      if (port > 0) {
        return port
      }
    } catch {
      // not written yet
    }

    await delay(250)
  }

  throw new Error('Chrome DevTools port never appeared')
}

// All cookies from the running Chrome via the browser-level CDP endpoint.
const fetchCookiesViaCdp = async (port: number): Promise<CdpCookie[]> => {
  const info = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
    webSocketDebuggerUrl?: string
  }
  const wsUrl = info.webSocketDebuggerUrl

  if (!wsUrl || typeof WebSocket === 'undefined') {
    throw new Error('CDP WebSocket endpoint unavailable')
  }

  return new Promise<CdpCookie[]>((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('CDP cookie fetch timed out'))
    }, 5000)

    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' })))
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('CDP WebSocket error'))
    })
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: { cookies?: CdpCookie[] } }

      if (msg.id === 1) {
        clearTimeout(timer)
        ws.close()
        resolve(msg.result?.cookies ?? [])
      }
    })
  })
}

// Copy Chrome's cookies into an Electron session; returns how many landed. Some host-only / __Host- cookies
// don't round-trip cleanly and are skipped.
const syncCookies = async (port: number, ses: Session): Promise<number> => {
  let count = 0

  for (const c of await fetchCookiesViaCdp(port)) {
    try {
      await ses.cookies.set(cdpCookieToElectron(c))
      count++
    } catch {
      // skip the cookies Electron rejects (host-only / __Host- prefixed)
    }
  }

  return count
}

// Re-open the logged-in profile headless with a debug port (it opens about:blank, never a Google page, so
// Google's "may not be secure" block never fires), copy its cookies into the target partition, then quit.
const gatherCookies = async (exe: string, userDataDir: string, partition: string): Promise<number> => {
  await rm(join(userDataDir, 'DevToolsActivePort'), { force: true })

  const gatherer = spawn(
    exe,
    [
      `--user-data-dir=${userDataDir}`,
      '--headless=new',
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ],
    { stdio: 'ignore' }
  )

  try {
    const port = await waitForDevToolsPort(userDataDir)
    const ses = electronSession.fromPartition(partition)

    applyBrowserIdentity(ses, { rewriteHeaders: true })

    return await syncCookies(port, ses)
  } finally {
    gatherer.kill()
  }
}

export type ChromeSigninResult = { ok: boolean; error?: string; syncedCount?: number }

// Open real Chrome for a hand sign-in, then mirror its cookies into the target partition. Two passes against
// one persistent user-data-dir (keyed by `scopeId`): LOGIN runs with NO debug port (Google rejects sign-in on
// a debug-port Chrome); on window close, GATHER relaunches the same profile headless WITH a debug port and
// syncs into `partition`. The promise resolves only after the gather completes, carrying the synced count.
export const launchChromeSignin = (
  startUrl: string,
  opts: { partition: string; scopeId: string }
): Promise<ChromeSigninResult> =>
  new Promise((resolve) => {
    const exe = findChromeExe()

    if (!exe) {
      resolve({ ok: false, error: 'Could not find an installed Chrome or Chromium on this machine.' })

      return
    }

    const userDataDir = chromeUserDataDir(opts.scopeId)

    log.info(`opening Chrome sign-in → ${startUrl}`)

    const login = spawn(
      exe,
      [`--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check', startUrl],
      {
        stdio: 'ignore'
      }
    )

    login.on('error', (err) => resolve({ ok: false, error: `Could not launch Chrome: ${err.message}` }))

    // The 1.5s delay lets Chrome release the profile lock before the headless gatherer reopens the dir.
    login.on('exit', () => {
      setTimeout(() => {
        void gatherCookies(exe, userDataDir, opts.partition)
          .then((syncedCount) => {
            log.info(`synced ${syncedCount} cookies into ${opts.partition}`)
            resolve({ ok: true, syncedCount })
          })
          .catch((err: Error) => {
            log.warn(`cookie gather failed: ${err.message}`)
            resolve({ ok: false, error: err.message })
          })
      }, 1500)
    })
  })

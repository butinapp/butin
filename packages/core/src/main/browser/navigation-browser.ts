import {
  createMagicToolbar,
  createStatusBar,
  ensureClientHintsPreload,
  type MagicToolbar,
  type NavEntry,
  popupWebPreferences,
  STATUS_BAR_HEIGHT,
  TOOLBAR_EXPANDED_HEIGHT,
  TOOLBAR_HEIGHT,
  wireStatusBar
} from '@butinapp/engine'
import { app, BaseWindow, WebContentsView } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { log } from '../log.js'
import { detectSigninBlock, launchChromeSignin } from '../session/chrome-login.js'

import { activePartition, getSharedSession } from './shared-session.js'

const tag = 'nav-browser'

// A single plugin-less browser on the active shared session partition: navigate any service you're already
// signed into — for reverse-engineering endpoints or a quick look — without going through a plugin. It reuses
// the Magic Login window machinery in the toolbar's 'navigate' variant (no capture chrome) and NEVER captures:
// no markers, no readiness poll, no cookie clearing, no credential store.
let win: BaseWindow | null = null

export const openNavigationBrowser = (): void => {
  // Singleton — focus the open window instead of stacking a second one.
  if (win && !win.isDestroyed()) {
    win.focus()

    return
  }

  const ses = getSharedSession()
  const partition = activePartition()

  // Butin's icon (dev/Linux; a packaged build resolves to nothing and skips it — build/ isn't shipped).
  const devIcon = join(app.getAppPath(), 'build/icon.png')

  const baseWin = new BaseWindow({
    width: 1040,
    height: 820,
    title: 'Navigation browser',
    autoHideMenuBar: true,
    ...(existsSync(devIcon) ? { icon: devIcon } : {})
  })

  win = baseWin
  baseWin.on('closed', () => {
    if (win === baseWin) {
      win = null
    }
  })

  const site = new WebContentsView({
    webPreferences: { session: ses, contextIsolation: false, sandbox: true, preload: ensureClientHintsPreload() }
  })

  let frozen = false
  let toolbarHeight = TOOLBAR_HEIGHT
  // The last URL the user asked for via the URL bar — the destination to return to after a Chrome hand-off,
  // since the page showing is Google's terminal rejection (reloading that just re-shows the block).
  let lastTarget = ''
  const history: NavEntry[] = []

  const toolbar: MagicToolbar = createMagicToolbar({
    variant: 'navigate',
    // Capture/clear-cookies are hidden in the navigate variant, so these are never triggered.
    onForceCapture: () => {},
    onClearCookies: () => {},
    onSetAutoPause: () => {},
    onSetAutoCapture: () => {},
    onNavigate: (raw) => {
      const url = raw.trim()

      if (!url) {
        return
      }

      // Bare host (no scheme) → assume https so "github.com" works as well as a full URL.
      const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`

      lastTarget = target
      log.info(tag, `navigate → ${target}`)
      void site.webContents.loadURL(target).catch(() => {})
    },
    onBack: () => {
      if (site.webContents.navigationHistory.canGoBack()) {
        site.webContents.navigationHistory.goBack()
      }
    },
    onForward: () => {
      if (site.webContents.navigationHistory.canGoForward()) {
        site.webContents.navigationHistory.goForward()
      }
    },
    onSetExpanded: (on) => {
      toolbarHeight = on ? TOOLBAR_EXPANDED_HEIGHT : TOOLBAR_HEIGHT
      layout()
    },
    onSetFreeze: (on) => {
      frozen = on
    },
    // A page that blocks the built-in browser (Google's "may not be secure") can hand off to a real Chrome:
    // sign in there, the cookies land in this same shared partition, then the current page reloads riding it.
    onChromeFallback: () =>
      void (async () => {
        toolbar.setChromeFallback(false)
        toolbar.setWarning('Opening Chrome. Sign in there, then close it and Butin brings the session home.')
        log.info(tag, 'launching real-Chrome sign-in fallback')

        const res = await launchChromeSignin('https://accounts.google.com')

        if (baseWin.isDestroyed()) {
          return
        }

        if (res.ok) {
          toolbar.setWarning(`Session brought home (${res.syncedCount ?? 0} cookies). Reloading.`)

          if (lastTarget) {
            void site.webContents.loadURL(lastTarget).catch(() => {})
          } else {
            site.webContents.reload()
          }
        } else {
          toolbar.setWarning(res.error ?? 'Chrome sign-in did not complete.')
        }
      })(),
    onOpenDevTools: () => site.webContents.openDevTools({ mode: 'bottom' }),
    onReload: () => site.webContents.reload()
  })

  const statusBar = createStatusBar()

  baseWin.contentView.addChildView(toolbar.view)
  baseWin.contentView.addChildView(site)
  baseWin.contentView.addChildView(statusBar.view)

  const layout = (): void => {
    const { width, height } = baseWin.getContentBounds()
    const siteHeight = Math.max(0, height - toolbarHeight - STATUS_BAR_HEIGHT)

    toolbar.view.setBounds({ x: 0, y: 0, width, height: toolbarHeight })
    site.setBounds({ x: 0, y: toolbarHeight, width, height: siteHeight })
    statusBar.view.setBounds({ x: 0, y: toolbarHeight + siteHeight, width, height: STATUS_BAR_HEIGHT })
  }

  layout()
  baseWin.on('resize', layout)

  const pushUrl = (): void => {
    toolbar.setUrl(site.webContents.getURL())
    const nav = site.webContents.navigationHistory

    toolbar.setNav(nav.canGoBack(), nav.canGoForward())
  }

  const pushHistory = (status: number, url: string): void => {
    history.push({ status, url })

    while (history.length > 6) {
      history.shift()
    }

    toolbar.setHistory(history)
  }

  site.webContents.on('did-navigate', (_e, url, code) => {
    pushUrl()
    pushHistory(code, url)
  })
  site.webContents.on('did-redirect-navigation', (_e, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) {
      pushHistory(-1, url)
    }
  })
  site.webContents.on('did-navigate-in-page', () => pushUrl())

  wireStatusBar(site.webContents, statusBar)

  // Offer the real-Chrome hand-off when a page blocks the built-in browser; hide it on any other page.
  const checkSigninBlock = (): void =>
    void detectSigninBlock(site.webContents).then((blocked) => {
      if (baseWin.isDestroyed()) {
        return
      }

      toolbar.setChromeFallback(blocked)

      if (blocked) {
        toolbar.setWarning(
          'This browser is blocked for sign-in. Click "Sign in with Chrome" to finish in your own Chrome.'
        )
      }
    })

  site.webContents.on('did-finish-load', checkSigninBlock)
  site.webContents.on('did-navigate-in-page', checkSigninBlock)

  // Freeze (debug): cancel navigations/redirects while on, so a runaway redirect loop stops on the current
  // page for inspection instead of bouncing onward.
  site.webContents.on('will-redirect', (e) => {
    if (frozen) {
      e.preventDefault()
    }
  })
  site.webContents.on('will-navigate', (e) => {
    if (frozen) {
      e.preventDefault()
    }
  })

  // Keep popups (window.open) on the same partition so a logged-in session carries into popup OAuth flows.
  site.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { webPreferences: popupWebPreferences(partition) }
  }))

  log.info(tag, `opening navigation browser on ${partition}`)
  void site.webContents.loadURL('about:blank')
}

import '@fontsource-variable/space-grotesk/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { ThemeProvider } from 'next-themes'
import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'

import { ErrorBoundary } from './components/error-boundary.js'
import { FormatProvider } from './components/format-provider.js'
import { LocaleProvider } from './components/locale-provider.js'
import { LockGate } from './components/lock-gate.js'
import { ThemedToaster } from './components/themed-toaster.js'
import { createAppRouter } from './router.js'
import './index.css'

// No automatic retries at any level — a failed fetch (verification needed, expired session, gov 500) must
// surface immediately, never silently re-hammer the service.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false }
  }
})

const router = createAppRouter(queryClient)

// Dev-only TanStack Query + Router devtools. The dynamic import sits in the DEV branch of a ternary, so with
// `import.meta.env.DEV` statically false in a production build, the whole `import()` is dead-code-eliminated
// — no devtools chunk is emitted and the devDependencies never ship.
const Devtools = import.meta.env.DEV
  ? lazy(() => import('./components/devtools.js').then((m) => ({ default: m.Devtools })))
  : null

// Renderer-side safety net: a stray throw outside React's render path — an async callback, an event handler,
// a rejected IPC promise nobody awaited — would otherwise vanish into the console. Surface it as a toast so
// the failure is visible without bricking the window.
window.addEventListener('error', (e) => {
  const detail = String(e.error?.stack ?? e.error?.message ?? e.message)

  console.error('[renderer] uncaught error:', detail)
  void window.butin?.app?.logClientError?.(`uncaught error: ${detail}`)
  toast.error('An unexpected error occurred', { description: String(e.error?.message ?? e.message) })
})
window.addEventListener('unhandledrejection', (e) => {
  const detail = String(e.reason?.stack ?? e.reason?.message ?? e.reason)

  console.error('[renderer] unhandled rejection:', detail)
  void window.butin?.app?.logClientError?.(`unhandled rejection: ${detail}`)
  toast.error('An unexpected error occurred', { description: String(e.reason?.message ?? e.reason) })
})

// Fade out the instant splash (index.html) once React has committed and painted the shell. transitionend
// drives the removal; the timeout is a fallback in case the element is already hidden and no transition fires.
const removeSplash = () => {
  const splash = document.getElementById('splash')

  if (!splash) {
    return
  }

  splash.classList.add('splash--hide')
  splash.addEventListener('transitionend', () => splash.remove(), { once: true })
  setTimeout(() => splash.remove(), 600)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
        <QueryClientProvider client={queryClient}>
          <LocaleProvider>
            <FormatProvider>
              <LockGate>
                <RouterProvider router={router} />
              </LockGate>
              <ThemedToaster />
              {Devtools && (
                <Suspense fallback={null}>
                  <Devtools router={router} />
                </Suspense>
              )}
            </FormatProvider>
          </LocaleProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>
)

// Double rAF = wait for the first committed frame (the app shell chrome) before revealing it.
requestAnimationFrame(() => requestAnimationFrame(removeSplash))

import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { useEffect, useState } from 'react'

import type { AppRouter } from '../router.js'

const STORAGE_KEY = 'butin.devtools'

// Dev-only inspectors for TanStack Query (cache/queries) + Router (route tree/match state). Mounted behind
// an `import.meta.env.DEV` guard + a dynamic import in main.tsx, so neither the components nor their deps
// reach the production bundle. Hidden by default (even the floating launcher buttons are noise when you're
// not debugging) — toggle the whole thing with Ctrl+Shift+D; the choice persists across reloads.
export const Devtools = ({ router }: { router: AppRouter }) => {
  const [shown, setShown] = useState(() => localStorage.getItem(STORAGE_KEY) === 'on')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        setShown((prev) => {
          const next = !prev

          localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off')

          return next
        })
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!shown) {
    return null
  }

  return (
    <>
      <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
      <TanStackRouterDevtools router={router} position="bottom-right" />
    </>
  )
}

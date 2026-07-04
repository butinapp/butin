import { useEffect, useRef, useState } from 'react'

import { type ButinLabels } from '../../i18n/index.js'
import { cn } from '../../primitives.js'

// The one connection-status vocabulary every status indicator reads, so a service's state renders the same
// wherever it appears. The value is computed once (probe-aware) by the host; this module owns how it looks.
//   connected (green)  — confirmed working this session (a successful Test / Reconnect / fetch)
//   unverified (blue)  — credentials present but unchecked this session — the resting state on relaunch
//   disconnected (red) — confirmed dead/expired, or no credentials at all
export type ConnState = 'connected' | 'unverified' | 'disconnected'

export const connDotClass: Record<ConnState, string> = {
  connected: 'bg-emerald-500',
  unverified: 'bg-sky-500',
  disconnected: 'bg-destructive'
}

export const connLabel = (t: ButinLabels, state: ConnState): string =>
  state === 'connected' ? t.statusConnected : state === 'unverified' ? t.statusUnverified : t.statusDisconnected

// The status dot, drawn one way everywhere. `className` tunes size/placement per surface (smaller in the
// header pill, nudged with ml-auto in the sidebar); `title` carries the hover label where there's no text.
// `testing` is the shared in-flight flag (one service can show in several places at once): while true the dot
// pulses with an expanding ping ring, and whenever the resolved state CHANGES it plays a one-shot ping so a
// finished probe visibly "lands" wherever the service is drawn instead of silently recoloring.
export const ConnDot = ({
  state,
  testing,
  className,
  title
}: {
  state: ConnState
  testing?: boolean
  className?: string
  title?: string
}) => {
  const [flash, setFlash] = useState(false)
  const prev = useRef(state)

  useEffect(() => {
    if (prev.current === state) {
      return
    }

    prev.current = state
    setFlash(true)
    const id = setTimeout(() => setFlash(false), 600)

    return () => clearTimeout(id)
  }, [state])

  return (
    <span className={cn('relative inline-flex size-2', className)} title={title}>
      {testing || flash ? (
        <span
          className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-75', connDotClass[state])}
        />
      ) : null}
      <span className={cn('relative size-full rounded-full', connDotClass[state], testing && 'animate-pulse')} />
    </span>
  )
}

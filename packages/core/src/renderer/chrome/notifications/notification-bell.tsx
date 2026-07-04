import { Button, cn } from '@butinapp/ui/primitives'
import { AlertTriangle, Bell, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { NotificationView } from './types.js'

export interface NotificationBellProps {
  items: NotificationView[]
  format: (n: NotificationView) => { title: string; body: string }
  // Optional relative time per item (e.g. "2h ago"); the host supplies a localized formatter. Absent → no timestamp.
  formatTime?: (iso: string) => string
  onMarkRead: (id: string) => void
  onMarkAll: () => void
  onDismiss: (id: string) => void
  onAction?: (n: NotificationView) => void
  labels: { title: string; empty: string; markAll: string; dismiss: string; unread: (count: number) => string }
}

// Top-bar notification bell + popover. Pure + prop-driven; a plain useState menu (not the radix
// dropdown-menu) so it opens under fireEvent.click in jsdom — matching ProfileSwitcher.
export const NotificationBell = ({
  items,
  format,
  formatTime,
  onMarkRead,
  onMarkAll,
  onDismiss,
  onAction,
  labels
}: NotificationBellProps) => {
  const [open, setOpen] = useState(false)
  const unread = items.filter((n) => !n.read).length

  // Escape closes the popover, matching the dialog/menu convention elsewhere.
  useEffect(() => {
    if (!open) {
      return
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('keydown', onKey)

    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="relative [-webkit-app-region:no-drag]">
      <Button
        variant="ghost"
        size="icon"
        aria-label={unread > 0 ? `${labels.title}, ${labels.unread(unread)}` : labels.title}
        aria-haspopup="menu"
        aria-expanded={open}
        className="relative"
        onClick={() => setOpen((v) => !v)}
      >
        <Bell />
        {unread > 0 ? (
          <span className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10px] font-medium tabular-nums">
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="menu"
            aria-label={labels.title}
            className="bg-popover absolute right-0 z-50 mt-1 w-80 rounded-md border shadow-md"
          >
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-sm font-medium">{labels.title}</span>
              {items.length > 0 ? (
                <button
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm text-xs focus-visible:ring-2 focus-visible:outline-none"
                  onClick={onMarkAll}
                >
                  {labels.markAll}
                </button>
              ) : null}
            </div>
            {items.length === 0 ? (
              <p className="text-muted-foreground px-3 py-6 text-center text-sm">{labels.empty}</p>
            ) : (
              <ul className="max-h-96 overflow-auto">
                {items.map((n) => {
                  const { title, body } = format(n)
                  const warning = n.severity === 'warning'
                  const time = n.createdAt && formatTime ? formatTime(n.createdAt) : undefined

                  return (
                    <li
                      key={n.id}
                      className={cn(
                        'group flex items-start gap-2 border-b px-3 py-2 last:border-0',
                        !n.read && 'bg-muted/40'
                      )}
                    >
                      <button
                        className="focus-visible:ring-ring/50 min-w-0 flex-1 rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none"
                        onClick={() => {
                          onMarkRead(n.id)
                          onAction?.(n)
                          setOpen(false)
                        }}
                      >
                        <span className="flex items-center gap-1.5">
                          {warning ? (
                            <AlertTriangle
                              aria-hidden
                              className="size-3.5 shrink-0 text-amber-600 dark:text-amber-500"
                            />
                          ) : null}
                          <span
                            className={cn(
                              'min-w-0 flex-1 truncate text-sm',
                              warning && 'text-amber-600 dark:text-amber-500'
                            )}
                          >
                            {title}
                          </span>
                          {time ? (
                            <time
                              dateTime={n.createdAt}
                              className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums"
                            >
                              {time}
                            </time>
                          ) : null}
                        </span>
                        <span className="text-muted-foreground mt-0.5 block truncate text-xs">{body}</span>
                      </button>
                      <button
                        aria-label={labels.dismiss}
                        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 mt-0.5 rounded-sm opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none"
                        onClick={() => onDismiss(n.id)}
                      >
                        <X className="size-3.5" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}

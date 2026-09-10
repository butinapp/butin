import { Button } from '@butinapp/ui/primitives'
import { useState } from 'react'

import { ConfirmDialog } from './ConfirmDialog.js'

type Props = {
  runId: string
  label: string
  startedAt: string
  requestCount: number
  /** Called after this recording is deleted, so the overview can reload. */
  onDeleted: () => void
}

// Formats an ISO timestamp as a locale date+time string; falls back to the raw value on parse error.
const formatDate = (iso: string): string => {
  if (!iso) {
    return '—'
  }

  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return iso
  }
}

export const RecordingRow = ({ runId, label, startedAt, requestCount, onDeleted }: Props) => {
  const openFolder = () => void window.recorder.openRunFolder(runId)
  const [copied, setCopied] = useState(false)

  const copyPath = async () => {
    await window.recorder.copyRunPath(runId)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm transition-colors hover:bg-accent/40">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium" title={label || runId}>
          {label || runId}
        </p>
        <p className="font-mono text-xs text-muted-foreground">
          {formatDate(startedAt)} · {requestCount} request{requestCount === 1 ? '' : 's'}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          size="icon"
          variant="ghost"
          aria-label="Copy run folder path"
          title={copied ? 'Copied!' : 'Copy run folder path'}
          onClick={() => void copyPath()}
          className={copied ? 'text-cyan-500' : undefined}
        >
          {copied ? (
            /* check icon — confirms the path is on the clipboard */
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            /* copy icon as inline SVG — avoids a lucide dep not in this package */
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </svg>
          )}
        </Button>
        <Button size="icon" variant="ghost" aria-label="Open run folder" title="Open run folder" onClick={openFolder}>
          {/* folder-open icon as inline SVG — avoids a lucide dep not in this package */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
          </svg>
        </Button>
        <ConfirmDialog
          title="Delete recording"
          description={
            <>
              Permanently delete <span className="font-medium">{label || runId}</span>? This removes the captured
              requests, cookies, and screenshots from disk and cannot be undone.
            </>
          }
          confirmLabel="Delete recording"
          onConfirm={async () => {
            await window.recorder.deleteRecording(runId)
            onDeleted()
          }}
          trigger={
            <Button
              size="icon"
              variant="ghost"
              aria-label="Delete recording"
              title="Delete recording"
              className="text-muted-foreground hover:text-destructive"
            >
              {/* trash icon as inline SVG — avoids a lucide dep not in this package */}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 6h18" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" x2="10" y1="11" y2="17" />
                <line x1="14" x2="14" y1="11" y2="17" />
              </svg>
            </Button>
          }
        />
      </div>
    </div>
  )
}

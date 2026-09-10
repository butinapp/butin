import { Badge, Button, cn, Combobox, Input } from '@butinapp/ui/primitives'
import { ChevronRight, Copy, Download, FolderOpen, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

// The Logs view is a technical/debug surface — its copy stays English inline rather than going through the
// translated label contract (the same choice the Diagnostics page makes). Only the sidebar entry that opens
// it is translated.

export type LogViewerLevel = 'debug' | 'info' | 'warn' | 'error'

// Structurally compatible with core's LogEntryDto, declared here so @butinapp/ui carries no core dependency.
export type LogViewerEntry = {
  seq: number
  ts: string
  level: LogViewerLevel
  scope?: string
  plugin?: string
  action?: string
  message: string
  data?: Record<string, unknown>
}

export type LogViewerProps = {
  entries: LogViewerEntry[]
  onClear: () => void
  onReveal: () => void
  // Hand the rendered text to the host to write to a file. Copy-to-clipboard is handled internally.
  onExport?: (text: string) => void
}

const LEVELS: LogViewerLevel[] = ['debug', 'info', 'warn', 'error']

const LEVEL_TEXT: Record<LogViewerLevel, string> = {
  error: 'text-destructive',
  warn: 'text-amber-600 dark:text-amber-400',
  info: 'text-foreground',
  debug: 'text-muted-foreground'
}

// The origin used for the source filter + chip: a plugin (with its action) takes precedence over a bare scope.
const originValue = (e: LogViewerEntry): string => (e.plugin ? `plugin:${e.plugin}` : e.scope ? `scope:${e.scope}` : '')
const originLabel = (e: LogViewerEntry): string => (e.plugin ? e.plugin : e.scope ? e.scope : '—')

// `ts` is stored UTC ISO; the visible column shows it in the viewer's local time so it matches the wall clock.
const localTime = (ts: string): string =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

const lineText = (e: LogViewerEntry): string => {
  const origin = [e.scope ? `[${e.scope}]` : '', e.plugin ? `{${e.plugin}${e.action ? `/${e.action}` : ''}}` : '']
    .filter(Boolean)
    .join(' ')

  return `${e.ts} ${e.level.toUpperCase()} ${origin} ${e.message}`.replace(/\s+/g, ' ').trim()
}

export const LogViewer = ({ entries, onClear, onReveal, onExport }: LogViewerProps) => {
  // Display-only filters (client-side; do NOT touch the capture gate).
  const [shown, setShown] = useState<Set<LogViewerLevel>>(() => new Set(LEVELS))
  const [origin, setOrigin] = useState('all')
  const [search, setSearch] = useState('')
  const [follow, setFollow] = useState(true)
  const [expanded, setExpanded] = useState<number | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)

  const origins = useMemo(() => {
    const map = new Map<string, string>()

    for (const e of entries) {
      const value = originValue(e)

      if (value && !map.has(value)) {
        map.set(value, originLabel(e))
      }
    }

    const sources = [...map].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))

    return [{ value: 'all', label: 'All sources' }, ...sources]
  }, [entries])

  const query = search.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      entries.filter((e) => {
        if (!shown.has(e.level)) {
          return false
        }

        if (origin !== 'all' && originValue(e) !== origin) {
          return false
        }

        if (query) {
          const hay = `${e.message} ${e.scope ?? ''} ${e.plugin ?? ''} ${e.action ?? ''}`.toLowerCase()

          return hay.includes(query)
        }

        return true
      }),
    [entries, shown, origin, query]
  )

  // Auto-scroll to newest while following; the dep on filtered.length fires only when rows actually arrive.
  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [filtered.length, follow])

  const toggleLevel = (level: LogViewerLevel): void => {
    setShown((prev) => {
      const next = new Set(prev)

      if (next.has(level)) {
        next.delete(level)
      } else {
        next.add(level)
      }

      return next
    })
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        {filtered.length} of {entries.length} line{entries.length === 1 ? '' : 's'} shown. Filters below change what's
        displayed, not what's recorded — capture level and retention live in Settings → Advanced.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <div className="bg-muted/40 flex items-center gap-1 rounded-md border p-0.5">
          {LEVELS.map((level) => (
            <button
              key={level}
              onClick={() => toggleLevel(level)}
              aria-pressed={shown.has(level)}
              className={cn(
                'rounded px-2 py-1 text-xs font-medium capitalize transition-colors',
                shown.has(level) ? cn('bg-card shadow-xs', LEVEL_TEXT[level]) : 'text-muted-foreground/60'
              )}
            >
              {level}
            </button>
          ))}
        </div>

        <div className="w-48">
          <Combobox
            value={origin}
            options={origins}
            onValueChange={setOrigin}
            allowFreeText={false}
            placeholder="Filter sources…"
          />
        </div>

        <div className="min-w-40 flex-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search messages…"
            className="h-8"
          />
        </div>

        <Button
          variant={follow ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => setFollow((f) => !f)}
          aria-pressed={follow}
        >
          Follow
        </Button>

        <Button
          variant="outline"
          size="icon"
          title="Copy"
          onClick={() => void navigator.clipboard.writeText(filtered.map(lineText).join('\n'))}
        >
          <Copy className="size-4" />
        </Button>
        {onExport ? (
          <Button
            variant="outline"
            size="icon"
            title="Export to file"
            onClick={() => onExport(filtered.map(lineText).join('\n'))}
          >
            <Download className="size-4" />
          </Button>
        ) : null}
        <Button variant="outline" size="icon" title="Reveal log folder" onClick={onReveal}>
          <FolderOpen className="size-4" />
        </Button>
        <Button variant="outline" size="icon" title="Clear" onClick={onClear}>
          <Trash2 className="size-4" />
        </Button>
      </div>

      <div ref={scrollRef} className="bg-card min-h-0 flex-1 overflow-auto rounded-lg border font-mono text-xs">
        {filtered.length === 0 ? (
          <p className="text-muted-foreground p-4">No matching log lines.</p>
        ) : (
          <div className="divide-border/40 divide-y">
            {filtered.map((e) => {
              const open = expanded === e.seq
              const chip = originLabel(e)

              return (
                <div key={e.seq} className="hover:bg-muted/30">
                  {/* A div, not a button, so the line text can be selected/copied. Rows with `data` still
                      toggle the JSON on click; a drag-to-select won't fire the click, so selecting is free. */}
                  <div
                    className={cn(
                      'flex w-full items-start gap-2 px-3 py-1 text-left select-text',
                      e.data && 'cursor-pointer'
                    )}
                    onClick={() => e.data && setExpanded(open ? null : e.seq)}
                  >
                    <span className="text-muted-foreground/60 shrink-0 tabular-nums">{localTime(e.ts)}</span>
                    <span className={cn('w-12 shrink-0 uppercase', LEVEL_TEXT[e.level])}>{e.level}</span>
                    {chip !== '—' ? (
                      <Badge variant="outline" className="shrink-0 font-normal">
                        {chip}
                        {e.action ? <span className="text-muted-foreground/70">/{e.action}</span> : null}
                      </Badge>
                    ) : null}
                    <span className={cn('min-w-0 break-all whitespace-pre-wrap', LEVEL_TEXT[e.level])}>
                      {e.message}
                    </span>
                    {e.data ? (
                      <ChevronRight
                        className={cn(
                          'text-muted-foreground ml-auto size-3.5 shrink-0 transition-transform',
                          open && 'rotate-90'
                        )}
                      />
                    ) : null}
                  </div>
                  {open && e.data ? (
                    <pre className="text-muted-foreground bg-muted/40 mx-3 mb-2 overflow-auto rounded p-2">
                      {JSON.stringify(e.data, null, 2)}
                    </pre>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

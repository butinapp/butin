import type { AuthKind, TransportEngine } from '@butinapp/sdk'
import { Badge, Input, Select, ServiceIcon, Skeleton, cn } from '@butinapp/ui/primitives'
import { useEffect, useMemo, useState } from 'react'

import type { DomainSummary } from '../../main/ipc.js'

import { NewRecordingDialog } from './NewRecordingDialog.js'

interface Props {
  /** The selected profile's browser partition — the scope for this list. */
  partition: string
  selected: string | undefined
  onSelect: (surface: string) => void
  onNewRun: () => void
  /** The Butin app holds this profile open, so recording it is blocked. */
  blocked: boolean
}

// Maps auth kind to a short readable label for the list badge.
const authLabel = (kind: AuthKind): string => {
  const map: Record<AuthKind, string> = {
    cookie: 'cookie',
    'bearer-token': 'bearer',
    external: 'external',
    'api-key': 'api-key',
    'cookie-csrf': 'csrf',
    'minted-jwt': 'jwt',
    'rotating-refresh': 'refresh',
    'spa-bearer': 'spa'
  }

  return map[kind] ?? kind
}

const engineLabel = (engine: TransportEngine): string => (engine === 'electron' ? 'electron' : 'node')

// Show the filter + sort controls once there's more than one domain to scan/order.
const CONTROLS_THRESHOLD = 2

type SortMode = 'recent' | 'alpha'
const SORT_OPTIONS = [
  { value: 'recent', label: 'Most recent' },
  { value: 'alpha', label: 'A–Z' }
]

// Skeleton placeholder rows mirror the real row shape so the panel doesn't reflow when data arrives.
const ListSkeleton = () => (
  <div className="flex flex-col gap-px p-2" aria-hidden="true">
    {Array.from({ length: 5 }).map((_, i) => (
      <div key={i} className="flex items-center gap-2.5 px-2 py-2">
        <Skeleton className="size-7 rounded-md" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
    ))}
  </div>
)

export const DomainList = ({ partition, selected, onSelect, onNewRun, blocked }: Props) => {
  const [domains, setDomains] = useState<DomainSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortMode>('recent')

  useEffect(() => {
    let cancelled = false

    setLoading(true)
    setError(undefined)
    void window.recorder
      .listDomains(partition)
      .then((list) => {
        if (!cancelled) {
          setDomains(list)
          setLoading(false)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load domains')
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [partition])

  const showControls = !loading && !error && domains.length >= CONTROLS_THRESHOLD
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = q ? domains.filter((d) => d.surface.toLowerCase().includes(q)) : domains

    return [...matched].sort((a, b) =>
      sort === 'alpha'
        ? a.surface.localeCompare(b.surface)
        : // Most-recent first; fall back to name when timestamps tie or are missing.
          (b.lastRecordedAt || '').localeCompare(a.lastRecordedAt || '') || a.surface.localeCompare(b.surface)
    )
  }, [domains, query, sort])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <h2 className="flex items-center gap-2 font-display text-sm font-semibold text-foreground">
          Domains
          {!loading && !error && domains.length > 0 && (
            <span className="font-mono text-xs font-normal text-muted-foreground">{domains.length}</span>
          )}
        </h2>
        <NewRecordingDialog partition={partition} blocked={blocked} onStarted={onNewRun} />
      </div>

      {showControls && (
        <div className="flex items-center gap-2 px-3 pb-2">
          <Input
            type="search"
            placeholder="Filter domains…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 flex-1"
            aria-label="Filter domains"
          />
          <div className="w-32 shrink-0">
            <Select
              value={sort}
              options={SORT_OPTIONS}
              onValueChange={(v) => setSort(v as SortMode)}
              placeholder="Sort"
            />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && <ListSkeleton />}

        {!loading && error && <p className="px-4 py-3 text-xs text-destructive">{error}</p>}

        {!loading && !error && domains.length === 0 && (
          <p className="px-4 py-3 text-xs text-muted-foreground">No recordings for this profile yet.</p>
        )}

        {!loading && !error && domains.length > 0 && filtered.length === 0 && (
          <p className="px-4 py-3 text-xs text-muted-foreground">No domains match “{query.trim()}”.</p>
        )}

        {!loading &&
          !error &&
          filtered.map((d) => {
            const isSelected = selected === d.surface

            return (
              <button
                key={d.surface}
                type="button"
                onClick={() => onSelect(d.surface)}
                aria-current={isSelected ? 'true' : undefined}
                title={d.surface}
                className={cn(
                  'flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors',
                  'hover:bg-sidebar-accent/60',
                  isSelected && 'bg-sidebar-accent text-sidebar-accent-foreground'
                )}
              >
                <ServiceIcon name={d.surface} size={28} className="shrink-0 border border-border" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className={cn('truncate font-mono text-[13px]', isSelected ? 'font-medium' : 'font-normal')}>
                    {d.surface}
                  </span>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Badge variant="secondary" className="shrink-0">
                      {authLabel(d.authKind)}
                    </Badge>
                    <Badge variant="outline" className="shrink-0">
                      {engineLabel(d.engine)}
                    </Badge>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {d.runCount} run{d.runCount === 1 ? '' : 's'}
                    </span>
                  </div>
                </div>
              </button>
            )
          })}
      </div>
    </div>
  )
}

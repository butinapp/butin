import { Badge, Button, cn, Input, Select } from '@butinapp/ui/primitives'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Trash2 } from 'lucide-react'
import { useState } from 'react'

import type { DevCookieDto } from '../../../shared/ipc.js'

import { type CookieGroup, groupCookiesByDomain } from './cookie-grouping.js'

// Chromium evicts once a domain passes ~180 cookies — the failure that silently breaks a re-login (Google's
// Set-Cookie gets dropped). Surface the approach so the bloated domain is obvious before it wedges.
const DOMAIN_CAP = 180
const DOMAIN_WARN = 150

const formatBytes = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`)

const expiryLabel = (c: DevCookieDto): string =>
  c.session || c.expires == null ? 'Session' : new Date(c.expires * 1000).toISOString().slice(0, 10)

const flags = (c: DevCookieDto): string =>
  [c.httpOnly && 'HttpOnly', c.secure && 'Secure', c.sameSite && c.sameSite !== 'unspecified' && c.sameSite]
    .filter(Boolean)
    .join(' · ')

// Count → tone for the cap proximity. null below the warn line.
const capTone = (count: number): 'danger' | 'warning' | null =>
  count >= DOMAIN_CAP ? 'danger' : count >= DOMAIN_WARN ? 'warning' : null

const capCountClass = (count: number): string =>
  count >= DOMAIN_CAP
    ? 'text-destructive'
    : count >= DOMAIN_WARN
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-muted-foreground'

export const CookieJar = () => {
  const qc = useQueryClient()
  const [partition, setPartition] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const copyValue = (key: string, value: string): void => {
    void navigator.clipboard.writeText(value)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1200)
  }

  const { data: partitions = [] } = useQuery({
    queryKey: ['dev', 'partitions'],
    queryFn: () => window.butin.dev.listPartitions()
  })
  const active = partition ?? partitions[0]?.partition ?? null
  const { data: cookies = [] } = useQuery({
    queryKey: ['dev', 'cookies', active],
    queryFn: () => (active ? window.butin.dev.listCookies(active) : Promise.resolve([])),
    enabled: !!active
  })

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['dev', 'cookies', active] })
    void qc.invalidateQueries({ queryKey: ['dev', 'partitions'] })
  }
  const del = useMutation({
    mutationFn: (c: DevCookieDto) =>
      window.butin.dev.deleteCookie(active!, { domain: c.domain, path: c.path, name: c.name, secure: c.secure }),
    onSuccess: invalidate
  })
  const clearDomain = useMutation({
    mutationFn: (domain: string) => window.butin.dev.clearCookieDomain(active!, domain),
    onSuccess: invalidate
  })

  const groups: CookieGroup[] = groupCookiesByDomain(cookies, filter)
  const maxBytes = groups[0]?.bytes ?? 1
  // Keep the selection valid as the filter/partition narrows; fall back to the heaviest visible domain.
  const selected = groups.find((g) => g.domain === selectedDomain) ?? groups[0]
  const totalBytes = cookies.reduce((s, c) => s + c.size, 0)

  return (
    <div className="flex h-[calc(100vh-13rem)] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-60 shrink-0">
          <Select
            value={active ?? ''}
            options={partitions.map((p) => ({ value: p.partition, label: `${p.label} · ${p.count}` }))}
            onValueChange={(v) => {
              setPartition(v)
              setSelectedDomain(null)
            }}
            placeholder="Partition"
          />
        </div>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter domains"
          aria-label="Filter domains"
          className="h-8 min-w-40 flex-1"
        />
        <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
          {cookies.length} · {formatBytes(totalBytes)}
        </span>
      </div>

      {groups.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center rounded-md border text-sm">
          {cookies.length === 0 ? 'No cookies in this partition.' : 'No domains match the filter.'}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3">
          <nav className="w-72 shrink-0 overflow-y-auto rounded-md border" aria-label="Cookie domains">
            {groups.map((g) => {
              const isSel = selected?.domain === g.domain

              return (
                <button
                  key={g.domain}
                  onClick={() => setSelectedDomain(g.domain)}
                  aria-current={isSel}
                  className={cn(
                    'relative flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left transition-colors',
                    isSel ? 'bg-secondary' : 'hover:bg-secondary/50'
                  )}
                >
                  <span
                    aria-hidden
                    className={cn('absolute inset-y-0 left-0', isSel ? 'bg-primary/10' : 'bg-foreground/[0.04]')}
                    style={{ width: `${Math.max(2, (g.bytes / maxBytes) * 100)}%` }}
                  />
                  <span
                    className="text-foreground relative z-10 min-w-0 flex-1 truncate font-mono text-xs"
                    title={g.domain}
                  >
                    {g.domain}
                  </span>
                  <span
                    className={cn('relative z-10 shrink-0 font-mono text-[11px] tabular-nums', capCountClass(g.count))}
                  >
                    {g.count}
                  </span>
                  <span className="text-muted-foreground relative z-10 w-14 shrink-0 text-right font-mono text-[11px] tabular-nums">
                    {formatBytes(g.bytes)}
                  </span>
                </button>
              )
            })}
          </nav>

          <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border">
            {selected ? (
              <>
                <header className="bg-muted sticky top-0 z-10 flex items-center gap-2 border-b px-3 py-2">
                  <span className="truncate font-mono text-sm" title={selected.domain}>
                    {selected.domain}
                  </span>
                  {capTone(selected.count) ? (
                    <Badge variant={capTone(selected.count) === 'danger' ? 'destructive' : 'warning'}>
                      {selected.count >= DOMAIN_CAP ? 'at cookie cap' : 'near cookie cap'}
                    </Badge>
                  ) : null}
                  <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs tabular-nums">
                    {selected.count} cookies · {formatBytes(selected.bytes)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={clearDomain.isPending}
                    onClick={() => clearDomain.mutate(selected.domain)}
                  >
                    Clear domain
                  </Button>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {selected.cookies.map((c) => (
                    <div
                      key={`${c.name}@${c.path}`}
                      className="hover:bg-secondary/40 group flex items-center gap-3 px-3 py-1 transition-colors"
                    >
                      <span className="text-foreground w-44 shrink-0 truncate font-mono text-xs" title={c.name}>
                        {c.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyValue(`${c.name}@${c.path}`, c.value)}
                        title="Click to copy value"
                        className="text-muted-foreground hover:text-foreground min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-xs transition-colors"
                      >
                        {c.value}
                      </button>
                      <span className="text-muted-foreground w-12 shrink-0 text-right font-mono text-[11px] tabular-nums">
                        {c.size} B
                      </span>
                      <span className="text-muted-foreground w-20 shrink-0 font-mono text-[11px]">
                        {expiryLabel(c)}
                      </span>
                      <span
                        className="text-muted-foreground hidden w-36 shrink-0 truncate text-[11px] lg:block"
                        title={flags(c)}
                      >
                        {flags(c)}
                      </span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          title="Copy value"
                          aria-label={`Copy ${c.name}`}
                          onClick={() => copyValue(`${c.name}@${c.path}`, c.value)}
                          className={cn(
                            'transition',
                            copiedKey === `${c.name}@${c.path}`
                              ? 'text-emerald-500 opacity-100'
                              : 'text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                          )}
                        >
                          {copiedKey === `${c.name}@${c.path}` ? (
                            <Check className="size-3.5" />
                          ) : (
                            <Copy className="size-3.5" />
                          )}
                        </button>
                        <button
                          title={`Delete ${c.name}`}
                          aria-label={`Delete ${c.name}`}
                          disabled={del.isPending}
                          onClick={() => del.mutate(c)}
                          className="text-muted-foreground hover:text-destructive opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
                Select a domain.
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

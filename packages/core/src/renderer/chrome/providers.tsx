import { type PluginView, type VerifyResult } from '@butinapp/ui'
import { type ButinLabels, formatRelative, useLabels } from '@butinapp/ui/i18n'
import { Badge, Button, Card, CardContent, cn, Input, ServiceIcon, Switch } from '@butinapp/ui/primitives'
import { ConnDot, connLabel, type ConnState } from '@butinapp/ui/shell'
import { ChevronRight, KeyRound, Loader2, Lock, LogIn, LogOut, RefreshCw, Search, X, Zap } from 'lucide-react'
import { useState } from 'react'

import { groupByCategory } from './group-by-category.js'
import { TestButton } from './test-button.js'

// Status segments for the Data-status toolbar — one per connection state (so every state is filterable), plus
// `stale` (connected but data old/never fetched), `issues` (a failed probe), and `disabled` (this page is the
// one place you switch a plugin back on).
export type ProviderFilter = 'all' | 'connected' | 'unverified' | 'disconnected' | 'stale' | 'issues' | 'disabled'

export type ProviderView = PluginView & {
  // The shared connection state (resolved by the host's usePluginState). `testError` carries the message from a
  // failed probe so the card can surface it and the "issues" filter can find it. `testing` is the shared
  // in-flight flag (also from usePluginState) so the dot pulses in lock-step with every other surface.
  state: ConnState
  testError?: string
  testing?: boolean
  checkedAt?: string
  // Newest report time across the plugin's capabilities (ISO-8601), or absent if nothing is cached. Drives the
  // card's last-refreshed label and the "Needs refresh" filter.
  lastRunAt?: string
  enabled?: boolean
}

export type ProviderAction = 'test' | 'connect' | 'disconnect' | 'refresh'
export type ProviderBusy = { id: string; action: ProviderAction } | null

// Live progress of a bulk Test-all / Refresh-all: which kind is running and how far ("N of M"). The host
// produces it; the toolbar renders it.
export type BulkProgress = { kind: 'test' | 'refresh'; done: number; total: number }

const STATE_VARIANT: Record<ConnState, 'secondary' | 'outline'> = {
  connected: 'secondary',
  unverified: 'secondary',
  disconnected: 'outline'
}

const FILTERS: ProviderFilter[] = ['all', 'connected', 'unverified', 'disconnected', 'stale', 'issues', 'disabled']

const FILTER_LABEL: Record<ProviderFilter, keyof ButinLabels> = {
  all: 'filterAll',
  connected: 'filterConnected',
  unverified: 'filterUnverified',
  disconnected: 'filterDisconnected',
  stale: 'filterStale',
  issues: 'filterIssues',
  disabled: 'filterDisabled'
}

const filterLabel = (t: ButinLabels, f: ProviderFilter): string => t[FILTER_LABEL[f]] as string

// A service "needs refresh" when it has a usable session (enabled, not disconnected) but its data is stale:
// never fetched, or older than the freshness window. After a Refresh-all sweep this isolates the services you
// reconnected by hand (their data predates the batch) from the ones refreshed minutes ago — so filtering to it
// and hitting Refresh-all (which targets the visible set) touches exactly those.
const STALE_AFTER_MS = 12 * 60 * 60 * 1000

const needsRefresh = (p: ProviderView, nowMs: number): boolean =>
  p.enabled !== false &&
  p.state !== 'disconnected' &&
  (!p.lastRunAt || nowMs - Date.parse(p.lastRunAt) > STALE_AFTER_MS)

const matchesFilter = (p: ProviderView, f: ProviderFilter, nowMs: number): boolean =>
  f === 'connected'
    ? p.state === 'connected'
    : f === 'unverified'
      ? p.state === 'unverified'
      : f === 'disconnected'
        ? p.state === 'disconnected'
        : f === 'stale'
          ? needsRefresh(p, nowMs)
          : f === 'issues'
            ? p.testError != null
            : f === 'disabled'
              ? p.enabled === false
              : true

// Connected+enabled first, then connected, then enabled, then the rest — so the services you actively run
// float to the top of a long list. Alphabetical within a rank.
const rank = (p: ProviderView): number => (p.state !== 'disconnected' ? 0 : 2) + (p.enabled !== false ? 0 : 1)

// The providers overview — every connectable service, its connection health, and the connection
// actions (Test / Connect-or-Reconnect / Disconnect). Pure + prop-driven; the host owns the IPC.
export const ProvidersPage = ({
  providers,
  busy,
  onOpen,
  onTest,
  onConnect,
  onDisconnect,
  onRefresh,
  onToggleEnabled,
  onTestAll,
  onRefreshAll,
  refreshSummary,
  onDismissSummary,
  bulkProgress
}: {
  providers: ProviderView[]
  busy: ProviderBusy
  onOpen: (id: string) => void
  // Resolves the probe's ok so the Test button can flash its outcome (green check / red cross).
  onTest: (id: string) => Promise<VerifyResult>
  onConnect: (id: string) => void
  onDisconnect: (id: string) => void
  onRefresh: (id: string) => void
  onToggleEnabled: (id: string, enabled: boolean) => void
  onTestAll?: (ids: string[]) => void
  onRefreshAll?: (ids: string[]) => void
  // Result of the last bulk Refresh-all: how many refreshed vs. how many failed their probe and need a
  // manual reconnect. Pure display — the per-card Reconnect buttons do the actual work.
  refreshSummary?: { refreshed: number; needsReconnect: string[] }
  // Clears the summary banner. The host also auto-clears it once its counts go stale (a reconnect/refresh).
  onDismissSummary?: () => void
  // Live progress of an in-flight bulk action, so the Test-all / Refresh-all button reads "N of M" while it
  // walks the services instead of looking frozen. Null when no bulk action is running.
  bulkProgress?: BulkProgress | null
}) => {
  const t = useLabels()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ProviderFilter>('all')

  if (providers.length === 0) {
    return <p className="text-muted-foreground text-sm">{t.noServicesRegistered}</p>
  }

  const spin = (id: string, action: ProviderAction): boolean => busy?.id === id && busy.action === action
  // A card's actions lock while it has a single action in flight OR a bulk Test-all / Refresh-all is sweeping
  // (those run several services at once, so there's no single busy id to key off).
  const anyBusy = (id: string): boolean => busy?.id === id || bulkProgress != null

  const q = query.trim().toLowerCase()
  const nowMs = Date.now()
  const visible = providers
    .filter((p) => matchesFilter(p, filter, nowMs))
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.vendor?.toLowerCase().includes(q) ?? false))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))

  // Bulk actions target the VISIBLE (filtered + searched) set, so narrowing the list narrows what they touch.
  // Test re-probes every enabled service in view — including disconnected ones, so filtering to "issues" and
  // hitting Test-all re-checks exactly those; Refresh needs a live session, so it skips the disconnected.
  const testableIds = visible.filter((p) => p.enabled !== false).map((p) => p.id)
  const refreshableIds = visible.filter((p) => p.state !== 'disconnected' && p.enabled !== false).map((p) => p.id)
  const bulkDisabled = busy !== null || bulkProgress != null

  const renderCard = (p: ProviderView) => {
    const connected = p.state !== 'disconnected'
    const disabled = p.enabled === false

    return (
      <Card key={p.id} className="gap-0 overflow-hidden py-0">
        <span
          className={cn('block h-1', disabled && 'opacity-40')}
          style={{ backgroundColor: p.color ?? 'var(--border)' }}
        />
        <CardContent className="space-y-3 px-4 py-3">
          {/* Body content recedes when the service is dormant; the action row below stays full-strength so the
              Enable toggle (the one way out of "off") never reads as disabled. */}
          <div className={cn('space-y-3', disabled && 'opacity-55')}>
            <div className="flex items-start justify-between gap-2">
              {/* Dormant cards don't open — there's nothing to act on until enabled, so the title is inert
                  (no button, no chevron, no hover) and the Lock icon is the only header affordance. */}
              {disabled ? (
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <ServiceIcon id={p.id} icon={p.icon} name={p.name} color={p.color} size={16} />
                    <span className="truncate font-medium">{p.name}</span>
                    <Lock className="text-muted-foreground size-3 shrink-0" aria-label="disabled" />
                    {p.version ? (
                      <span className="text-muted-foreground shrink-0 text-[10px] font-normal">v{p.version}</span>
                    ) : null}
                  </div>
                  {p.description ? (
                    <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{p.description}</p>
                  ) : null}
                </div>
              ) : (
                <button onClick={() => onOpen(p.id)} className="group min-w-0 text-left">
                  <div className="flex items-center gap-1.5">
                    <ServiceIcon id={p.id} icon={p.icon} name={p.name} color={p.color} size={16} />
                    <span className="truncate font-medium">{p.name}</span>
                    {p.version ? (
                      <span className="text-muted-foreground shrink-0 text-[10px] font-normal">v{p.version}</span>
                    ) : null}
                    <ChevronRight className="text-muted-foreground size-3.5 transition group-hover:translate-x-0.5" />
                  </div>
                  {p.description ? (
                    <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{p.description}</p>
                  ) : null}
                </button>
              )}
              <div className="flex items-center gap-1.5 whitespace-nowrap">
                <ConnDot state={p.state} testing={p.testing} />
                <Badge variant={STATE_VARIANT[p.state]} className="text-[10px]">
                  {connLabel(t, p.state)}
                </Badge>
              </div>
            </div>

            {p.testError ? (
              <p className="text-destructive/90 line-clamp-2 text-[11px] break-all">{p.testError}</p>
            ) : (
              <p className="text-muted-foreground text-xs">
                {t.reportCount(p.capabilities.length)}
                {p.capabilities.length ? ` · ${p.capabilities.map((c) => c.label).join(', ')}` : ''}
              </p>
            )}
            {!disabled ? (
              <p className="text-muted-foreground/80 text-[11px]">
                {p.lastRunAt
                  ? t.lastRefreshed(formatRelative(new Date(p.lastRunAt), new Date(), t.intlLocale))
                  : t.neverRefreshed}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Dormant: no connection actions to offer — only the Enable switch wakes the card. Enabling reveals
                the Test / Connect / Disconnect / Refresh row. */}
            {disabled ? (
              <span className="text-muted-foreground text-xs">{t.enableToUseHint}</span>
            ) : (
              <>
                {connected ? <TestButton onTest={() => onTest(p.id)} disabled={anyBusy(p.id)} /> : null}
                <Button
                  size="sm"
                  variant={connected ? 'outline' : 'default'}
                  disabled={anyBusy(p.id)}
                  onClick={() => onConnect(p.id)}
                >
                  {spin(p.id, 'connect') ? <Loader2 className="animate-spin" /> : connected ? <KeyRound /> : <LogIn />}
                  {connected ? t.reconnect : t.connect}
                </Button>
                {connected ? (
                  <Button size="sm" variant="outline" disabled={anyBusy(p.id)} onClick={() => onDisconnect(p.id)}>
                    {spin(p.id, 'disconnect') ? <Loader2 className="animate-spin" /> : <LogOut />} {t.clearSession}
                  </Button>
                ) : null}
                {connected ? (
                  <Button size="sm" variant="ghost" disabled={anyBusy(p.id)} onClick={() => onRefresh(p.id)}>
                    {spin(p.id, 'refresh') ? <Loader2 className="animate-spin" /> : <RefreshCw />} {t.refreshData}
                  </Button>
                ) : null}
              </>
            )}
            <label className="text-muted-foreground ml-auto flex items-center gap-1.5 text-xs">
              {t.enabledLabel}
              <Switch checked={p.enabled !== false} onCheckedChange={(v) => onToggleEnabled(p.id, v)} />
            </label>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {refreshSummary && (refreshSummary.refreshed > 0 || refreshSummary.needsReconnect.length > 0) ? (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <RefreshCw className="size-3.5 shrink-0" />
          <span>{t.refreshSummary(refreshSummary.refreshed, refreshSummary.needsReconnect.length)}</span>
          {onDismissSummary ? (
            <button
              onClick={onDismissSummary}
              aria-label={t.dismissSummary}
              className="ml-auto rounded p-0.5 transition hover:bg-amber-500/20"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-44 flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.searchPlaceholder}
            className="h-8 pl-7 text-xs"
          />
        </div>
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? 'secondary' : 'ghost'}
              className={cn('h-8 text-xs', filter !== f && 'text-muted-foreground')}
              onClick={() => setFilter(f)}
            >
              {filterLabel(t, f)}
            </Button>
          ))}
        </div>
        {onTestAll ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={bulkDisabled || testableIds.length === 0}
            onClick={() => onTestAll(testableIds)}
          >
            {bulkProgress?.kind === 'test' ? <Loader2 className="animate-spin" /> : <Zap />}
            {bulkProgress?.kind === 'test'
              ? t.testingProgress(bulkProgress.done, bulkProgress.total)
              : t.testAllCount(testableIds.length)}
          </Button>
        ) : null}
        {onRefreshAll ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={bulkDisabled || refreshableIds.length === 0}
            onClick={() => onRefreshAll(refreshableIds)}
          >
            {bulkProgress?.kind === 'refresh' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {bulkProgress?.kind === 'refresh'
              ? t.refreshingProgress(bulkProgress.done, bulkProgress.total)
              : t.refreshAllCount(refreshableIds.length)}
          </Button>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t.noServicesMatch}</p>
      ) : (
        <div className="space-y-5">
          {groupByCategory(visible).map(([cat, rows]) => (
            <section key={cat} className="space-y-3">
              <h2 className="text-muted-foreground px-1 text-[10px] font-medium tracking-wider uppercase">
                {t.category[cat]}
              </h2>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{rows.map(renderCard)}</div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

import { deriveDailySpend, type DailyPoint, type Ledger, type LedgerRow, type StoredColumn } from '@butinapp/shapes'
import { type VerifyResult } from '@butinapp/ui'
import { formatBytes, formatRelative, useLabels } from '@butinapp/ui/i18n'
import { Button, Card, CardContent, cn, Switch, Tooltip, TooltipContent, TooltipTrigger } from '@butinapp/ui/primitives'
import { ConnDot, connLabel, type ConnState } from '@butinapp/ui/shell'
import {
  AppWindow,
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  ExternalLink,
  Eye,
  FileText,
  FolderOpen,
  HardDrive,
  KeyRound,
  Loader2,
  RefreshCw,
  Trash2,
  Unplug
} from 'lucide-react'
import { Fragment, useState, type ReactNode } from 'react'

import { ExtractAllControl, type ExtractAllProgressView } from '../extract/extract-all-control.js'
import { PluginConfigForm, type PluginConfigFormProps } from '../settings/plugin-config-form.js'
import { TestButton } from '../test-button.js'

export type ServiceSettingsBusy = {
  reconnect?: boolean
  test?: boolean
  disconnect?: boolean
  refreshAll?: boolean
  eraseData?: boolean
  move?: boolean
}

// A profile this service's stored state can be handed to (the active profile is excluded by the host).
export type MoveTargetProfile = { id: string; name: string }

// An additional login a service needs beyond its primary session (a backend on a different host that
// requires its own Magic Login). Declared here rather than imported so @butinapp/ui stays free of core; it is
// structurally compatible with the DTO core sends. `key` is passed back to the reconnect/disconnect handlers.
export type SecondarySessionView = { key: string; label: string; connected: boolean }

// One row of the data inventory: a capability + how much it holds, when it last ran, and the count of
// ledger series points (only summary-bearing capabilities accumulate a series → others report 0 + no spark).
export type ServiceInventoryRow = {
  id: string
  label: string
  recordCount: number
  lastRunAt?: string
  snapshotCount: number
  spark?: number[]
}

// How Butin reads this service, for the "Under the hood" section. Declared here rather than imported so
// @butinapp/ui stays free of core; it is structurally compatible with the DTO core sends.
export type ServiceMechanicsView = {
  authKind: string
  authSummary: string
  transportEngine: 'node' | 'electron'
  requiresBrowserEngine: boolean
  cookieDomains: string[]
  loginUrl?: string
  requiredCookie?: string
  category?: string
  homepage?: string
  version?: string
}

// The folder footprint, computed async by the host: `pending` while the walk runs, then the totals.
// `documentCount` is the subset that survives a normal erase/uninstall (downloaded documents), so the UI can
// note those are kept.
export type FolderStatsView = { pending: boolean; fileCount?: number; totalBytes?: number; documentCount?: number }

// The body of the service page's trailing "Settings" tab: a full service-detail view. At-a-glance stats,
// a per-capability data inventory, the connection controls, a collapsible "Under the hood" (how Butin
// reads the service), configuration, and a manage/danger zone. Pure + prop-driven — the host owns every
// IPC call. Sessionless (`external`) plugins connect by entering config, so their Connection card renders
// the config form instead of the Magic Login / Test / Disconnect trio.
export const ServiceSettingsPanel = ({
  sessionless,
  connected,
  testing,
  enabled,
  description,
  dashboardUrl,
  dashboardOpensInApp,
  inventory,
  recordCount,
  lastSyncedAt,
  folderStats,
  mechanics,
  folderPath,
  health,
  busy,
  extracting,
  extractProgress,
  onReconnect,
  onTest,
  onDisconnect,
  serviceName,
  secondarySessions,
  secondaryBusy,
  onSecondaryReconnect,
  onSecondaryTest,
  onSecondaryDisconnect,
  onToggleEnabled,
  onRefreshAll,
  onRefreshCapability,
  onViewCapability,
  onExtract,
  onRevealFolder,
  onEraseData,
  onOpenDashboard,
  configForm,
  moveTargets,
  onMoveToProfile,
  onUninstall,
  devMode,
  ledgers,
  onLoadLedger
}: {
  sessionless: boolean
  connected: boolean
  // Shared in-flight probe flag (from usePluginState) — pulses the Connection card's status dot in lock-step
  // with the same service's dot in the sidebar / header / Management while a Test is running.
  testing?: boolean
  enabled: boolean
  // A one-line description of what this service brings home — rendered as the page's intro line.
  description?: string
  // The service's own dashboard URL (meta.dashboardUrl) — rendered as an "Open <host>" link in the
  // Connection card. Absent → no link. The host opens it via onOpenDashboard.
  dashboardUrl?: string
  // When true the dashboard opens INSIDE the captured Butin session (browse mode) — the link reads "Open in
  // Butin" with an in-app icon. When false/omitted it opens in the OS browser ("Open dashboard").
  dashboardOpensInApp?: boolean
  // The per-capability data inventory (records / freshness / history / trend).
  inventory: ServiceInventoryRow[]
  // Σ records across cached capabilities (the "Records cached" stat).
  recordCount?: number
  // Newest lastRunAt across capabilities (the "Last synced" stat).
  lastSyncedAt?: string
  // The folder footprint, computed async so the page paints first.
  folderStats?: FolderStatsView
  // How Butin reads this service (auth/transport/session), for "Under the hood". Absent off-Electron tests.
  mechanics?: ServiceMechanicsView
  folderPath?: string
  // Result of the last in-session connection test (session plugins only); undefined = not tested yet.
  health?: VerifyResult
  busy?: ServiceSettingsBusy
  extracting?: boolean
  extractProgress?: ExtractAllProgressView
  onReconnect: () => void
  // Resolves the probe result so the Test button can flash its outcome (green check / red cross) and surface
  // the failure reason.
  onTest: () => Promise<VerifyResult>
  onDisconnect: () => void
  // The primary login's display name (the service name) — labels the primary row's connection when a
  // secondary login is present, so the two rows are distinguishable.
  serviceName?: string
  // Additional logins beyond the primary session (a backend with its own `session`). Each renders a
  // labelled connect/reconnect + test + disconnect row in the Connection card; the handlers take the key.
  secondarySessions?: SecondarySessionView[]
  secondaryBusy?: Record<string, boolean>
  onSecondaryReconnect?: (key: string) => void
  onSecondaryTest?: (key: string) => Promise<VerifyResult>
  onSecondaryDisconnect?: (key: string) => void
  onToggleEnabled: (enabled: boolean) => void
  onRefreshAll: () => void
  // Refresh / jump to a single capability from its inventory row.
  onRefreshCapability?: (capabilityId: string) => void
  onViewCapability?: (capabilityId: string) => void
  onExtract: () => void
  onRevealFolder: () => void
  onEraseData: () => void
  // Open the service's dashboard URL in the user's browser. Only called when dashboardUrl is set.
  onOpenDashboard?: () => void
  // The plugin's config form, when it declares any fields. Sessionless plugins: it IS the Connection card.
  // Session plugins: it renders in its own Configuration card. Absent when the plugin has no config fields.
  configForm?: PluginConfigFormProps
  // Other profiles this service's stored state can move to. Empty/undefined → the move control is hidden
  // (a single-profile install has nowhere to move to).
  moveTargets?: MoveTargetProfile[]
  onMoveToProfile?: (targetProfileId: string) => void
  // Remove the service from the roster (back to Available) — wipes session/config/cached data. Hidden when
  // absent. Destructive, so the button arms a confirm before firing; `eraseFolder` carries whether the user
  // also opted to delete the whole on-disk data folder (downloaded documents + extracts).
  onUninstall?: (eraseFolder: boolean) => void
  // Developer mode (an app setting): reveals the per-capability raw-ledger debug panel below "Under the hood".
  devMode?: boolean
  // capabilityId → its raw ledger, fetched lazily by the host: undefined = not yet loaded (panel calls
  // onLoadLedger on first expand), null = loaded but nothing recorded, Ledger = the stored history.
  ledgers?: Record<string, Ledger | null>
  onLoadLedger?: (capabilityId: string) => void
}) => {
  const t = useLabels()
  const anyBusy = Boolean(
    busy?.reconnect ||
    busy?.test ||
    busy?.disconnect ||
    busy?.refreshAll ||
    busy?.eraseData ||
    busy?.move ||
    (secondaryBusy && Object.values(secondaryBusy).some(Boolean))
  )
  const hasSecondary = Boolean(secondarySessions?.length)

  // Connection status in the Connection card header — derives from the shared connection vocabulary so it
  // reads identically to the sidebar dot and the service header pill. A test outcome takes precedence (a
  // config that Tests red stops reading "connected" off a filled form); otherwise it's the resting
  // stored-session / config-filled state, which is "unverified" until a probe confirms it.
  const connStatus: ConnState = health
    ? health.ok
      ? 'connected'
      : 'disconnected'
    : connected
      ? 'unverified'
      : 'disconnected'
  const status = (
    <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
      <ConnDot state={connStatus} testing={testing} />
      {connLabel(t, connStatus)}
    </span>
  )

  // A single left-aligned column at the page's width cap (the page owns mx-auto/max-w), so the panel's
  // edges line up with the header + tab strip.
  return (
    <div className="w-full space-y-3">
      {/* What this service brings home — the page's intro line. */}
      {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}

      {/* At-a-glance stats. Files + On disk come from the async folder walk → they shimmer until resolved. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          icon={<Database className="size-3.5" />}
          label={t.statRecords}
          value={(recordCount ?? 0).toLocaleString(t.intlLocale)}
        />
        <StatTile
          icon={<FileText className="size-3.5" />}
          label={t.statFiles}
          value={folderStats?.fileCount?.toLocaleString(t.intlLocale)}
          pending={folderStats?.pending}
        />
        <StatTile
          icon={<HardDrive className="size-3.5" />}
          label={t.statOnDisk}
          value={folderStats?.totalBytes != null ? formatBytes(folderStats.totalBytes) : undefined}
          pending={folderStats?.pending}
        />
        <StatTile
          icon={<Clock className="size-3.5" />}
          label={t.statLastSynced}
          value={lastSyncedAt ? formatRelative(new Date(lastSyncedAt), new Date(), t.intlLocale) : t.never}
        />
      </div>

      {/* Data inventory — the centerpiece: what's cached, how fresh, how deep, and a trend. */}
      <Section
        title={t.settingsData}
        headerRight={
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" variant="ghost" disabled={!connected || anyBusy} onClick={onRefreshAll}>
              {busy?.refreshAll ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t.refreshAllTabs}
            </Button>
            <ExtractAllControl
              running={Boolean(extracting)}
              disabled={!connected}
              progress={extractProgress}
              onExtract={onExtract}
            />
          </div>
        }
      >
        {inventory.length > 0 ? (
          <DataInventory
            rows={inventory}
            onRefresh={onRefreshCapability}
            onView={onViewCapability}
            refreshDisabled={!connected || anyBusy}
          />
        ) : (
          <p className="text-muted-foreground text-xs">{t.noDataYet}</p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          {folderPath ? (
            <button
              onClick={onRevealFolder}
              className="text-muted-foreground hover:text-foreground flex min-w-0 items-center gap-1.5 text-left text-xs transition-colors"
              title={folderPath}
            >
              <FolderOpen className="size-3.5 shrink-0" />
              <span className="truncate font-mono">{folderPath}</span>
            </button>
          ) : (
            <span />
          )}
          <EraseButton
            busy={Boolean(busy?.eraseData)}
            disabled={anyBusy}
            documentCount={folderStats?.documentCount}
            onErase={onEraseData}
          />
        </div>
      </Section>

      {/* Connection — sessionless plugins render their config form here (it IS their connection). */}
      <Section title={t.settingsConnection} headerRight={status}>
        {sessionless ? (
          configForm ? (
            <PluginConfigForm {...configForm} />
          ) : null
        ) : (
          <>
            {health && !health.ok && health.error ? (
              <p className="text-destructive text-xs break-all">{health.error}</p>
            ) : null}
            {/* With a secondary login, each row is labelled (name + dot) so the two are easy to tell apart. */}
            <div className="flex flex-wrap items-center gap-2">
              {hasSecondary ? (
                <span className="text-muted-foreground flex w-28 min-w-0 items-center gap-1.5 text-xs">
                  <Dot ok={connected} />
                  <span className="truncate" title={serviceName ?? t.settingsConnection}>
                    {serviceName ?? t.settingsConnection}
                  </span>
                </span>
              ) : null}
              <Button size="sm" variant="outline" disabled={anyBusy} onClick={onReconnect}>
                {busy?.reconnect ? <Loader2 className="animate-spin" /> : <KeyRound />}
                {connected ? t.reconnect : t.connect}
              </Button>
              {connected ? <TestButton onTest={onTest} disabled={anyBusy} /> : null}
              {connected ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  disabled={anyBusy}
                  onClick={onDisconnect}
                >
                  {busy?.disconnect ? <Loader2 className="animate-spin" /> : <Unplug />}
                  {t.disconnect}
                </Button>
              ) : null}
            </div>
            {/* Additional logins (a backend on a different host with its own session) — each its own row. */}
            {secondarySessions?.map((s) => (
              <div key={s.key} className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground flex w-28 min-w-0 items-center gap-1.5 text-xs">
                  <Dot ok={s.connected} />
                  <span className="truncate" title={s.label}>
                    {s.label}
                  </span>
                </span>
                <Button size="sm" variant="outline" disabled={anyBusy} onClick={() => onSecondaryReconnect?.(s.key)}>
                  {secondaryBusy?.[s.key] ? <Loader2 className="animate-spin" /> : <KeyRound />}
                  {s.connected ? t.reconnect : t.connect}
                </Button>
                {s.connected ? (
                  <TestButton
                    onTest={() => onSecondaryTest?.(s.key) ?? Promise.resolve({ ok: false })}
                    disabled={anyBusy}
                  />
                ) : null}
                {s.connected ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    disabled={anyBusy}
                    onClick={() => onSecondaryDisconnect?.(s.key)}
                  >
                    {secondaryBusy?.[s.key] ? <Loader2 className="animate-spin" /> : <Unplug />}
                    {t.disconnect}
                  </Button>
                ) : null}
              </div>
            ))}
          </>
        )}
        {dashboardUrl ? (
          <button
            onClick={onOpenDashboard}
            className="text-muted-foreground hover:text-foreground flex min-w-0 max-w-full items-center gap-1.5 text-left text-xs transition-colors"
            title={dashboardUrl}
          >
            {/* In-app browse uses a window icon; an external open keeps the external-link icon. The label names
                the destination so it's clear whether the site opens inside Butin or in the OS browser. */}
            {dashboardOpensInApp ? (
              <AppWindow className="size-3.5 shrink-0" />
            ) : (
              <ExternalLink className="size-3.5 shrink-0" />
            )}
            <span className="shrink-0">{dashboardOpensInApp ? t.openInButin : t.openDashboard}</span>
            <span className="truncate font-mono">{hostOf(dashboardUrl)}</span>
          </button>
        ) : null}
      </Section>

      {/* Under the hood — how Butin reads this service. A developer-mode disclosure alongside the raw-ledger
          panel; the everyday view stays free of the auth/transport internals. */}
      {devMode && mechanics ? <UnderTheHood mechanics={mechanics} /> : null}

      {/* Ledger (debug) — the raw daily-change history per capability, gated behind developer mode. */}
      {devMode && inventory.length > 0 ? (
        <LedgerDebug capabilities={inventory} ledgers={ledgers} onLoad={onLoadLedger} />
      ) : null}

      {/* Configuration — session plugins keep their stored session in the Connection card; config the session
          can't supply (e.g. Groq's org id) gets its own card. Sessionless plugins render the form above. */}
      {!sessionless && configForm ? (
        <Section title={t.settingsConfiguration}>
          {/* The form holds a couple of short fields — cap its width so the input + Save button don't stretch. */}
          <div className="max-w-xl">
            <PluginConfigForm {...configForm} onTest={undefined} />
          </div>
        </Section>
      ) : null}

      {/* Manage & danger zone — enable/disable, move, uninstall. Set apart from the informational content. */}
      <Section title={t.settingsManage} className="border-destructive/30">
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>{t.enabledLabel}</span>
          <Switch checked={enabled} onCheckedChange={onToggleEnabled} />
        </label>
        <p className="text-muted-foreground text-xs">{t.enabledHint}</p>

        {moveTargets && moveTargets.length > 0 && onMoveToProfile ? (
          <MoveToProfile targets={moveTargets} busy={Boolean(busy?.move)} disabled={anyBusy} onMove={onMoveToProfile} />
        ) : null}

        {onUninstall ? (
          <div className="border-border/60 border-t pt-3">
            <UninstallButton
              disabled={anyBusy}
              fileCount={folderStats?.fileCount}
              documentCount={folderStats?.documentCount}
              onUninstall={onUninstall}
            />
          </div>
        ) : null}
      </Section>
    </div>
  )
}

// The bare hostname of a URL (e.g. "sentry.io"), for naming the Open-dashboard destination. Falls back to
// the raw string if it doesn't parse as a URL.
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

// One at-a-glance tile. `pending` (the async folder-stat tiles) shows a spinner + shimmer until the value
// resolves; a tile with no value and no pending flag shows an em-dash.
const StatTile = ({
  icon,
  label,
  value,
  pending
}: {
  icon?: ReactNode
  label: string
  value?: string
  pending?: boolean
}) => (
  <div className="bg-card rounded-lg border px-3 py-2.5">
    <div className="text-muted-foreground flex items-center gap-1.5 text-[10px] tracking-wide uppercase">
      {pending ? <Loader2 className="size-3 animate-spin" /> : icon}
      {label}
    </div>
    {pending ? (
      <div className="bg-muted mt-1.5 h-4 w-12 animate-pulse rounded" />
    ) : (
      <div className="mt-1 truncate text-lg font-semibold tabular-nums" title={value}>
        {value ?? '—'}
      </div>
    )}
  </div>
)

// A tiny bar sparkline from a snapshot value series. Fewer than two points → an em-dash (no trend yet).
const Sparkline = ({ values }: { values: number[] }) => {
  if (values.length < 2) {
    return <span className="text-muted-foreground">—</span>
  }

  const recent = values.slice(-12)
  const max = Math.max(...recent, 1)

  return (
    <span className="inline-flex h-4 items-end gap-px" aria-hidden>
      {recent.map((v, i) => (
        <span
          key={i}
          className="bg-muted-foreground/40 w-1 rounded-[1px]"
          style={{ height: `${Math.max(2, (v / max) * 16)}px` }}
        />
      ))}
    </span>
  )
}

const DataInventory = ({
  rows,
  onRefresh,
  onView,
  refreshDisabled
}: {
  rows: ServiceInventoryRow[]
  onRefresh?: (id: string) => void
  onView?: (id: string) => void
  // A per-row refresh runs a live fetch, so it's gated on connection/in-flight state — matching "Refresh all
  // tabs". Viewing a row (cached data) stays available regardless.
  refreshDisabled?: boolean
}) => {
  const t = useLabels()

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="text-left">
            <th className="py-1 pr-4 font-medium">{t.invCapability}</th>
            <th className="py-1 pr-8 text-right font-medium">{t.invRecords}</th>
            <th className="py-1 pr-4 font-medium">{t.invLastFetched}</th>
            <th className="py-1 pr-8 text-right font-medium">{t.invHistory}</th>
            <th className="py-1 pr-4 font-medium">{t.invTrend}</th>
            <th className="py-1 font-medium" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-border/50 border-t">
              <td className="py-1.5 pr-4">
                <span className="block max-w-[16rem] truncate" title={r.label}>
                  {r.label}
                </span>
              </td>
              <td className="py-1.5 pr-8 text-right tabular-nums">{r.recordCount.toLocaleString(t.intlLocale)}</td>
              <td className="text-muted-foreground py-1.5 pr-4 whitespace-nowrap">
                {r.lastRunAt ? formatRelative(new Date(r.lastRunAt), new Date(), t.intlLocale) : t.never}
              </td>
              <td className="py-1.5 pr-8 text-right tabular-nums">
                {r.snapshotCount > 0 ? r.snapshotCount.toLocaleString(t.intlLocale) : '—'}
              </td>
              <td className="py-1.5 pr-4">
                {r.spark ? <Sparkline values={r.spark} /> : <span className="text-muted-foreground">—</span>}
              </td>
              <td className="py-1.5">
                <div className="flex items-center justify-end gap-2">
                  {onRefresh ? (
                    <button
                      onClick={() => onRefresh(r.id)}
                      disabled={refreshDisabled}
                      aria-label={`${t.refresh} ${r.label}`}
                      className="text-muted-foreground hover:text-foreground transition-colors disabled:pointer-events-none disabled:opacity-40"
                    >
                      <RefreshCw className="size-3.5" />
                    </button>
                  ) : null}
                  {onView ? (
                    <button
                      onClick={() => onView(r.id)}
                      aria-label={`${t.invView} ${r.label}`}
                      className="text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                    >
                      <Eye className="size-3.5" />
                      {t.invView}
                    </button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// The collapsible "how Butin reads this service" disclosure — plain-language summary + the mechanics.
const UnderTheHood = ({ mechanics }: { mechanics: ServiceMechanicsView }) => {
  const t = useLabels()
  const [open, setOpen] = useState(false)

  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-3 px-4 py-4">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-2"
        >
          <h3 className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {t.settingsUnderHood}
          </h3>
          <span className="text-muted-foreground text-[11px]">{t.underHoodSubtitle}</span>
        </button>

        {open ? (
          <dl className="grid grid-cols-[150px_1fr] gap-x-4 gap-y-1.5 text-xs">
            <Kv k={t.mechHowConnects}>{mechanics.authSummary}</Kv>
            <Kv k={t.mechAuth} mono>
              {mechanics.authKind}
            </Kv>
            <Kv k={t.mechTransport} mono>
              {mechanics.transportEngine}
              {mechanics.requiresBrowserEngine ? ` · ${t.requiresBrowserEngineLabel}` : ''}
            </Kv>
            {mechanics.cookieDomains.length > 0 ? (
              <Kv k={t.mechCookieDomains} mono>
                {mechanics.cookieDomains.join(', ')}
              </Kv>
            ) : null}
            {mechanics.loginUrl ? (
              <Kv k={t.mechSignIn} mono>
                {mechanics.loginUrl}
              </Kv>
            ) : null}
            <Kv k={t.mechPlugin} mono>
              {[mechanics.category, mechanics.version ? `v${mechanics.version}` : undefined]
                .filter(Boolean)
                .join(' · ')}
            </Kv>
          </dl>
        ) : null}
      </CardContent>
    </Card>
  )
}

// Developer-mode debug panel: the raw daily-change ledger per capability — the append-only history (row
// versions + facet series) the sparklines/spend series are derived from. Collapsed by default; each
// capability's ledger is fetched lazily by the host the first time its row is expanded (onLoad fires only
// when nothing is cached for that id yet).
const LedgerDebug = ({
  capabilities,
  ledgers,
  onLoad
}: {
  capabilities: ServiceInventoryRow[]
  ledgers?: Record<string, Ledger | null>
  onLoad?: (capabilityId: string) => void
}) => {
  const t = useLabels()
  const [open, setOpen] = useState(false)
  const [openCap, setOpenCap] = useState<Record<string, boolean>>({})

  const toggleCap = (id: string): void =>
    setOpenCap((prev) => {
      const next = !prev[id]

      if (next && ledgers?.[id] === undefined) {
        onLoad?.(id)
      }

      return { ...prev, [id]: next }
    })

  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-3 px-4 py-4">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-2"
        >
          <h3 className="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {t.settingsLedgerDebug}
          </h3>
          <span className="text-muted-foreground text-[11px]">{t.ledgerDebugSubtitle}</span>
        </button>

        {open ? (
          <ul className="space-y-1.5">
            {capabilities.map((c) => {
              const capOpen = Boolean(openCap[c.id])
              const led = ledgers?.[c.id]

              return (
                <li key={c.id} className="border-border/50 rounded-md border">
                  <button
                    onClick={() => toggleCap(c.id)}
                    aria-expanded={capOpen}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs font-medium"
                  >
                    {capOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    {c.label}
                  </button>
                  {capOpen ? (
                    <div className="border-border/50 border-t px-2.5 py-2">
                      {led === undefined ? (
                        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                          <Loader2 className="size-3.5 animate-spin" />
                          {t.ledgerLoading}
                        </p>
                      ) : led === null ? (
                        <p className="text-muted-foreground text-xs">{t.ledgerNoData}</p>
                      ) : (
                        <LedgerBody ledger={led} />
                      )}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  )
}

// A ledger timestamp as a compact date + minute (raw + precise, what a debugger wants), e.g. 2026-06-17 14:03.
const fmtStamp = (iso: string): string => iso.slice(0, 16).replace('T', ' ')

// The derived per-day series for one row's cumulative column — the same differencing the Trend/expand draws,
// recomputed here from the raw versions so the debug panel shows the readings and the derived result together
// (so an empty trend's cause is visible: e.g. two readings → one delta → below the sparkline's two-point floor).
const rowDerivedDaily = (row: LedgerRow, col: StoredColumn): DailyPoint[] => {
  const readings = row.versions
    .map((v) => ({ date: v.from.slice(0, 10), capturedAt: v.from, section: '', value: Number(v.data[col.key]) }))
    .filter((r) => Number.isFinite(r.value))

  return deriveDailySpend(readings, col.resetPeriod)
}

// One capability's stored ledger: the keyed datasets (row id + presence window + version count, each row
// expandable to its raw version history) and the per-section headline series (point count + date span).
const LedgerBody = ({ ledger }: { ledger: Ledger }) => {
  const t = useLabels()
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({})

  if (ledger.datasets.length === 0 && ledger.series.length === 0) {
    return <p className="text-muted-foreground text-xs">{t.ledgerNoData}</p>
  }

  return (
    <div className="space-y-3">
      {ledger.datasets.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-muted-foreground text-[10px] tracking-wide uppercase">{t.ledgerDatasetsTitle}</h4>
          {ledger.datasets.map((d) => {
            const cumulativeCols = d.columns.filter((c) => c.accrual === 'cumulative')

            return (
              <div key={d.id} className="space-y-1">
                <div className="font-mono text-[11px]">
                  {d.id} · {d.rows.length} {t.ledgerRows}
                </div>
                <table className="w-full text-[11px]">
                  <thead className="text-muted-foreground">
                    <tr className="text-left">
                      <th className="py-0.5 pr-3 font-medium">{t.ledgerColRow}</th>
                      <th className="py-0.5 pr-3 font-medium">{t.ledgerColFirstSeen}</th>
                      <th className="py-0.5 pr-3 font-medium">{t.ledgerColLastSeen}</th>
                      <th className="py-0.5 text-right font-medium">{t.ledgerColVersions}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.map((r) => {
                      const rowKey = `${d.id}::${r.id}`
                      const rowOpen = Boolean(openRows[rowKey])

                      return (
                        <Fragment key={rowKey}>
                          <tr
                            onClick={() => setOpenRows((p) => ({ ...p, [rowKey]: !p[rowKey] }))}
                            className="border-border/40 hover:bg-muted/40 cursor-pointer border-t"
                          >
                            <td className="max-w-40 truncate py-0.5 pr-3 font-mono">{r.id}</td>
                            <td className="text-muted-foreground py-0.5 pr-3 tabular-nums">{fmtStamp(r.firstSeen)}</td>
                            <td className="text-muted-foreground py-0.5 pr-3 tabular-nums">{fmtStamp(r.seenTo)}</td>
                            <td className="py-0.5 text-right tabular-nums">{r.versions.length}</td>
                          </tr>
                          {rowOpen ? (
                            <tr className="border-border/40 border-t">
                              <td colSpan={4} className="space-y-1.5 py-1">
                                {cumulativeCols.map((col) => {
                                  const pts = rowDerivedDaily(r, col)

                                  return (
                                    <div key={col.key}>
                                      <div className="text-muted-foreground text-[10px] tracking-wide uppercase">
                                        {col.key} · {t.ledgerDerivedDaily}
                                      </div>
                                      {pts.length === 0 ? (
                                        <span className="text-muted-foreground text-[10px]">—</span>
                                      ) : (
                                        <div className="font-mono text-[10px]">
                                          {pts.map((p) => (
                                            <span key={p.date} className="mr-3 inline-block">
                                              {p.date}: {p.value}
                                              {p.estimated ? t.estimatedTag : ''}
                                            </span>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                                <pre className="bg-muted/50 max-h-60 overflow-auto rounded p-2 font-mono text-[10px] leading-relaxed">
                                  {JSON.stringify(r.versions, null, 2)}
                                </pre>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          })}
        </div>
      ) : null}

      {ledger.series.length > 0 ? (
        <div className="space-y-1">
          <h4 className="text-muted-foreground text-[10px] tracking-wide uppercase">{t.ledgerSeriesTitle}</h4>
          {ledger.series.map((s) => (
            <div key={s.section} className="font-mono text-[11px]">
              {s.section} · {s.points.length} {t.ledgerPoints}
              {s.points.length > 0 ? (
                <span className="text-muted-foreground">
                  {' · '}
                  {fmtStamp(s.points[0]!.capturedAt)} → {fmtStamp(s.points[s.points.length - 1]!.capturedAt)}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

const Kv = ({ k, mono, children }: { k: string; mono?: boolean; children: ReactNode }) => (
  <>
    <dt className="text-muted-foreground">{k}</dt>
    <dd className={cn('break-all', mono && 'font-mono')}>{children}</dd>
  </>
)

// Pick a target profile, then confirm, to relocate the service's stored state (stored session + config + cached data)
// to another profile. A plain useState menu of <button>s, NOT a radix Select/menu: radix popups rely on
// pointer-capture + a portal collection that intermittently drops an item click inside this frequently
// re-rendering settings container. Clicking a profile arms an explicit confirm step, since the move
// relocates data out of the active profile.
const MoveToProfile = ({
  targets,
  busy,
  disabled,
  onMove
}: {
  targets: MoveTargetProfile[]
  busy: boolean
  disabled: boolean
  onMove: (targetProfileId: string) => void
}) => {
  const t = useLabels()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<MoveTargetProfile | null>(null)

  return (
    <div className="border-border/60 space-y-1.5 border-t pt-3">
      <p className="text-muted-foreground text-xs">{t.moveToProfileHint}</p>

      {pending ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="destructive"
            disabled={disabled}
            onClick={() => {
              onMove(pending.id)
              setPending(null)
            }}
          >
            {busy ? <Loader2 className="animate-spin" /> : <ArrowRightLeft />}
            {t.moveConfirmTo(pending.name)}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending(null)}>
            {t.cancel}
          </Button>
        </div>
      ) : (
        <div className="relative w-fit">
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <ArrowRightLeft />
            {t.moveToProfile}
          </Button>

          {open ? (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
              <div
                role="menu"
                aria-label={t.moveToProfile}
                className="bg-popover absolute left-0 z-50 mt-1 max-h-72 w-56 overflow-auto rounded-md border p-1 shadow-md"
              >
                {targets.map((p) => (
                  <button
                    key={p.id}
                    role="menuitem"
                    className="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm"
                    onClick={() => {
                      setOpen(false)
                      setPending(p)
                    }}
                  >
                    <span className="flex-1 truncate">{p.name}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  )
}

// Erase stored data — destructive, so it asks for a second click before firing. When the service has
// downloaded documents, the tooltip spells out that those are kept (only cached tab data is dropped).
const EraseButton = ({
  busy,
  disabled,
  documentCount,
  onErase
}: {
  busy: boolean
  disabled: boolean
  documentCount?: number
  onErase: () => void
}) => {
  const t = useLabels()
  const [armed, setArmed] = useState(false)
  const docsKept = documentCount && documentCount > 0 ? t.eraseDataDocsKept(documentCount) : undefined

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive hover:bg-destructive/10"
          disabled={disabled}
          onClick={() => {
            if (armed) {
              onErase()
              setArmed(false)
            } else {
              setArmed(true)
            }
          }}
          onBlur={() => setArmed(false)}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
          {armed ? t.clearDataConfirm : t.eraseData}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        {t.eraseDataHint}
        {docsKept ? <span className="mt-1 block font-medium">{docsKept}</span> : null}
      </TooltipContent>
    </Tooltip>
  )
}

// Uninstall — destructive (wipes session/config/cached data), so the first click arms an explicit confirm
// panel before firing. When the service has files on disk, the panel offers a toggle to also delete the whole
// data folder (the downloaded documents that a plain uninstall would otherwise keep).
const UninstallButton = ({
  disabled,
  fileCount,
  documentCount,
  onUninstall
}: {
  disabled: boolean
  fileCount?: number
  documentCount?: number
  onUninstall: (eraseFolder: boolean) => void
}) => {
  const t = useLabels()
  const [armed, setArmed] = useState(false)
  const [eraseFolder, setEraseFolder] = useState(false)
  // Only worth asking when there's something on disk a plain uninstall would leave behind.
  const hasFiles = (fileCount ?? 0) > 0

  const reset = (): void => {
    setArmed(false)
    setEraseFolder(false)
  }

  if (!armed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
            disabled={disabled}
            onClick={() => setArmed(true)}
          >
            <Trash2 />
            {t.uninstallAction}
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{t.uninstallConfirm}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">{t.uninstallConfirm}</p>

      {hasFiles ? (
        <label className="border-border/60 flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
          <span>
            {documentCount && documentCount > 0 ? t.uninstallEraseFolderDocs(documentCount) : t.uninstallEraseFolder}
          </span>
          <Switch checked={eraseFolder} onCheckedChange={setEraseFolder} />
        </label>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={disabled}
          onClick={() => {
            onUninstall(eraseFolder)
            reset()
          }}
        >
          <Trash2 />
          {t.uninstallArmed}
        </Button>
        <Button size="sm" variant="ghost" onClick={reset}>
          {t.cancel}
        </Button>
      </div>
    </div>
  )
}

const Dot = ({ ok }: { ok: boolean }) => (
  <span className={cn('size-2 shrink-0 rounded-full', ok ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
)

const Section = ({
  title,
  headerRight,
  className,
  children
}: {
  title: string
  headerRight?: ReactNode
  className?: string
  children: ReactNode
}) => (
  <Card className={cn('gap-0 py-0', className)}>
    <CardContent className="space-y-3 px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">{title}</h3>
        {headerRight}
      </div>
      {children}
    </CardContent>
  </Card>
)

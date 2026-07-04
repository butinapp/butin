import { formatDateTime, formatRelative, useFormat, useLabels } from '@butinapp/ui/i18n'
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@butinapp/ui/primitives'
import { AlertTriangle, CheckCircle2, History, Loader2, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'

// The header every service tab shares: a "refreshed <relative> · <absolute>" meta line on the left, an
// icon-only per-tab Refresh button on the right (this tab only — the page's top-right "Refresh All" re-runs
// every tab), and a non-blocking warning banner when a refresh failed but prior data is still shown. An
// incremental tab also offers a "Refetch all history" action that re-pulls everything instead of the recent
// window.
export const ServicePageShell = ({
  lastRunAt,
  running,
  onRefresh,
  onRefetchAll,
  refreshDisabled,
  warn,
  children
}: {
  lastRunAt?: string
  running: boolean
  onRefresh: () => void
  // Present only for an incremental capability: re-pull ALL history (clears the kept union + ledger first), not
  // just the recent window a normal Refresh fetches. Absent → no secondary action.
  onRefetchAll?: () => void
  // Disable Refresh when a fresh fetch can't run (e.g. the plugin isn't connected) — cached data still shows.
  refreshDisabled?: boolean
  warn?: boolean
  children: ReactNode
}) => {
  const t = useLabels()
  const prefs = useFormat()

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-muted-foreground flex items-center gap-1.5 font-mono text-[11px]">
          <CheckCircle2 className="size-3 text-emerald-500" />
          {lastRunAt
            ? t.refreshedAgo(
                formatRelative(new Date(lastRunAt), new Date(), t.intlLocale),
                formatDateTime(lastRunAt, prefs, t.intlLocale)
              )
            : t.notLoadedYet}
        </div>
        <div className="flex items-center gap-1.5">
          {onRefetchAll ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  aria-label={t.refetchAll}
                  disabled={running || refreshDisabled}
                  onClick={onRefetchAll}
                >
                  <History />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t.refetchAll}</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="secondary"
                className="size-8"
                aria-label={t.refresh}
                disabled={running || refreshDisabled}
                onClick={onRefresh}
              >
                {running ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t.refreshThisTab}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {warn ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{t.refreshWarning}</span>
        </div>
      ) : null}

      {children}
    </div>
  )
}

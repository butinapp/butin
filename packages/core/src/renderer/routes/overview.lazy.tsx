import { Overview } from '@butinapp/ui/dashboard'
import { useLabels } from '@butinapp/ui/i18n'
import { Button, Skeleton } from '@butinapp/ui/primitives'
import { useMutation, useQuery } from '@tanstack/react-query'
import { createLazyRoute, useNavigate } from '@tanstack/react-router'
import { Download } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { ExportDialog, type ExportServiceRow } from '@/chrome'

// Matches the Overview layout (title + bands + tile grid) so first paint doesn't jump.
const OverviewSkeleton = () => (
  <div className="space-y-6">
    <div className="space-y-2">
      <Skeleton className="h-7 w-44" />
      <Skeleton className="h-4 w-80 max-w-full" />
    </div>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-[72px]" />
      ))}
    </div>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-24" />
      ))}
    </div>
  </div>
)

const OverviewHome = () => {
  const navigate = useNavigate()
  const { data: dtos = [], isLoading } = useQuery({
    queryKey: ['overview'],
    queryFn: () => window.butin.reports.overview()
  })
  const { data: fx } = useQuery({ queryKey: ['fxConfig'], queryFn: () => window.butin.settings.getFx() })
  const { data: plugins = [] } = useQuery({ queryKey: ['plugins'], queryFn: () => window.butin.services.list() })
  const { data: profiles = [] } = useQuery({ queryKey: ['profiles'], queryFn: () => window.butin.profiles.list() })
  const t = useLabels()

  const [exportOpen, setExportOpen] = useState(false)
  const [destPath, setDestPath] = useState<string | undefined>(undefined)

  // The export modal lists every installed+enabled service, flagging which have cached data (the rest can't
  // contribute to an offline bundle). `hasData` keys off the overview tiles, which exist only once a report does.
  const withData = new Set(dtos.map((d) => d.pluginId))
  const exportServices: ExportServiceRow[] = plugins
    .filter((p) => p.installed && p.enabled)
    .map((p) => ({ id: p.id, name: p.name, color: p.color, icon: p.icon, hasData: withData.has(p.id) }))
  const profileEncrypted = profiles.find((p) => p.active)?.encryption !== 'off'

  const pickDestination = async (): Promise<void> => {
    const path = await window.butin.files.exportPickPath()

    if (path) {
      setDestPath(path)
    }
  }

  const exportData = useMutation({
    mutationFn: (opts: { serviceIds: string[]; encrypt: boolean }) =>
      window.butin.files.exportData({ ...opts, destPath }),
    onSuccess: (r) => {
      if (!r.ok) {
        toast.error(r.error)

        return
      }

      setExportOpen(false)
      setDestPath(undefined)
      toast.success(t.exportDone, {
        description: r.data.path,
        action: { label: t.exportReveal, onClick: () => void window.butin.shell.revealPath(r.data.path) }
      })
    }
  })

  if (isLoading) {
    return <OverviewSkeleton />
  }

  // Map the IPC DTO onto the @butinapp/ui OverviewPlugin shape. summaries drive the section partition (a service
  // shows in every section it reports); balance is the balance-section summary's value; itemCount/lastRunAt/state
  // feed the Others tiles. summaries also lets the spend rollup read an accrued service's open-period figure off
  // its spend summary (its monthly series has no current-month invoice bar to fall back to).
  const overviewPlugins = dtos.map((d) => ({
    pluginId: d.pluginId,
    pluginName: d.name,
    color: d.color,
    icon: d.icon,
    currency: d.currency,
    monthly: d.monthly,
    daily: d.daily,
    currentMonthAccrual: d.currentMonthAccrual,
    summaries: d.summaries,
    balance: d.summaries?.find((s) => s.section === 'balance')?.value,
    itemCount: d.itemCount,
    lastRunAt: d.lastRunAt,
    state: d.state
  }))

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight">{t.libraryTitle}</h1>
          <p className="text-muted-foreground text-sm">{t.librarySubtitle}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setExportOpen(true)}>
          <Download />
          {t.exportButton}
        </Button>
      </div>
      <Overview
        plugins={overviewPlugins}
        baseCurrency={fx?.baseCurrency}
        rates={fx?.rates}
        onOpen={(id) => void navigate({ to: '/service/$serviceId', params: { serviceId: id } })}
      />
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        services={exportServices}
        profileEncrypted={profileEncrypted}
        destPath={destPath}
        running={exportData.isPending}
        onPickDestination={() => void pickDestination()}
        onExport={(opts) => exportData.mutate(opts)}
      />
    </div>
  )
}

export const Route = createLazyRoute('/')({ component: OverviewHome })

import { Button } from '@butinapp/ui/primitives'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'

import type { DiagnosticsDto } from '../../../shared/ipc.js'

import { PaneSkeleton, SettingsCell, SettingsGroup, useReveal } from './parts.js'

const InfoRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between gap-4 px-3.5 py-2 text-sm">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-mono break-all">{value}</span>
  </div>
)

const PathRow = ({ label, value, onReveal }: { label: string; value: string; onReveal: () => void }) => (
  <div className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm">
    <div className="flex min-w-0 flex-col">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-xs" title={value}>
        {value}
      </span>
    </div>
    <Button variant="outline" size="sm" onClick={onReveal}>
      Reveal
    </Button>
  </div>
)

// System: the developer/power-user surface — runtime versions + environment, resolved on-disk paths, and any
// skipped plugins / plugin warnings. Reads one diagnostics snapshot over IPC; no collectors run. Copy is
// English on purpose — this is a technical panel.
export const SystemPane = () => {
  const navigate = useNavigate()
  const reveal = useReveal()
  const { data } = useQuery<DiagnosticsDto>({
    queryKey: ['diagnostics'],
    queryFn: () => window.butin.app.diagnostics()
  })

  if (!data) {
    return <PaneSkeleton />
  }

  const warned = data.loaded.filter((p) => p.warnings.length > 0)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          {data.loaded.length} plugin{data.loaded.length === 1 ? '' : 's'} loaded
          {data.failed.length > 0 ? `, ${data.failed.length} skipped` : ''}
          {warned.length > 0 ? `, ${warned.length} with warnings` : ''}.
        </p>
        <Button variant="outline" size="sm" onClick={() => void navigate({ to: '/developer' })}>
          Open logs
        </Button>
      </div>

      <SettingsGroup title="Runtime">
        <InfoRow label="Butin" value={data.appVersion} />
        <InfoRow label="Electron" value={data.electronVersion} />
        <InfoRow label="Chrome" value={data.chromeVersion} />
        <InfoRow label="Node" value={data.nodeVersion} />
        <InfoRow label="Platform" value={data.platform} />
        <InfoRow label="Active profile" value={data.activeProfile} />
        <InfoRow label="Log capture level" value={data.captureLevel} />
      </SettingsGroup>

      <SettingsGroup title="Storage">
        <PathRow label="Data folder" value={data.dataDir} onReveal={() => reveal('data')} />
        <PathRow label="Log folder" value={data.logDir} onReveal={() => reveal('logs')} />
      </SettingsGroup>

      {data.failed.length > 0 && (
        <SettingsGroup title={`Skipped plugins (${data.failed.length})`}>
          <SettingsCell>
            {data.failed.map((f) => (
              <div key={f.path} className="text-sm">
                <span className="font-mono font-medium">{f.path}</span>
                <span className="text-muted-foreground"> — {f.reason}</span>
              </div>
            ))}
          </SettingsCell>
        </SettingsGroup>
      )}

      {warned.length > 0 && (
        <SettingsGroup title={`Plugin warnings (${warned.length})`}>
          <SettingsCell>
            {warned.map((p) => (
              <div key={p.id} className="space-y-1">
                <span className="text-sm font-medium">{p.name}</span>
                {p.warnings.map((w) => (
                  <p key={w} className="text-xs text-amber-600 dark:text-amber-400">
                    ⚠ {w}
                  </p>
                ))}
              </div>
            ))}
          </SettingsCell>
        </SettingsGroup>
      )}
    </div>
  )
}

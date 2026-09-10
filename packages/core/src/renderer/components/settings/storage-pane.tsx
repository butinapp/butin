import { Button } from '@butinapp/ui/primitives'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import type { StorageLocationDto, StorageLocationKind, StorageSurface } from '../../../shared/ipc.js'
import { failed } from '../../result-toast.js'

import { PaneSkeleton, SettingsCell, SettingsGroup } from './parts.js'

// Storage is a technical/power-user panel — its copy stays inline English (the same choice System + Logs make),
// rather than going through the translated label contract.

// Human label per location kind.
const LOCATION_LABEL: Record<StorageLocationKind, string> = {
  data: 'Butin data',
  session: 'Browser session',
  logs: 'Logs',
  install: 'App install'
}

// Convert a byte count to a compact human size (B / KB / MB / GB / TB).
const formatBytes = (n: number): string => {
  if (n < 1024) {
    return `${n} B`
  }

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

// One location: its label + a clickable path that opens the folder, with its size walked on demand (the tab
// fires every row's size query on open, so the cells fill in as each walk finishes).
const LocationRow = ({ location }: { location: StorageLocationDto }) => {
  const sizeQ = useQuery({
    queryKey: ['storageSize', location.kind],
    queryFn: () => window.butin.app.folderSize(location.kind)
  })

  return (
    <div className="flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm">
      <button
        onClick={() => void window.butin.app.revealStorage(location.kind)}
        className="flex min-w-0 flex-col text-left"
        title={`Open ${location.path}`}
      >
        <span className="text-muted-foreground">{LOCATION_LABEL[location.kind]}</span>
        <span className="text-foreground/90 hover:text-foreground truncate font-mono text-xs underline-offset-2 hover:underline">
          {location.path}
        </span>
      </button>
      <span className="text-muted-foreground shrink-0 tabular-nums">
        {sizeQ.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : sizeQ.isError ? (
          '—'
        ) : (
          formatBytes(sizeQ.data ?? 0)
        )}
      </span>
    </div>
  )
}

// One clear action: a described surface with a two-click destructive button (auto-reverting after a few
// seconds), so a wipe is never one accidental tap.
const ClearRow = ({
  title,
  description,
  surface,
  buttonLabel
}: {
  title: string
  description: string
  surface: StorageSurface
  buttonLabel: string
}) => {
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)

  const onClear = async (): Promise<void> => {
    if (!confirm) {
      setConfirm(true)
      setTimeout(() => setConfirm(false), 3000)

      return
    }

    setConfirm(false)

    const res = await window.butin.app.clearStorage(surface)

    if (failed(res)) {
      return
    }

    // Repaint whatever the wipe touched: sizes (every row), the connection/overview state, the logs view.
    void qc.invalidateQueries({ queryKey: ['storageSize'] })
    void qc.invalidateQueries({ queryKey: ['plugins'] })
    void qc.invalidateQueries({ queryKey: ['overview'] })
    void qc.invalidateQueries({ queryKey: ['logs'] })
    toast.success('Done.')
  }

  return (
    <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={() => void onClear()}>
        {confirm ? 'Confirm' : buttonLabel}
      </Button>
    </div>
  )
}

// Storage: the one screen that shows where everything Butin keeps lives — the Butin-owned folders, the system
// folders Electron manages, and the install location — each with its size, and the controls to clear any
// surface (up to erasing everything and restarting).
export const StoragePane = () => {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data: locations } = useQuery({
    queryKey: ['storageLocations'],
    queryFn: () => window.butin.app.storageLocations()
  })

  const [confirmErase, setConfirmErase] = useState(false)

  const onErase = async (): Promise<void> => {
    if (!confirmErase) {
      setConfirmErase(true)
      setTimeout(() => setConfirmErase(false), 4000)

      return
    }

    setConfirmErase(false)
    // The app wipes ~/butin and restarts, so this call may never resolve; surface only an outright failure.
    const res = await window.butin.app.clearStorage('everything')

    failed(res)
  }

  if (!locations) {
    return <PaneSkeleton />
  }

  const butinOwned = locations.filter((l) => !l.system)
  const system = locations.filter((l) => l.system)

  return (
    <div className="space-y-5">
      <SettingsGroup title="Butin folders">
        {butinOwned.map((l) => (
          <LocationRow key={l.kind} location={l} />
        ))}
      </SettingsGroup>

      <SettingsGroup title="System folders">
        {system.map((l) => (
          <LocationRow key={l.kind} location={l} />
        ))}
      </SettingsGroup>

      <SettingsGroup title="Manage data">
        <ClearRow
          title="Browser session"
          description="Sign out of the in-app browser for this profile — cookies, cache and local storage. Services may ask you to verify again. Saved logins are kept."
          surface="browserSessions"
          buttonLabel="Clear"
        />
        <ClearRow
          title="Saved logins"
          description="Delete the encrypted session keys Butin stores to fetch headless. You'll reconnect each service the next time you open it."
          surface="savedLogins"
          buttonLabel="Clear"
        />
        <ClearRow
          title="Cached data"
          description="Remove every service's fetched reports, history and downloaded files in this profile. Connections stay; refresh to rebuild."
          surface="cachedData"
          buttonLabel="Clear"
        />
      </SettingsGroup>

      <SettingsGroup title="Logs">
        <SettingsCell>
          <p className="text-muted-foreground text-sm">
            View the live log, or delete every log file on disk plus the in-memory buffer.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void navigate({ to: '/developer' })}>
              Open logs
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void window.butin.app.clearStorage('logs').then((res) => {
                  if (failed(res)) {
                    return
                  }

                  void qc.invalidateQueries({ queryKey: ['storageSize'] })
                  void qc.invalidateQueries({ queryKey: ['logs'] })
                  toast.success('Logs cleared.')
                })
              }
            >
              Clear logs
            </Button>
          </div>
        </SettingsCell>
      </SettingsGroup>

      <SettingsGroup title="Erase everything">
        <SettingsCell>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Delete the entire Butin data folder — all profiles, saved logins, cached data and logs — and sign out the
            browser session, then restart Butin as if freshly installed. This cannot be undone.
          </p>
          <Button variant="destructive" size="sm" onClick={() => void onErase()}>
            {confirmErase ? 'Confirm — erase & restart' : 'Erase everything'}
          </Button>
        </SettingsCell>
      </SettingsGroup>
    </div>
  )
}

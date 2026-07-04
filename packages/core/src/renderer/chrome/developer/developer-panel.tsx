import { Button, cn } from '@butinapp/ui/primitives'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import type { LogEntryDto } from '../../../shared/ipc.js'
import { LogViewer, type LogViewerEntry } from '../logs/log-viewer.js'

import { CookieJar } from './cookie-jar.js'

type Tab = 'logs' | 'cookies' | 'tools'

const LogsTab = () => {
  const qc = useQueryClient()
  const { data: logs = [] } = useQuery<LogEntryDto[]>({
    queryKey: ['logs'],
    queryFn: () => window.butin.app.getLogs(),
    refetchInterval: 2000
  })

  return (
    <LogViewer
      entries={logs as LogViewerEntry[]}
      onClear={() => void window.butin.app.clearLogs().then(() => qc.invalidateQueries({ queryKey: ['logs'] }))}
      onReveal={() => void window.butin.files.revealFolder('logs')}
      onExport={(text) =>
        void window.butin.files.saveFile(`butin-logs-${new Date().toISOString().slice(0, 10)}.log`, text)
      }
    />
  )
}

const ToolsTab = () => (
  <div className="space-y-2">
    <Button variant="secondary" onClick={() => void window.butin.services.openNavigationBrowser()}>
      Open browser
    </Button>
    <p className="text-muted-foreground text-xs">
      A plugin-less browser on the shared session — navigate any signed-in service without re-capturing.
    </p>
  </div>
)

const TABS: { id: Tab; label: string }[] = [
  { id: 'logs', label: 'Logs' },
  { id: 'cookies', label: 'Cookie Jar' },
  { id: 'tools', label: 'Tools' }
]

export const DeveloperPanel = () => {
  const [tab, setTab] = useState<Tab>('logs')

  // Fill the routed body's height (viewport minus the top bar + the body's own padding) so the tab content —
  // the Logs viewer in particular — scrolls inside its own pane instead of spilling a second scrollbar onto
  // the page. The tab bar stays pinned; the active tab takes the rest.
  return (
    <div className="flex h-[calc(100vh-6rem)] flex-col gap-4">
      <div className="flex shrink-0 gap-1 border-b">
        {TABS.map((tdef) => (
          <button
            key={tdef.id}
            onClick={() => setTab(tdef.id)}
            className={cn(
              'border-b-2 px-3 py-1.5 text-sm',
              tab === tdef.id
                ? 'border-foreground text-foreground'
                : 'text-muted-foreground hover:text-foreground border-transparent'
            )}
          >
            {tdef.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'logs' && <LogsTab />}
        {tab === 'cookies' && <CookieJar />}
        {tab === 'tools' && <ToolsTab />}
      </div>
    </div>
  )
}

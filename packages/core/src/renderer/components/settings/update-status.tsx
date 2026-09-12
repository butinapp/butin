import { useLabels } from '@butinapp/ui/i18n'
import { Button } from '@butinapp/ui/primitives'

import type { UpdateStateDto } from '../../../shared/ipc.js'

type Props = { state: UpdateStateDto; onCheck: () => void; onInstall: () => void }

// Where the app stands with its next release, drawn under the version in About: one status line and the one
// action that applies — a check, or the restart once the update is downloaded. Prop-driven; the About pane
// binds it to the update state and the IPC calls.
export const UpdateStatus = ({ state, onCheck, onInstall }: Props) => {
  const t = useLabels()

  if (state.kind === 'unavailable') {
    return <p className="text-muted-foreground text-xs">{t.updateUnavailable}</p>
  }

  const status = (): string | null => {
    switch (state.kind) {
      case 'checking':
        return t.updateChecking
      case 'downloading':
        return t.updateDownloading(state.version, state.percent)
      case 'ready':
        return t.updateReady(state.version)
      case 'upToDate':
        return t.updateUpToDate(new Date(state.checkedAt).toLocaleTimeString(t.intlLocale))
      case 'error':
        return t.updateError(state.message)
      case 'idle':
        return null
    }
  }

  const line = status()

  return (
    <div className="flex flex-col items-center gap-2">
      {line ? <p className="text-muted-foreground text-xs">{line}</p> : null}
      {state.kind === 'ready' ? (
        <Button size="sm" onClick={onInstall}>
          {t.updateRestart}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={onCheck}
          disabled={state.kind === 'checking' || state.kind === 'downloading'}
        >
          {t.updateCheck}
        </Button>
      )}
    </div>
  )
}

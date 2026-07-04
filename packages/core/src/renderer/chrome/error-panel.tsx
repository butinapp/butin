import type { TroubleshootingAction, TroubleshootingCause } from '@butinapp/sdk'
import { useLabels } from '@butinapp/ui/i18n'
import { Button, cn } from '@butinapp/ui/primitives'
import { AlertTriangle } from 'lucide-react'

// One consistent failure surface, reused in onboarding steps and the normal refresh path: a plain-language
// message (the host resolves plugin hint > generic per-cause copy), the controlled action buttons, and a
// Details disclosure with the raw error. Pure + prop-driven, no IPC.
export const ErrorPanel = ({
  cause,
  message,
  actions,
  details,
  onAction,
  className
}: {
  cause: TroubleshootingCause
  message: string
  actions: TroubleshootingAction[]
  details?: string
  onAction: (action: TroubleshootingAction) => void
  className?: string
}) => {
  const t = useLabels()
  const actionLabel: Record<TroubleshootingAction, string> = {
    retry: t.actionRetry,
    reconnect: t.actionReconnect,
    'edit-settings': t.actionEditSettings,
    'open-dashboard': t.actionOpenDashboard,
    'open-docs': t.actionOpenDocs
  }

  return (
    <div
      data-cause={cause}
      className={cn('border-destructive/40 bg-destructive/10 space-y-3 rounded-md border p-3 text-xs', className)}
    >
      <div className="text-destructive flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span className="flex-1">{message}</span>
      </div>
      {actions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {actions.map((a) => (
            <Button key={a} size="xs" variant="outline" onClick={() => onAction(a)}>
              {actionLabel[a]}
            </Button>
          ))}
        </div>
      ) : null}
      {details ? (
        <details>
          <summary className="text-muted-foreground cursor-pointer select-none">{t.errorDetails}</summary>
          <pre className="text-muted-foreground mt-1 max-h-40 overflow-auto font-mono break-all whitespace-pre-wrap">
            {details}
          </pre>
        </details>
      ) : null}
    </div>
  )
}

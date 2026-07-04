import { cn } from '@butinapp/ui/primitives'
import { Check, Circle, Loader2, X } from 'lucide-react'

export type RefreshStepStatus = 'pending' | 'running' | 'done' | 'error'

export type RefreshProgressItem = { id: string; label: string; status: RefreshStepStatus; error?: string }

const Mark = ({ status }: { status: RefreshStepStatus }) => {
  if (status === 'done') {
    return <Check className="size-3.5 shrink-0 text-emerald-500" />
  }

  if (status === 'running') {
    return <Loader2 className="text-primary size-3.5 shrink-0 animate-spin" />
  }

  if (status === 'error') {
    return <X className="text-destructive size-3.5 shrink-0" />
  }

  return <Circle className="text-muted-foreground/40 size-3.5 shrink-0" />
}

// Live per-capability progress for a Refresh-All run: one row per capability with a status mark + label, plus
// any inline error so a failure shows exactly which part broke. Pure + prop-driven — the host owns the loop.
// `onDismiss`, when provided, renders a close button so a finished run that lingered (because something failed)
// can be cleared away — without it an errored run would stay on screen forever.
export const RefreshProgress = ({ items, onDismiss }: { items: RefreshProgressItem[]; onDismiss?: () => void }) => {
  if (items.length === 0) {
    return null
  }

  const done = items.filter((i) => i.status === 'done').length

  return (
    <div className="space-y-1.5 rounded-md border p-3 text-xs">
      <div className="text-muted-foreground flex items-center justify-end gap-2 font-mono text-[10px]">
        <span>
          {done}/{items.length}
        </span>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="hover:text-foreground -my-1 rounded p-0.5"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
      <ul className="space-y-1">
        {items.map((i) => (
          <li key={i.id} className="flex items-center gap-2">
            <Mark status={i.status} />
            <span className={cn(i.status === 'pending' && 'text-muted-foreground/60')}>{i.label}</span>
            {i.error ? <span className="text-destructive ml-auto truncate pl-2">{i.error}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

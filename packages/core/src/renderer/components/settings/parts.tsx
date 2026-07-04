import { useLabels } from '@butinapp/ui/i18n'
import { Select } from '@butinapp/ui/primitives'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { toast } from 'sonner'

import type { AppSettingsDto, RevealTarget } from '../../../shared/ipc.js'

// Settings + a one-field patcher, shared by every pane that edits an app setting. Each pane reads the same
// cached query, so a change in one repaints the rest. A rejected write toasts and re-reads the stored truth, so
// a control never silently keeps a value that was never persisted.
export const useAppSettings = () => {
  const t = useLabels()
  const qc = useQueryClient()
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => window.butin.settings.get() })

  const patch = (values: Partial<AppSettingsDto>): void => {
    void window.butin.settings
      .patch(values)
      .catch(() => toast.error(t.settingsSaveFailed))
      .finally(() => void qc.invalidateQueries({ queryKey: ['settings'] }))
  }

  return { settings, patch }
}

// Open an on-disk folder in the OS file manager, toasting if the shell hands back an error.
export const useReveal = () => {
  const t = useLabels()

  return (target: RevealTarget, pluginId?: string): void =>
    void window.butin.files.revealFolder(target, pluginId).catch(() => toast.error(t.openFolderFailed))
}

// A section's pending placeholder: a few muted rows so switching to a section whose query is still loading shows
// the panel's shape, never a blank void. The pulse only runs when motion is allowed.
export const PaneSkeleton = () => {
  const t = useLabels()

  return (
    <div className="animate-pulse space-y-3" role="status" aria-label={t.settingsLoading}>
      <div className="bg-muted h-9 rounded-lg" />
      <div className="bg-muted h-9 rounded-lg" />
      <div className="bg-muted/70 h-24 rounded-lg" />
      <span className="sr-only">{t.settingsLoading}</span>
    </div>
  )
}

// A grouped settings list: an optional small heading over a bordered list whose rows are divided. Compact by
// design — each setting is one row, with no card chrome, big padding, or per-field gaps to waste space.
export const SettingsGroup = ({ title, children }: { title?: string; children: ReactNode }) => (
  <div className="space-y-1.5">
    {title ? (
      <h3 className="text-muted-foreground px-1 text-[11px] font-medium tracking-wide uppercase">{title}</h3>
    ) : null}
    <div className="divide-border/60 bg-card divide-y overflow-hidden rounded-lg border">{children}</div>
  </div>
)

// One setting row: title (+ optional hint) on the left, the control on the right.
export const Row = ({ title, hint, control }: { title: string; hint?: string; control: ReactNode }) => (
  <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
    <div className="min-w-0">
      <div className="text-sm font-medium">{title}</div>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
    <div className="shrink-0">{control}</div>
  </div>
)

// A free-form cell for content that isn't a simple labelled row (an editable rate table, a cluster of buttons).
export const SettingsCell = ({ children }: { children: ReactNode }) => (
  <div className="space-y-2 px-3.5 py-3">{children}</div>
)

// A labelled Select rendered as a row — the control sits on the right at a fixed width.
export const SelectField = ({
  label,
  hint,
  value,
  onValueChange,
  options
}: {
  label: string
  hint?: string
  value: string
  onValueChange: (value: string) => void
  options: { value: string; label: string }[]
}) => (
  <Row
    title={label}
    hint={hint}
    control={
      <div className="w-52">
        <Select value={value} onValueChange={onValueChange} options={options} />
      </div>
    }
  />
)

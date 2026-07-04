import { useLabels } from '@butinapp/ui/i18n'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ServiceIcon
} from '@butinapp/ui/primitives'
import { FolderOpen, Loader2, Lock } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

// One selectable service in the export. `hasData` false → the row is disabled ("no data yet"): an offline
// export can only serialize what's already cached, so a never-fetched service has nothing to contribute.
export type ExportServiceRow = { id: string; name: string; color?: string; icon?: string; hasData: boolean }

// The Export modal: pick which cached services to include, choose plaintext (default) or vault-sealed output
// (only offered on an encrypted profile), and a destination. Prop-driven + theme-portable — no IPC; the host
// owns the mutation, the destination picker, and the completion toast/reveal, feeding state back through props.
export const ExportDialog = ({
  open,
  onOpenChange,
  services,
  profileEncrypted,
  destPath,
  running,
  onPickDestination,
  onExport
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  services: ExportServiceRow[]
  profileEncrypted: boolean
  destPath?: string
  running: boolean
  onPickDestination: () => void
  onExport: (opts: { serviceIds: string[]; encrypt: boolean }) => void
}) => {
  const t = useLabels()
  const selectable = useMemo(() => services.filter((s) => s.hasData), [services])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [encrypt, setEncrypt] = useState(false)

  // Seed a fresh, all-selected state each time the modal opens (the service list is loaded by then), so a
  // reopen never inherits a stale selection or the previous run's encrypt choice.
  useEffect(() => {
    if (open) {
      setSelected(new Set(selectable.map((s) => s.id)))
      setEncrypt(false)
    }
  }, [open, selectable])

  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)

      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }

      return next
    })

  const allSelected = selectable.length > 0 && selected.size === selectable.length
  const toggleAll = (): void => setSelected(allSelected ? new Set() : new Set(selectable.map((s) => s.id)))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.exportTitle}</DialogTitle>
          <DialogDescription>{t.exportDescription}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
            <Checkbox
              checked={allSelected ? true : selected.size > 0 ? 'indeterminate' : false}
              disabled={selectable.length === 0}
              onCheckedChange={toggleAll}
            />
            {t.exportServices}
          </label>
          <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border p-1">
            {services.map((s) => (
              <label
                key={s.id}
                className="hover:bg-muted flex items-center gap-2 rounded px-2 py-1.5 text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                aria-disabled={!s.hasData}
              >
                <Checkbox checked={selected.has(s.id)} disabled={!s.hasData} onCheckedChange={() => toggle(s.id)} />
                <ServiceIcon id={s.id} name={s.name} color={s.color} icon={s.icon} size={18} />
                <span className="flex-1 truncate">{s.name}</span>
                {!s.hasData && <span className="text-muted-foreground text-xs">{t.exportNoData}</span>}
              </label>
            ))}
          </div>
        </div>

        {profileEncrypted ? (
          <div className="space-y-1">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={encrypt} onCheckedChange={(v) => setEncrypt(v === true)} />
              <Lock className="size-3.5" />
              {t.exportEncrypt}
            </label>
            <p className="text-muted-foreground pl-6 text-xs">
              {encrypt ? t.exportEncryptHint : t.exportPlaintextWarning}
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">{t.exportPlaintextNote}</p>
        )}

        <div className="space-y-1">
          <p className="text-sm font-medium">{t.exportDestination}</p>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground flex-1 truncate text-sm" title={destPath}>
              {destPath ?? t.exportDestinationDefault}
            </span>
            <Button size="sm" variant="outline" onClick={onPickDestination}>
              <FolderOpen />
              {t.exportChange}
            </Button>
          </div>
        </div>

        <div className="flex justify-end">
          <Button
            disabled={running || selected.size === 0}
            onClick={() => onExport({ serviceIds: [...selected], encrypt: profileEncrypted && encrypt })}
          >
            {running ? <Loader2 className="animate-spin" /> : null}
            {running ? t.exportRunning : t.exportButton}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

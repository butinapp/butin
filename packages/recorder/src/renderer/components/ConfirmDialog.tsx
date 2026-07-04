import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@butinapp/ui/primitives'
import { useState, type ReactNode } from 'react'

interface Props {
  /** The element that opens the dialog (asChild — pass a Button or similar). */
  trigger: ReactNode
  title: string
  description: ReactNode
  confirmLabel?: string
  busyLabel?: string
  /** Runs on confirm; the dialog closes on success and surfaces a thrown error inline. */
  onConfirm: () => Promise<void> | void
}

// A small destructive-confirm built on the Dialog primitive (@butinapp/ui ships no AlertDialog). Used for the
// irreversible recording/domain deletes — hard deletes, so the confirm spells out exactly what's removed.
export const ConfirmDialog = ({
  trigger,
  title,
  description,
  confirmLabel = 'Delete',
  busyLabel = 'Deleting…',
  onConfirm
}: Props) => {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const run = async () => {
    setBusy(true)
    setError(undefined)

    try {
      await onConfirm()
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void run()}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

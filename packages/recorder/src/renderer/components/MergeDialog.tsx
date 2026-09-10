import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label
} from '@butinapp/ui/primitives'
import { useState } from 'react'

type Props = {
  surface: string
  onMerged?: () => void
}

export const MergeDialog = ({ surface, onMerged }: Props) => {
  const [open, setOpen] = useState(false)
  const [host, setHost] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const submit = async () => {
    const trimmedHost = host.trim()

    if (!trimmedHost) {
      setError('Host is required.')

      return
    }

    setBusy(true)
    setError(undefined)

    try {
      await window.recorder.mergeSurfaces({ host: trimmedHost, into: surface })
      setOpen(false)
      setHost('')
      onMerged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Merge failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Merge…
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge host into surface</DialogTitle>
          <DialogDescription>
            Fold a secondary host into <strong>{surface}</strong>. Requests from that host will be attributed to this
            surface in future analysis.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4 pt-2"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="merge-host">Host to merge</Label>
            <Input
              id="merge-host"
              autoFocus
              placeholder="e.g. api.example.com"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              disabled={busy}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Merges into: <span className="font-mono">{surface}</span>
          </p>
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
            <Button type="submit" disabled={busy}>
              {busy ? 'Merging…' : 'Merge'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

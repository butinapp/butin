import {
  Button,
  Checkbox,
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

interface Props {
  /** The selected profile's partition — the recording captures into this profile's session. */
  partition: string
  /** The Butin app holds this profile open; recording it would capture a locked, empty session. */
  blocked: boolean
  onStarted?: (runId: string) => void
}

// Prepend https:// when the user types a bare host (the common case) — anything that already carries a
// scheme is left untouched so an explicit http:// still works.
const ensureScheme = (value: string): string => (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`)

// Accept only an http(s) URL — the start URL is loaded into a real browser view, so a non-web scheme
// would dead-end the capture window.
const isValidUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value)

    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export const NewRecordingDialog = ({ partition, blocked, onStarted }: Props) => {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [startUrl, setStartUrl] = useState('')
  const [autoRecord, setAutoRecord] = useState(true)
  const [isolated, setIsolated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const submit = async () => {
    const trimmedLabel = label.trim()
    const rawUrl = startUrl.trim()

    if (!rawUrl) {
      setError('A start URL is required.')

      return
    }

    const normalizedUrl = ensureScheme(rawUrl)

    if (!isValidUrl(normalizedUrl)) {
      setError('Enter a valid web address, e.g. app.example.com.')

      return
    }

    setBusy(true)
    setError(undefined)

    try {
      // Records into the selected profile's partition — the label is optional (main derives one from the host).
      const { runId } = await window.recorder.startRecording({
        label: trimmedLabel,
        startUrl: normalizedUrl,
        partition,
        autoRecord,
        isolated
      })

      setOpen(false)
      setLabel('')
      setStartUrl('')
      setAutoRecord(true)
      setIsolated(false)
      onStarted?.(runId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start recording.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="default"
          disabled={blocked}
          title={blocked ? 'Quit Butin to record this profile' : undefined}
        >
          New recording
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New recording</DialogTitle>
          <DialogDescription>Open a capture window and record requests from the start URL.</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-4 pt-2"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rec-url">Start URL</Label>
            <Input
              id="rec-url"
              autoFocus
              type="url"
              inputMode="url"
              placeholder="app.example.com"
              value={startUrl}
              onChange={(e) => setStartUrl(e.target.value)}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">https:// is added automatically.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rec-label">
              Label <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="rec-label"
              placeholder="e.g. login-flow"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">Defaults to the domain if left blank.</p>
          </div>
          <div className="flex items-start gap-2.5">
            <Checkbox
              id="rec-autostart"
              checked={autoRecord}
              onCheckedChange={(v) => setAutoRecord(v === true)}
              disabled={busy}
              className="mt-0.5"
            />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="rec-autostart" className="font-normal">
                Start recording immediately
              </Label>
              <p className="text-xs text-muted-foreground">
                Uncheck to open the window paused — useful to clear a browser-verification check before capture begins.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <Checkbox
              id="rec-isolated"
              checked={isolated}
              onCheckedChange={(v) => setIsolated(v === true)}
              disabled={busy}
              className="mt-0.5"
            />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="rec-isolated" className="font-normal">
                Isolated session
              </Label>
              <p className="text-xs text-muted-foreground">
                Records in a fresh in-memory session with no saved cookies — you&apos;ll sign in from scratch, but a
                stale cookie can&apos;t affect a login or browser-verification check.
              </p>
            </div>
          </div>
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
              {busy ? 'Starting…' : 'Start'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

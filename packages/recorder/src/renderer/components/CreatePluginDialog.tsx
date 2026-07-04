import {
  Badge,
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
import { useEffect, useState } from 'react'

import type { KickstartOutcome, PluginSuggestion } from '../../main/ipc.js'

interface Props {
  surface: string
  partition: string
}

const isValidId = (value: string): boolean => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)

export const CreatePluginDialog = ({ surface, partition }: Props) => {
  const [open, setOpen] = useState(false)
  const [suggestion, setSuggestion] = useState<PluginSuggestion | undefined>(undefined)
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [vendor, setVendor] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [outcome, setOutcome] = useState<KickstartOutcome | undefined>(undefined)

  // Pull the suggestion (id/name/vendor + capability preview) when the dialog opens; reset on close.
  useEffect(() => {
    if (!open) {
      setSuggestion(undefined)
      setOutcome(undefined)
      setError(undefined)

      return
    }

    void window.recorder
      .suggestPlugin({ surface, partition })
      .then((s) => {
        setSuggestion(s)
        setId(s.id)
        setName(s.name)
        setVendor(s.vendor)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to inspect the recording'))
  }, [open, surface, partition])

  // The suggested id collides only when the suggestion still matches the (unedited) id field.
  const collision = suggestion?.collision === true && id === suggestion.id

  const submit = async () => {
    if (!isValidId(id)) {
      setError('Use a kebab-case id: lowercase letters, digits, single hyphens.')

      return
    }

    setBusy(true)
    setError(undefined)

    try {
      const result = await window.recorder.kickstartPlugin({
        surface,
        partition,
        id,
        name: name.trim(),
        vendor: vendor.trim()
      })

      setOutcome(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create the plugin.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="default">
          Create plugin
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create plugin</DialogTitle>
          <DialogDescription>
            Scaffold a pre-filled plugin from this recording and copy a kickoff prompt for Claude.
          </DialogDescription>
        </DialogHeader>

        {outcome ? (
          <div className="flex flex-col gap-3 pt-2">
            <p className="text-sm">
              ✓ Scaffolded <span className="font-mono">plugins/{id}/</span> and copied the kickoff prompt. Paste it into
              Claude in the butin repo to implement the capabilities.
            </p>
            <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/40 p-3 text-xs">
              <span className="font-mono break-all">{outcome.pluginPath}</span>
              <span className="font-mono break-all text-muted-foreground">{outcome.briefPath}</span>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => navigator.clipboard.writeText(outcome.prompt)}>
                Copy prompt again
              </Button>
              <Button type="button" onClick={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form
            noValidate
            className="flex flex-col gap-4 pt-2"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plugin-id">Plugin id</Label>
              <Input
                id="plugin-id"
                autoFocus
                placeholder="e.g. stripe"
                value={id}
                onChange={(e) => setId(e.target.value)}
                disabled={busy || !suggestion}
              />
              {collision ? (
                <p className="text-xs text-destructive">plugins/{id}/ already exists — pick a different id.</p>
              ) : (
                <p className="text-xs text-muted-foreground">Folder name + meta.id. Kebab-case; names a surface.</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plugin-name">Name</Label>
                <Input
                  id="plugin-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy || !suggestion}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="plugin-vendor">Vendor</Label>
                <Input
                  id="plugin-vendor"
                  value={vendor}
                  onChange={(e) => setVendor(e.target.value)}
                  disabled={busy || !suggestion}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Capability stubs</Label>
              {suggestion ? (
                <div className="flex flex-wrap gap-1.5">
                  {suggestion.capabilities.map((c) => (
                    <Badge key={c.capId} variant="secondary" className="font-mono">
                      {c.capId}
                      {c.evidenceCount > 0 && <span className="ml-1 text-muted-foreground">·{c.evidenceCount}</span>}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Inspecting the recording…</p>
              )}
              <p className="text-xs text-muted-foreground">
                Stubbed from detected endpoint hints (·N = matched request files). Claude fills the collect() logic.
              </p>
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
              <Button type="submit" disabled={busy || !suggestion || collision || !isValidId(id)}>
                {busy ? 'Creating…' : 'Create plugin'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

import { useLabels } from '@butinapp/ui/i18n'
import { Button, cn, Input } from '@butinapp/ui/primitives'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, ExternalLink, FolderOpen } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { PaneSkeleton, Row, SettingsGroup } from './parts.js'

const DEFAULT_SIGNIN_URL = 'https://accounts.google.com'

// Browser sign-in: opens a real Chrome for a hand login (the personal-Google case the built-in browser blocks)
// then gathers the session into the active partition. App chrome — owns the IPC query/mutations + toasts. The
// pane leads with the ordered process, then exposes the saved Chrome profile (location + a Remove that spells
// out what it deletes).
export const BrowserSigninPane = () => {
  const t = useLabels()
  const qc = useQueryClient()
  const [url, setUrl] = useState(DEFAULT_SIGNIN_URL)
  const [error, setError] = useState<string>()

  const { data: status } = useQuery({
    queryKey: ['chromeSigninStatus'],
    queryFn: () => window.butin.chromeSignin.status()
  })
  const invalidate = (): void => void qc.invalidateQueries({ queryKey: ['chromeSigninStatus'] })

  const signIn = useMutation({
    mutationFn: (target: string) => window.butin.chromeSignin.start(target),
    onSuccess: (res) => {
      if (res.ok) {
        setError(undefined)
        toast.success(t.browserSigninSynced(res.syncedCount ?? 0))
      } else {
        setError(res.error ?? t.browserSigninError)
      }
    },
    onSettled: invalidate
  })

  const remove = useMutation({ mutationFn: () => window.butin.chromeSignin.remove(), onSettled: invalidate })
  const busy = signIn.isPending || remove.isPending

  // The status check is a cheap on-disk lookup; show the pane's shape until it lands rather than a blank flash.
  if (!status) {
    return <PaneSkeleton />
  }

  const hasSession = status.hasSession
  const steps = [t.browserSigninStep1, t.browserSigninStep2, t.browserSigninStep3]

  const startSignIn = (): void => {
    setError(undefined)
    signIn.mutate(url.trim() || DEFAULT_SIGNIN_URL)
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h3 className="text-sm font-medium">{t.browserSigninTitle}</h3>
        <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">{t.browserSigninLead}</p>
      </header>

      {/* A real ordered process, so the numbers carry meaning rather than scaffold a section. */}
      <section className="space-y-2.5">
        <h4 className="text-foreground text-xs font-semibold">{t.browserSigninStepsTitle}</h4>
        <ol className="space-y-2.5">
          {steps.map((step, i) => (
            <li key={step} className="flex items-start gap-3">
              <span
                aria-hidden
                className="bg-secondary text-secondary-foreground mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums"
              >
                {i + 1}
              </span>
              <span className="text-sm leading-relaxed">{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button onClick={startSignIn} disabled={busy}>
            <ExternalLink className="size-4" aria-hidden />
            {hasSession ? t.browserSigninReopen : t.browserSigninButton}
          </Button>
          <span className={cn('text-sm', hasSession ? 'text-foreground' : 'text-muted-foreground')}>
            {hasSession ? t.browserSigninConnected : t.browserSigninNone}
          </span>
        </div>

        {busy ? (
          <p role="status" className="text-foreground text-sm">
            {t.browserSigninBusy}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        {/* The sign-in URL is an override most people never touch, so it stays folded away by default. */}
        <details className="group">
          <summary className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer list-none items-center gap-1 text-xs [&::-webkit-details-marker]:hidden">
            <ChevronRight
              className="size-3 transition-transform group-open:rotate-90 motion-reduce:transition-none"
              aria-hidden
            />
            {t.browserSigninAdvanced}
          </summary>
          <div className="mt-2 max-w-sm space-y-1.5">
            <label htmlFor="chrome-signin-url" className="text-muted-foreground text-xs">
              {t.browserSigninUrlLabel}
            </label>
            <Input
              id="chrome-signin-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
              spellCheck={false}
            />
          </div>
        </details>
      </div>

      {/* Managing the stored session: where it lives + a Remove that says exactly what it deletes. */}
      {hasSession ? (
        <SettingsGroup>
          <Row
            title={t.browserSigninPathLabel}
            hint={t.browserSigninPathHint}
            control={
              <button
                onClick={() => void window.butin.shell.revealPath(status.path)}
                title={status.path}
                className="text-muted-foreground hover:text-foreground inline-flex max-w-[14rem] items-center gap-1.5 font-mono text-xs underline-offset-2 hover:underline"
              >
                <FolderOpen className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{status.path}</span>
              </button>
            }
          />
          <Row
            title={t.browserSigninRemoveTitle}
            hint={t.browserSigninRemoveHint}
            control={
              <Button
                variant="destructive"
                size="sm"
                onClick={() => remove.mutate()}
                disabled={busy}
                title={t.browserSigninRemoveTooltip}
              >
                {t.browserSigninRemove}
              </Button>
            }
          />
        </SettingsGroup>
      ) : null}
    </div>
  )
}

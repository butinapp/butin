import { useLabels } from '@butinapp/ui/i18n'
import { Button, cn, Input, Label } from '@butinapp/ui/primitives'
import { KeyRound, Lock } from 'lucide-react'
import { useState } from 'react'

import { EncryptionBadge, type VaultState } from './encryption-badge.js'

export type UnlockProfile = { id: string; name: string; color?: string; active: boolean; encryption: VaultState }

// The full-screen gate shown in place of the app when the active profile is locked. Pure + prop-driven: the
// host (core) wires the IPC calls and reloads the window on a successful unlock/switch. A password OR recovery
// key both flow through `onUnlock` (core's vaultUnlock accepts either); the recovery affordance only relabels
// the field. `error` is set by the host on a failed unlock; `busy` disables the form mid-call.
export const UnlockScreen = ({
  profiles,
  onUnlock,
  onSwitchProfile,
  error,
  busy
}: {
  profiles: UnlockProfile[]
  onUnlock: (secret: string) => void
  onSwitchProfile: (id: string) => void
  error?: boolean
  busy?: boolean
}) => {
  const t = useLabels()
  const [secret, setSecret] = useState('')
  const [recovery, setRecovery] = useState(false)
  const active = profiles.find((p) => p.active) ?? profiles[0]
  const others = profiles.filter((p) => p.id !== active?.id)

  const submit = (): void => {
    if (secret.trim() && !busy) {
      onUnlock(secret)
    }
  }

  return (
    <div className="bg-background text-foreground flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="bg-amber-500/10 text-amber-600 dark:text-amber-400 mx-auto mb-5 flex size-12 items-center justify-center rounded-full">
          <Lock className="size-6" />
        </div>

        <h1 className="text-center text-xl font-semibold tracking-tight">{t.lockGateTitle}</h1>
        <p className="text-muted-foreground mt-1.5 text-center text-sm">{t.lockGateBlurb}</p>

        {active && (
          <div className="bg-card mt-5 flex items-center justify-center gap-2 rounded-md border px-3 py-2">
            <span
              className="size-2.5 rounded-full"
              style={{ backgroundColor: active.color ?? 'var(--muted-foreground)' }}
            />
            <span className="truncate text-sm font-medium">{active.name}</span>
            <EncryptionBadge state={active.encryption} />
          </div>
        )}

        <form
          className="mt-5 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="unlock-secret">{recovery ? t.encRecoveryKey : t.lockGatePassword}</Label>
            <Input
              id="unlock-secret"
              type={recovery ? 'text' : 'password'}
              autoFocus
              autoComplete="off"
              value={secret}
              aria-invalid={error || undefined}
              disabled={busy}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>

          {error && <p className="text-destructive text-sm">{t.lockGateBadSecret}</p>}

          <Button type="submit" disabled={!secret.trim() || busy}>
            {busy ? t.lockGateUnlocking : t.lockGateUnlock}
          </Button>

          <button
            type="button"
            className="text-muted-foreground hover:text-foreground inline-flex items-center justify-center gap-1.5 text-sm"
            onClick={() => {
              setRecovery((v) => !v)
              setSecret('')
            }}
          >
            <KeyRound className="size-3.5" />
            {recovery ? t.lockGateUsePassword : t.lockGateUseRecovery}
          </button>
        </form>

        {others.length > 0 && (
          <div className="mt-6 border-t pt-4">
            <p className="text-muted-foreground mb-2 text-center text-xs">{t.lockGateSwitchProfile}</p>
            <ul className="flex flex-col gap-0.5">
              {others.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={busy}
                    className={cn(
                      'hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                      busy && 'pointer-events-none opacity-50'
                    )}
                    onClick={() => onSwitchProfile(p.id)}
                  >
                    <span
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: p.color ?? 'var(--muted-foreground)' }}
                    />
                    <span className="flex-1 truncate">{p.name}</span>
                    <EncryptionBadge state={p.encryption} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

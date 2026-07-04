import { useLabels } from '@butinapp/ui/i18n'
import { Button, Input, Label } from '@butinapp/ui/primitives'
import { Check, Copy, KeyRound, Lock, ShieldOff } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import type { VaultState } from './encryption-badge.js'

// Callbacks the host wires to vault IPC. Fallible ones resolve to false (wrong secret / failure) so the
// control can show an inline error; onEnable resolves to the recovery key to display once, or null on failure.
export type ProfileEncryptionActions = {
  onEnable: (password: string) => Promise<string | null>
  onLock: () => void
  onChangePassword: (oldSecret: string, newPassword: string) => Promise<boolean>
  onResetViaRecovery: (recoveryCode: string, newPassword: string) => Promise<boolean>
  // Turning encryption off re-proves the password (destructive). false = wrong password.
  onDisable: (secret: string) => Promise<boolean>
}

type Mode = 'idle' | 'enable' | 'recovery' | 'change' | 'reset' | 'disable'

// The per-profile encryption block in the Manage profiles list. Pure + prop-driven: state drives which
// controls show. Enable/change/disable need the profile active+unlocked; a locked NON-active profile shows
// only a reset-via-recovery path plus a hint to switch+unlock for the rest.
export const ProfileEncryptionControls = ({
  state,
  active,
  ...actions
}: { state: VaultState; active: boolean } & ProfileEncryptionActions) => {
  const t = useLabels()
  const [mode, setMode] = useState<Mode>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [oldPw, setOldPw] = useState('')
  const [recovery, setRecovery] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [copied, setCopied] = useState(false)

  const reset = (): void => {
    setMode('idle')
    setBusy(false)
    setError(null)
    setPw('')
    setPw2('')
    setOldPw('')
    setRecovery('')
    setRecoveryKey('')
    setCopied(false)
  }

  const enable = async (): Promise<void> => {
    if (pw !== pw2) {
      setError(t.encPasswordMismatch)

      return
    }

    setBusy(true)
    setError(null)
    const key = await actions.onEnable(pw)

    setBusy(false)

    if (key) {
      setRecoveryKey(key)
      setMode('recovery')
    } else {
      setError(t.fetchFailed)
    }
  }

  const change = async (): Promise<void> => {
    if (pw !== pw2) {
      setError(t.encPasswordMismatch)

      return
    }

    setBusy(true)
    setError(null)
    const ok = await actions.onChangePassword(oldPw, pw)

    setBusy(false)

    if (ok) {
      reset()
    } else {
      setError(t.encWrongPassword)
    }
  }

  const resetPassword = async (): Promise<void> => {
    if (pw !== pw2) {
      setError(t.encPasswordMismatch)

      return
    }

    setBusy(true)
    setError(null)
    const ok = await actions.onResetViaRecovery(recovery, pw)

    setBusy(false)

    if (ok) {
      reset()
    } else {
      setError(t.encWrongRecovery)
    }
  }

  const disable = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const ok = await actions.onDisable(pw)

    setBusy(false)

    if (ok) {
      reset()
    } else {
      setError(t.encWrongPassword)
    }
  }

  const copyKey = (): void => {
    void navigator.clipboard?.writeText(recoveryKey)
    setCopied(true)
  }

  // Revert the copied confirmation so the control reads "Copy" again if the user lingers on the reveal.
  useEffect(() => {
    if (!copied) {
      return
    }

    const id = setTimeout(() => setCopied(false), 2000)

    return () => clearTimeout(id)
  }, [copied])

  // The one-time recovery-key reveal — shown after enabling or (optionally) reset, dismissed only by confirm.
  if (mode === 'recovery') {
    return (
      <div className="bg-card mt-1 flex flex-col gap-2 rounded-md border p-3">
        <p className="text-sm font-medium">{t.encRecoveryTitle}</p>
        <p className="text-muted-foreground text-xs">{t.encRecoveryBlurb}</p>
        <div className="flex items-center gap-2">
          <code className="bg-muted flex-1 rounded px-2 py-1.5 font-mono text-sm break-all" data-testid="recovery-key">
            {recoveryKey}
          </code>
          <Button variant="outline" size="sm" onClick={copyKey}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? t.encCopied : t.encCopy}
          </Button>
        </div>
        <Button size="sm" className="self-end" onClick={reset}>
          {t.encSavedRecovery}
        </Button>
      </div>
    )
  }

  if (mode === 'enable') {
    return (
      <PasswordForm
        title={t.encryptProfile}
        blurb={t.encryptProfileHint}
        confirm
        busy={busy}
        error={error}
        pw={pw}
        pw2={pw2}
        setPw={setPw}
        setPw2={setPw2}
        submitLabel={busy ? t.encEnabling : t.encEnable}
        onSubmit={() => void enable()}
        onCancel={reset}
      />
    )
  }

  if (mode === 'change') {
    return (
      <PasswordForm
        title={t.encChangePasswordTitle}
        oldPwLabel={t.encOldPassword}
        oldPw={oldPw}
        setOldPw={setOldPw}
        confirm
        busy={busy}
        error={error}
        pw={pw}
        pw2={pw2}
        setPw={setPw}
        setPw2={setPw2}
        submitLabel={t.encChangePassword}
        onSubmit={() => void change()}
        onCancel={reset}
      />
    )
  }

  if (mode === 'reset') {
    return (
      <PasswordForm
        title={t.encResetTitle}
        blurb={t.encResetBlurb}
        recoveryLabel={t.encRecoveryKey}
        recovery={recovery}
        setRecovery={setRecovery}
        confirm
        busy={busy}
        error={error}
        pw={pw}
        pw2={pw2}
        setPw={setPw}
        setPw2={setPw2}
        submitLabel={t.encReset}
        onSubmit={() => void resetPassword()}
        onCancel={reset}
      />
    )
  }

  // Disabling re-proves the master password (destructive — not one-click just because the machine is unlocked).
  if (mode === 'disable') {
    return (
      <PasswordForm
        title={t.encDisableTitle}
        blurb={t.encDisableBlurb}
        busy={busy}
        error={error}
        pw={pw}
        pw2={pw2}
        setPw={setPw}
        setPw2={setPw2}
        submitLabel={t.encDisableConfirm}
        onSubmit={() => void disable()}
        onCancel={reset}
      />
    )
  }

  // Idle: the action row, by state.
  if (state === 'off') {
    return (
      <div className="mt-1 flex">
        <Button variant="outline" size="sm" onClick={() => setMode('enable')}>
          <Lock className="size-3.5" />
          {t.encryptProfile}
        </Button>
      </div>
    )
  }

  if (state === 'locked') {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setMode('reset')}>
          <KeyRound className="size-3.5" />
          {t.encReset}
        </Button>
        {!active && <span className="text-muted-foreground text-xs">{t.encUnlockToManage}</span>}
      </div>
    )
  }

  // unlocked
  if (!active) {
    return <p className="text-muted-foreground mt-1 text-xs">{t.encUnlockToManage}</p>
  }

  return (
    <div className="mt-1 flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={actions.onLock}>
        <Lock className="size-3.5" />
        {t.encLock}
      </Button>
      <Button variant="outline" size="sm" onClick={() => setMode('change')}>
        <KeyRound className="size-3.5" />
        {t.encChangePassword}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setMode('disable')}>
        <ShieldOff className="size-3.5" />
        {t.encDisable}
      </Button>
    </div>
  )
}

// The shared password-entry form for enable / change / reset. Renders the optional old-password and
// recovery-key fields, the new password + confirm pair, an inline error, and submit/cancel.
const PasswordForm = ({
  title,
  blurb,
  oldPwLabel,
  oldPw,
  setOldPw,
  recoveryLabel,
  recovery,
  setRecovery,
  confirm,
  busy,
  error,
  pw,
  pw2,
  setPw,
  setPw2,
  submitLabel,
  onSubmit,
  onCancel
}: {
  title: string
  blurb?: string
  oldPwLabel?: string
  oldPw?: string
  setOldPw?: (v: string) => void
  recoveryLabel?: string
  recovery?: string
  setRecovery?: (v: string) => void
  confirm?: boolean
  busy?: boolean
  error?: string | null
  pw: string
  pw2: string
  setPw: (v: string) => void
  setPw2: (v: string) => void
  submitLabel: string
  onSubmit: () => void
  onCancel: () => void
}) => {
  const t = useLabels()
  const id = useId()

  return (
    <form
      className="bg-card mt-1 flex flex-col gap-2.5 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <p className="text-sm font-medium">{title}</p>
      {blurb && <p className="text-muted-foreground text-xs">{blurb}</p>}

      {oldPwLabel && setOldPw && (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-old`} className="text-xs">
            {oldPwLabel}
          </Label>
          <Input
            id={`${id}-old`}
            type="password"
            autoComplete="off"
            className="h-8"
            value={oldPw ?? ''}
            onChange={(e) => setOldPw(e.target.value)}
          />
        </div>
      )}

      {recoveryLabel && setRecovery && (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-recovery`} className="text-xs">
            {recoveryLabel}
          </Label>
          <Input
            id={`${id}-recovery`}
            type="text"
            autoComplete="off"
            className="h-8"
            value={recovery ?? ''}
            onChange={(e) => setRecovery(e.target.value)}
          />
        </div>
      )}

      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-new`} className="text-xs">
          {recoveryLabel || oldPwLabel ? t.encNewPassword : t.encMasterPassword}
        </Label>
        <Input
          id={`${id}-new`}
          type="password"
          autoComplete="new-password"
          className="h-8"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      </div>

      {confirm && (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-confirm`} className="text-xs">
            {t.encConfirmPassword}
          </Label>
          <Input
            id={`${id}-confirm`}
            type="password"
            autoComplete="new-password"
            className="h-8"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
          />
        </div>
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t.cancel}
        </Button>
        <Button type="submit" size="sm" disabled={busy || !pw.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

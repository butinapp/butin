import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

import { UnlockScreen } from '@/chrome'

// Renderer-level gate around the routed app. If the ACTIVE profile is locked, the unlock screen replaces the
// whole app — every query downstream would otherwise read an encrypted store. A successful unlock reloads the
// window: the main process has registered the key + re-applied settings, so a full reload re-runs every query
// against the decrypted store. Switching to another profile reloads the window from the main side, after
// which this gate re-evaluates against the new active profile.
export const LockGate = ({ children }: { children: ReactNode }) => {
  const [secretError, setSecretError] = useState(false)
  const [busy, setBusy] = useState(false)
  const { data: profiles, isLoading } = useQuery({
    queryKey: ['profiles'],
    queryFn: () => window.butin.profiles.list()
  })

  // First load: render nothing until the profile list resolves, so the app never flashes before the gate decides.
  if (isLoading || !profiles) {
    return null
  }

  const active = profiles.find((p) => p.active) ?? profiles[0]

  if (!active || active.encryption !== 'locked') {
    return <>{children}</>
  }

  const unlock = async (secret: string): Promise<void> => {
    setBusy(true)
    setSecretError(false)
    const ok = await window.butin.vault.unlock(active.id, secret)

    if (ok) {
      window.location.reload()

      return
    }

    setBusy(false)
    setSecretError(true)
  }

  return (
    <UnlockScreen
      profiles={profiles}
      onUnlock={(secret) => void unlock(secret)}
      onSwitchProfile={(id) => void window.butin.profiles.switch(id)}
      error={secretError}
      busy={busy}
    />
  )
}

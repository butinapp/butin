import { useLabels } from '@butinapp/ui/i18n'
import { cn } from '@butinapp/ui/primitives'
import { Lock, LockOpen } from 'lucide-react'

// A profile's at-rest encryption state: 'off' (no vault), 'locked' (vault present, no key in memory),
// 'unlocked' (vault present + key loaded). Kept in parity with core's encryption state across the IPC
// boundary so the pure UI stays IPC-free.
export type VaultState = 'off' | 'locked' | 'unlocked'

// A small lock indicator shown beside a profile in the switcher / manage list. 'off' renders nothing — an
// unencrypted profile carries no marker; 'locked' is a filled lock, 'unlocked' an open lock.
export const EncryptionBadge = ({ state, className }: { state: VaultState; className?: string }) => {
  const t = useLabels()

  if (state === 'off') {
    return null
  }

  const locked = state === 'locked'
  const Icon = locked ? Lock : LockOpen

  return (
    <Icon
      role="img"
      aria-label={locked ? t.encBadgeLockedAria : t.encBadgeUnlockedAria}
      className={cn(
        'size-3.5 shrink-0',
        locked ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
        className
      )}
    />
  )
}

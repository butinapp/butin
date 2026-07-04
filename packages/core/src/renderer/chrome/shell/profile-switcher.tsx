import { Button, cn } from '@butinapp/ui/primitives'
import { Check, ChevronsUpDown, Settings2 } from 'lucide-react'
import { useState } from 'react'

import { EncryptionBadge, type VaultState } from './encryption-badge.js'

export type ProfileOption = { id: string; name: string; color?: string; active: boolean; encryption: VaultState }

// Top-bar profile picker. Pure + prop-driven: the host (core) feeds the list and handles switch/manage
// via IPC. A plain useState-toggled menu (not the radix dropdown-menu) so it opens under
// fireEvent.click in jsdom — radix menus rely on pointer-capture that jsdom lacks, making tests flaky.
export const ProfileSwitcher = ({
  profiles,
  onSwitch,
  onManage
}: {
  profiles: ProfileOption[]
  onSwitch: (id: string) => void
  onManage: () => void
}) => {
  const [open, setOpen] = useState(false)
  const active = profiles.find((p) => p.active) ?? profiles[0]

  if (!active) {
    return null
  }

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="gap-2"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="size-2 rounded-full" style={{ backgroundColor: active.color ?? 'var(--muted-foreground)' }} />
        <span className="max-w-32 truncate">{active.name}</span>
        <ChevronsUpDown className="size-3.5 opacity-60" />
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="menu"
            aria-label="Profile menu"
            className="bg-popover absolute right-0 z-50 mt-1 w-56 rounded-md border p-1 shadow-md"
          >
            {profiles.map((p) => (
              <button
                key={p.id}
                role="menuitem"
                className="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm"
                onClick={() => {
                  setOpen(false)
                  onSwitch(p.id)
                }}
              >
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: p.color ?? 'var(--muted-foreground)' }}
                />
                <span className="flex-1 truncate">{p.name}</span>
                <EncryptionBadge state={p.encryption} />
                <Check className={cn('size-3.5', p.active ? 'opacity-100' : 'opacity-0')} />
              </button>
            ))}
            <div className="my-1 border-t" />
            <button
              role="menuitem"
              className="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm"
              onClick={() => {
                setOpen(false)
                onManage()
              }}
            >
              <Settings2 className="size-3.5 opacity-60" />
              Manage profiles…
            </button>
          </div>
        </>
      )}
    </div>
  )
}

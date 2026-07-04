import { useLabels } from '@butinapp/ui/i18n'
import { Badge, Button, cn, Input, readableOn } from '@butinapp/ui/primitives'
import { Check, Copy, MoreHorizontal, Palette, Pencil, ShieldCheck, Trash2, X } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { EncryptionBadge, type VaultState } from './encryption-badge.js'
import { ProfileEncryptionControls, type ProfileEncryptionActions } from './profile-encryption-controls.js'

export type ManageProfileRow = { id: string; name: string; color?: string; active: boolean; encryption: VaultState }

// A spread of distinct, brand-leaning swatches for telling profiles (and their duplicates) apart at a glance.
const PROFILE_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6', '#14b8a6']

// One expanded region per card; only one card is ever open. 'edit' swaps the name for an input inline; the
// rest render a panel below the row.
type Panel = { id: string; mode: 'edit' | 'color' | 'delete' | 'encryption' }

// Body of the "Manage profiles" dialog. Pure + prop-driven. A card IS the switch target (clicking an inactive
// card switches to it); everything else — rename, duplicate, color, encryption, delete — lives in a per-card
// menu so the resting view stays calm. The host (core) performs each action over IPC and feeds the refreshed
// list back. `encryptionActions(id)` binds the vault callbacks to one profile; omit it to hide encryption (an
// embed with no vault wiring).
export const ManageProfiles = ({
  profiles,
  onCreate,
  onRename,
  onDelete,
  onSwitch,
  onDuplicate,
  onRecolor,
  encryptionActions
}: {
  profiles: ManageProfileRow[]
  onCreate: (name: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onSwitch: (id: string) => void
  onDuplicate: (id: string) => void
  onRecolor: (id: string, color: string) => void
  encryptionActions?: (id: string) => ProfileEncryptionActions
}) => {
  const t = useLabels()
  const [draft, setDraft] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [editName, setEditName] = useState('')
  const last = profiles.length <= 1

  const create = (): void => {
    const name = draft.trim()

    if (name) {
      onCreate(name)
      setDraft('')
    }
  }

  const openPanel = (p: ManageProfileRow, mode: Panel['mode']): void => {
    setMenuId(null)
    setPanel({ id: p.id, mode })

    if (mode === 'edit') {
      setEditName(p.name)
    }
  }

  const closePanel = (): void => setPanel(null)

  const saveEdit = (id: string): void => {
    const name = editName.trim()

    if (name) {
      onRename(id, name)
    }

    closePanel()
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto">
        {profiles.map((p) => {
          const editing = panel?.id === p.id && panel.mode === 'edit'
          const open = panel?.id === p.id

          return (
            <li
              key={p.id}
              className={cn(
                'rounded-lg border transition-colors',
                p.active ? 'border-primary/40 bg-accent/40' : 'hover:bg-accent/40'
              )}
            >
              <div className="flex items-center gap-2 px-3 py-2.5">
                {editing ? (
                  <>
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: p.color ?? 'var(--muted-foreground)' }}
                    />
                    <Input
                      autoFocus
                      value={editName}
                      aria-label={t.profileNameAria}
                      className="h-8 flex-1"
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          saveEdit(p.id)
                        }

                        if (e.key === 'Escape') {
                          closePanel()
                        }
                      }}
                    />
                    <Button size="sm" onClick={() => saveEdit(p.id)}>
                      {t.profileSave}
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={t.cancel} onClick={closePanel}>
                      <X className="size-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    {p.active ? (
                      <div className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: p.color ?? 'var(--primary)' }}
                        />
                        <span className="truncate text-sm font-medium">{p.name}</span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-label={t.profileSwitchTo(p.name)}
                        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left"
                        onClick={() => onSwitch(p.id)}
                      >
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: p.color ?? 'var(--muted-foreground)' }}
                        />
                        <span className="truncate text-sm">{p.name}</span>
                      </button>
                    )}
                    <EncryptionBadge state={p.encryption} />
                    {p.active && <Badge variant="secondary">{t.profileCurrent}</Badge>}
                    <CardMenu
                      profile={p}
                      open={menuId === p.id}
                      last={last}
                      hasEncryption={Boolean(encryptionActions)}
                      onToggle={() => setMenuId((v) => (v === p.id ? null : p.id))}
                      onClose={() => setMenuId(null)}
                      onRename={() => openPanel(p, 'edit')}
                      onDuplicate={() => {
                        setMenuId(null)
                        onDuplicate(p.id)
                      }}
                      onColor={() => openPanel(p, 'color')}
                      onEncryption={() => openPanel(p, 'encryption')}
                      onDelete={() => openPanel(p, 'delete')}
                    />
                  </>
                )}
              </div>

              {open && panel.mode === 'color' && (
                <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
                  {PROFILE_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={t.profileColorAria(p.name)}
                      className={cn(
                        'size-6 rounded-full ring-offset-2 ring-offset-background transition-[box-shadow]',
                        p.color === c ? 'ring-2 ring-foreground' : 'hover:ring-2 hover:ring-foreground/40'
                      )}
                      style={{ backgroundColor: c }}
                      onClick={() => {
                        onRecolor(p.id, c)
                        closePanel()
                      }}
                    >
                      {p.color === c && <Check className="mx-auto size-3.5" style={{ color: readableOn(c) }} />}
                    </button>
                  ))}
                </div>
              )}

              {open && panel.mode === 'delete' && (
                <div className="flex items-center justify-end gap-2 px-3 pb-3">
                  <Button variant="ghost" size="sm" onClick={closePanel}>
                    {t.cancel}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      onDelete(p.id)
                      closePanel()
                    }}
                  >
                    {t.profileDeleteConfirm}
                  </Button>
                </div>
              )}

              {open && panel.mode === 'encryption' && encryptionActions && (
                <div className="px-3 pb-3">
                  <ProfileEncryptionControls state={p.encryption} active={p.active} {...encryptionActions(p.id)} />
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <div className="flex items-center gap-2 border-t pt-3">
        <Input
          value={draft}
          placeholder={t.profileNewName}
          aria-label={t.profileNewName}
          className="h-8 flex-1"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              create()
            }
          }}
        />
        <Button size="sm" onClick={create} disabled={!draft.trim()}>
          {t.profileAdd}
        </Button>
      </div>
    </div>
  )
}

// The per-card actions menu. A plain useState-toggled popover (not the radix dropdown-menu) so it opens under
// fireEvent.click in jsdom — radix menus rely on pointer-capture jsdom lacks. Duplicate is disabled for a
// locked profile (no key to read its data under); Delete is disabled for the last remaining profile.
const CardMenu = ({
  profile,
  open,
  last,
  hasEncryption,
  onToggle,
  onClose,
  onRename,
  onDuplicate,
  onColor,
  onEncryption,
  onDelete
}: {
  profile: ManageProfileRow
  open: boolean
  last: boolean
  hasEncryption: boolean
  onToggle: () => void
  onClose: () => void
  onRename: () => void
  onDuplicate: () => void
  onColor: () => void
  onEncryption: () => void
  onDelete: () => void
}) => {
  const t = useLabels()
  const lockedDuplicate = profile.encryption === 'locked'
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [coords, setCoords] = useState({ top: 0, left: 0 })

  // Anchor the menu with fixed coordinates read off the trigger, then portal it to <body>. The profile list
  // scrolls, so an absolute menu would clip at the scroll edge — and the dialog's transform would re-base a
  // bare `position: fixed`; portaling out of both keeps the menu whole wherever the row sits. The host dialog
  // is a modal (body gets `pointer-events: none`, re-enabled only inside its content), so the portaled layer
  // must re-assert `pointer-events: auto` or it's click-dead and events fall through to the rows beneath.
  const toggle = (): void => {
    const r = triggerRef.current?.getBoundingClientRect()

    if (r) {
      setCoords({ top: r.bottom + 4, left: Math.max(8, r.right - 192) })
    }

    onToggle()
  }

  return (
    <div className="relative">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="icon"
        aria-label={t.profileActionsAria(profile.name)}
        aria-haspopup="menu"
        onClick={toggle}
      >
        <MoreHorizontal className="size-4" />
      </Button>

      {open &&
        createPortal(
          <>
            <div className="pointer-events-auto fixed inset-0 z-50" aria-hidden onClick={onClose} />
            <div
              role="menu"
              style={{ top: coords.top, left: coords.left }}
              className="bg-popover pointer-events-auto fixed z-50 w-48 rounded-md border p-1 shadow-md"
            >
              <MenuItem icon={<Pencil className="size-3.5" />} label={t.profileRename} onClick={onRename} />
              <MenuItem
                icon={<Copy className="size-3.5" />}
                label={t.profileDuplicate}
                disabled={lockedDuplicate}
                hint={lockedDuplicate ? t.profileDuplicateLockedHint : undefined}
                onClick={onDuplicate}
              />
              <MenuItem icon={<Palette className="size-3.5" />} label={t.profileColor} onClick={onColor} />
              {hasEncryption && (
                <MenuItem
                  icon={<ShieldCheck className="size-3.5" />}
                  label={t.profileManageEncryption}
                  onClick={onEncryption}
                />
              )}
              <div className="my-1 border-t" />
              <MenuItem
                icon={<Trash2 className="size-3.5" />}
                label={t.profileDelete}
                destructive
                disabled={last}
                onClick={onDelete}
              />
            </div>
          </>,
          document.body
        )}
    </div>
  )
}

const MenuItem = ({
  icon,
  label,
  hint,
  destructive,
  disabled,
  onClick
}: {
  icon: ReactNode
  label: string
  hint?: string
  destructive?: boolean
  disabled?: boolean
  onClick: () => void
}) => (
  <button
    role="menuitem"
    aria-disabled={disabled}
    title={hint}
    className={cn(
      'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none select-none',
      disabled ? 'cursor-default opacity-40' : 'hover:bg-accent focus-visible:bg-accent',
      destructive && !disabled && 'text-destructive'
    )}
    onClick={() => {
      if (!disabled) {
        onClick()
      }
    }}
  >
    {icon}
    {label}
  </button>
)

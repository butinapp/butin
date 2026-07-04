import { useLabels } from '@butinapp/ui/i18n'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@butinapp/ui/primitives'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'

import type { ProfileSummaryDto } from '../../shared/ipc.js'

import { ManageProfiles, ProfileSwitcher, type ProfileEncryptionActions } from '@/chrome'

// Top-bar profile control + the manage dialog. Owns all profile IPC (including per-profile encryption); feeds
// the pure @butinapp/ui components. Switching triggers a main-side renderer reload, so there's no client-side
// navigation to do here. Locking the ACTIVE profile reloads the window so the lock gate takes over.
export const ProfileMenu = () => {
  const t = useLabels()
  const queryClient = useQueryClient()
  const [manageOpen, setManageOpen] = useState(false)
  const { data: profiles = [] } = useQuery({ queryKey: ['profiles'], queryFn: () => window.butin.profiles.list() })

  const refresh = (next: ProfileSummaryDto[]): void => {
    queryClient.setQueryData(['profiles'], next)
  }

  const invalidateProfiles = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['profiles'] })
  }

  const create = useMutation({ mutationFn: (name: string) => window.butin.profiles.create(name), onSuccess: refresh })
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => window.butin.profiles.rename(id, name),
    onSuccess: refresh
  })
  const recolor = useMutation({
    mutationFn: ({ id, color }: { id: string; color: string }) => window.butin.profiles.recolor(id, color),
    onSuccess: refresh
  })
  const remove = useMutation({ mutationFn: (id: string) => window.butin.profiles.delete(id), onSuccess: refresh })

  // Clone a profile. A clone of an encrypted profile lands plaintext, so flag that on success; a locked source
  // is refused.
  const duplicate = useMutation({
    mutationFn: (id: string) => window.butin.profiles.duplicate(id),
    onSuccess: (res, id) => {
      if (!res.ok) {
        toast.error(res.error)

        return
      }

      refresh(res.data)

      if (profiles.find((p) => p.id === id)?.encryption === 'unlocked') {
        toast.info(t.encDuplicatePlaintext)
      }
    }
  })

  // Bind the vault callbacks to one profile. Enable returns the recovery key (or null on failure) for the
  // one-time reveal; lock on the active profile reloads into the gate; the fallible mutators resolve to a
  // boolean the control turns into an inline error.
  const encryptionActions = (id: string): ProfileEncryptionActions => {
    const isActive = profiles.find((p) => p.id === id)?.active ?? false

    return {
      onEnable: async (password) => {
        const res = await window.butin.vault.setup(id, password)

        if (!res.ok) {
          toast.error(res.error)

          return null
        }

        invalidateProfiles()

        return res.data.recoveryCode
      },
      onLock: () => {
        void window.butin.vault.lock(id).then(() => {
          if (isActive) {
            window.location.reload()
          } else {
            invalidateProfiles()
          }
        })
      },
      onChangePassword: async (oldSecret, newPassword) => {
        const ok = await window.butin.vault.changePassword(id, oldSecret, newPassword)

        if (ok) {
          toast.success(t.encChangeSaved)
        }

        return ok
      },
      onResetViaRecovery: async (recoveryCode, newPassword) => {
        const ok = await window.butin.vault.resetViaRecovery(id, recoveryCode, newPassword)

        if (ok) {
          invalidateProfiles()

          if (isActive) {
            window.location.reload()
          }
        }

        return ok
      },
      onDisable: async (secret: string) => {
        const res = await window.butin.vault.disable(id, secret)

        if (!res.ok) {
          toast.error(res.error)

          return false
        }

        toast.success(t.encDisabled)
        invalidateProfiles()

        return true
      }
    }
  }

  return (
    <>
      <ProfileSwitcher
        profiles={profiles}
        onSwitch={(id) => void window.butin.profiles.switch(id)}
        onManage={() => setManageOpen(true)}
      />

      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.profilesDialogTitle}</DialogTitle>
            <DialogDescription>{t.profilesDialogBlurb}</DialogDescription>
          </DialogHeader>
          <ManageProfiles
            profiles={profiles}
            onCreate={(name) => create.mutate(name)}
            onRename={(id, name) => rename.mutate({ id, name })}
            onRecolor={(id, color) => recolor.mutate({ id, color })}
            onDuplicate={(id) => duplicate.mutate(id)}
            onSwitch={(id) => void window.butin.profiles.switch(id)}
            onDelete={(id) => remove.mutate(id)}
            encryptionActions={encryptionActions}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}

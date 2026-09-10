import { useLabels } from '@butinapp/ui/i18n'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@butinapp/ui/primitives'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import type { ProfileSummaryDto } from '../../shared/ipc.js'
import { failed } from '../result-toast.js'

import {
  type ArchiveProgressRow,
  ManageProfiles,
  type ProfileArchiveActions,
  type ProfileEncryptionActions,
  ProfileSwitcher
} from '@/chrome'

// Top-bar profile control + the manage dialog. Owns all profile IPC (including per-profile encryption); feeds
// the pure @butinapp/ui components. Switching triggers a main-side renderer reload, so there's no client-side
// navigation to do here. Locking the ACTIVE profile reloads the window so the lock gate takes over.
export const ProfileMenu = () => {
  const t = useLabels()
  const queryClient = useQueryClient()
  const [manageOpen, setManageOpen] = useState(false)
  const [archiveProgress, setArchiveProgress] = useState<ArchiveProgressRow | undefined>()

  // Pack/restore ticks arrive on their own channel (an archive job names a profile, not a plugin), and drive the
  // progress bar inside whichever archive panel is open.
  useEffect(() => window.butin.onArchiveProgress(setArchiveProgress), [])
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
      if (failed(res)) {
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

        if (failed(res)) {
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

        if (failed(res)) {
          return false
        }

        toast.success(t.encDisabled)
        invalidateProfiles()

        return true
      }
    }
  }

  // Archive IPC. Each fallible call toasts its reason and resolves null, so the panel can show its own inline
  // message without the error outliving the dialog.
  const archiveActions: ProfileArchiveActions = {
    onExport: async (id, secret) => {
      const res = await window.butin.profiles.exportArchive(id, secret)

      if (failed(res)) {
        return null
      }

      return res.data
    },
    onPickArchive: () => window.butin.profiles.pickArchive(),
    onInspect: async (path, secret) => {
      const res = await window.butin.profiles.inspectArchive(path, secret)

      return res.ok ? res.data : null
    },
    onImport: async (path, secret, name) => {
      const res = await window.butin.profiles.importArchive(path, secret, name)

      if (failed(res)) {
        return null
      }

      invalidateProfiles()

      return res.data
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
            archiveActions={archiveActions}
            archiveProgress={archiveProgress}
            onImported={(name) => toast.success(t.archiveImported(name))}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}

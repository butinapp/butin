import { type Result } from '../../shared/ipc.js'
import { setLogLevels } from '../log.js'
import { getLogLevelOverrides, getSetting } from '../store/config-file.js'
import { registeredProfileDir } from '../store/profiles.js'
import { configureRequestPacing } from '../transport/request-pacer.js'
import { decryptProfileTree, encryptProfileTree, resumeMigration } from '../vault/migrate.js'
import {
  changePassword,
  disableVault,
  lockVault,
  resetViaRecovery,
  setupVault,
  unlockVault,
  vaultState,
  verifySecret
} from '../vault/vault.js'

import { type IpcHandlers, safeResult } from './result.js'

export const vaultHandlers = {
  status: (_event, profileId: string) => vaultState(registeredProfileDir(profileId)),

  // Enable encryption: mint the vault (which registers the DEK), then seal the profile's existing tree in
  // place. Returns the recovery key for the UI to show ONCE.
  setup: (_event, profileId: string, password: string): Promise<Result<{ recoveryCode: string }>> =>
    safeResult(() => {
      const dir = registeredProfileDir(profileId)
      const { recoveryCode } = setupVault(dir, password)

      encryptProfileTree(dir)

      return Promise.resolve({ recoveryCode })
    }),

  // Unlock + finish any interrupted migration, then re-apply settings that boot read as defaults while the
  // (active) profile was still locked. The renderer reloads after a true result so every query re-runs decrypted.
  unlock: (_event, profileId: string, secret: string) => {
    const dir = registeredProfileDir(profileId)
    const ok = unlockVault(dir, secret)

    if (ok) {
      resumeMigration(dir)
      setLogLevels(getSetting('logLevel'), getLogLevelOverrides())
      configureRequestPacing(getSetting('paceRequests'))
    }

    return ok
  },

  lock: (_event, profileId: string) => {
    lockVault(registeredProfileDir(profileId))
  },

  changePassword: (_event, profileId: string, oldSecret: string, newPassword: string) =>
    changePassword(registeredProfileDir(profileId), oldSecret, newPassword),

  resetViaRecovery: (_event, profileId: string, recoveryCode: string, newPassword: string) =>
    resetViaRecovery(registeredProfileDir(profileId), recoveryCode, newPassword),

  // Disable encryption: re-prove the password (destructive action, not one-click just because the machine is
  // unlocked), then decrypt the tree back to plaintext and remove the vault.
  disable: (_event, profileId: string, secret: string): Promise<Result<void>> =>
    safeResult(() => {
      const dir = registeredProfileDir(profileId)

      if (vaultState(dir) !== 'unlocked') {
        throw new Error('unlock the profile before disabling encryption')
      }

      if (!verifySecret(dir, secret)) {
        throw new Error('incorrect password')
      }

      decryptProfileTree(dir)
      disableVault(dir)

      return Promise.resolve(undefined)
    })
} satisfies IpcHandlers['vault']

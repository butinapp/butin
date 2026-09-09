// A profile's at-rest encryption state: 'off' (no vault), 'locked' (vault present, no key in memory),
// 'unlocked' (vault present + DEK loaded). Drives the switcher badge + the lock gate.
export type VaultStateDto = 'off' | 'locked' | 'unlocked'

// One profile for the top-bar switcher: the stored record plus a resolved active flag + its encryption state.
export type ProfileSummaryDto = {
  id: string
  name: string
  color?: string
  createdAt: string
  active: boolean
  encryption: VaultStateDto
}

// What an export produced. `recoveryCode` is shown once — the second way into the archive when the passphrase
// is gone. `canceled` means the user dismissed the save dialog and nothing was written.
export type ArchiveExportDto = {
  canceled?: boolean
  path?: string
  recoveryCode?: string
  fileCount?: number
  totalBytes?: number
  services?: string[]
  reHomed?: string[]
  unreadableSecrets?: string[]
  sourceEncrypted?: boolean
}

// What an archive says it holds, read from its sealed index before anything is written — the import preview.
export type ArchivePreviewDto = {
  profileName: string
  color?: string
  createdAt: string
  appVersion: string
  packedAt: string
  fileCount: number
  totalBytes: number
  services: string[]
  reHomed: string[]
  unreadableSecrets: string[]
  sourceEncrypted: boolean
}

// The preview plus the profile the import actually created.
export type ArchiveImportDto = ArchivePreviewDto & { profile: ProfileSummaryDto }

// A tick from a running export or import. Its own channel rather than the plugin-scoped job:progress one,
// since an archive job is about a profile and names no plugin.
export type ArchiveProgressDto = { phase: 'packing' | 'restoring'; message?: string; completed: number; total: number }

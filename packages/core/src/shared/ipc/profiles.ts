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

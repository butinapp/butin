// A seed scenario describes a COHORT of profiles for one BUTIN_HOME, each a separate contributor. Every
// profile shares the same base seed (so prices/users/data are byte-identical); divergence comes only from
// each profile's service subset and missed days.

import type { SampleSize } from '../../packages/sdk/src/testing/index.js'

// An inclusive calendar-day range (YYYY-MM-DD) the contributor missed: no observation is emitted in [from, to].
export interface SeedGap {
  from: string
  to: string
}

export interface SeedProfile {
  id: string // profile id — the folder under profiles/ and the partition key (immutable once seeded)
  name: string // display name in the switcher
  color?: string // profile swatch
  services?: string[] // plugin ids this contributor feeds; omitted = every plugin
  gaps?: SeedGap[] // vacation days with no contribution (the missed ledger days)
  // Plugin ids whose VALUES diverge from other contributors (the profile id salts their seed) while every other
  // service stays byte-identical — so two contributors report the same service with different readings, to test
  // the merge's conflict resolution.
  diverge?: string[]
}

// The shared base (now/size/window) + the cohort. now/size/users/documents/days/window all fall back to
// seed-demo's defaults when omitted.
export interface SeedScenario {
  now?: string
  size?: SampleSize
  users?: number
  documents?: number
  days?: number
  window?: number
  profiles: SeedProfile[]
}

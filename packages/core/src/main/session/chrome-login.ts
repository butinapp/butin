// Core's profile-bound view of @butinapp/engine's chrome-login. The mechanism (open real Chrome, gather
// cookies into a partition) lives in the engine so the recorder can use it too; here we bind it to the active
// profile: the Chrome user-data-dir is keyed by the active profile id, and gathered cookies sync into the
// active partition. Call sites keep importing from this module unchanged.
import {
  chromeUserDataDir as engineChromeUserDataDir,
  hasChromeSession as engineHasChromeSession,
  launchChromeSignin as engineLaunchChromeSignin,
  removeChromeSession as engineRemoveChromeSession,
  type ChromeSigninResult
} from '@butinapp/engine'

import { activePartition } from '../browser/shared-session.js'
import { getActiveProfileId } from '../store/profiles.js'

// Pure detection helpers carry through unchanged; re-export the result type for call sites.
export { detectSigninBlock, isSigninBlockUrl } from '@butinapp/engine'
export type { ChromeSigninResult }

// The active profile's persistent Chrome user-data-dir.
export const chromeUserDataDir = (): string => engineChromeUserDataDir(getActiveProfileId())

export const hasChromeSession = (): boolean => engineHasChromeSession(getActiveProfileId())

export const removeChromeSession = (): void => engineRemoveChromeSession(getActiveProfileId())

// Remove a specific profile's Chrome session (used when a profile is deleted).
export const removeChromeSessionFor = (profileId: string): void => engineRemoveChromeSession(profileId)

// Open real Chrome for the active profile, gathering cookies into the active partition.
export const launchChromeSignin = (startUrl: string): Promise<ChromeSigninResult> =>
  engineLaunchChromeSignin(startUrl, { partition: activePartition(), scopeId: getActiveProfileId() })

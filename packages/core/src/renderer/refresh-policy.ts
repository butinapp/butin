import type { TroubleshootingCause } from '@butinapp/sdk'

// Failure causes that hit every one of a plugin's capabilities identically: they all share one session, one
// stored config, one Cloudflare gate, one permission scope. Once a capability fails with one of these, the rest
// will fail the same way — so a refresh stops instead of firing the doomed remainder. A per-request miss (a
// network blip, one capability whose shape changed, an unclassified error) is NOT plugin-wide: a sibling may
// still succeed, so the refresh keeps going.
const PLUGIN_WIDE_CAUSES = new Set<TroubleshootingCause>([
  'session-not-captured',
  'session-expired',
  'config-missing',
  'config-invalid',
  'verification-required',
  'permission'
])

export const isPluginWideFailure = (cause: TroubleshootingCause | undefined): boolean =>
  cause !== undefined && PLUGIN_WIDE_CAUSES.has(cause)

import type { TroubleshootingAction, TroubleshootingCause } from '@butinapp/sdk'

export type ClassifiedFailure = { cause: TroubleshootingCause; actions: TroubleshootingAction[] }

export type FailureInput = {
  status?: number
  capture?: 'closed' | 'no-marker'
  clearOnStatuses?: number[]
  requiresBrowserEngine?: boolean
  configMissing?: boolean
  // Whether the plugin has config fields (an org/team/account/slug). A 404 then almost always means a
  // wrong configured id rather than a generic miss — so it classifies as config-invalid (offer Settings).
  hasConfigFields?: boolean
  // The plugin returned a structurally/contract-invalid CapabilityResult — not an auth/network failure.
  // Re-login won't help; the service's shape changed or the plugin has a bug.
  dataInvalid?: boolean
  // A confirmed dead session with NO HTTP status to key off — an spa-bearer mint that timed out with no
  // bearer (the durable SSO cookie expired). Re-login fixes it, so it classifies as session-expired.
  sessionExpired?: boolean
  message?: string
}

// The controlled action set per cause — what the ErrorPanel offers. Ordered by what the user should try first.
const ACTIONS: Record<TroubleshootingCause, TroubleshootingAction[]> = {
  'session-not-captured': ['retry', 'open-dashboard'],
  'session-expired': ['reconnect'],
  'config-missing': ['edit-settings'],
  'config-invalid': ['edit-settings', 'open-docs'],
  'verification-required': ['reconnect', 'retry'],
  permission: ['open-dashboard', 'retry'],
  network: ['retry'],
  'data-invalid': ['retry', 'open-docs'],
  unknown: ['retry', 'open-docs']
}

// Map a fetch/capture failure onto a recognized cause. Core owns this — it's the place that knows the status
// code, the plugin's clearOnStatuses + cloudflare gating, and the Magic Login capture outcome.
export const classifyFailure = (input: FailureInput): ClassifiedFailure => {
  const cause = ((): TroubleshootingCause => {
    if (input.dataInvalid) {
      return 'data-invalid'
    }

    if (input.capture === 'closed' || input.capture === 'no-marker') {
      return 'session-not-captured'
    }

    if (input.configMissing) {
      return 'config-missing'
    }

    // A dead session, whether signalled by a clearing status (typically 401) or status-less (an spa-bearer
    // mint that yielded no bearer). Both mean: re-run Magic Login.
    if (
      input.sessionExpired ||
      (input.status !== undefined && (input.clearOnStatuses ?? [401]).includes(input.status))
    ) {
      return 'session-expired'
    }

    if (input.status === 403) {
      return input.requiresBrowserEngine ? 'verification-required' : 'permission'
    }

    // A 404 against a plugin that takes a configured id (org/team/account/slug) almost always means that id
    // is wrong — point the user at Settings rather than showing an opaque "something went wrong".
    if (input.status === 404 && input.hasConfigFields) {
      return 'config-invalid'
    }

    if (input.status === undefined && input.message) {
      return 'network'
    }

    return 'unknown'
  })()

  return { cause, actions: ACTIONS[cause] }
}

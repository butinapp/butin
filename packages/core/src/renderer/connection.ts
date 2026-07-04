import type { VerifyResult } from '@butinapp/ui'
import type { ConnState } from '@butinapp/ui/shell'

// The honest connection state every status surface derives from — the colors/labels live in @butinapp/ui's
// connDotClass/connLabel so the sidebar dot, header pill, Management card, and Connection settings card all
// agree. This is the place that COMPUTES it:
//   connected   — confirmed working THIS session (a Test / Reconnect / successful fetch)
//   unverified  — credentials are present (a stored session, or a sessionless plugin's filled-in config) but
//                 we haven't confirmed they work this session — the resting state on relaunch
//   disconnected — confirmed dead (failed probe / expired), or no credentials at all
// `sessionless` (external) plugins get the SAME treatment: having a key typed into Settings is not proof it
// works (keys get revoked, regions/permissions are wrong), so configured-but-unchecked reads blue, not green.
// The disconnected verdict survives relaunch (use-plugin-state persists failures); a green one decays to blue.
export type { ConnState }

export const connState = (plugin: { connected: boolean }, verify?: VerifyResult): ConnState => {
  if (verify) {
    return verify.ok ? 'connected' : 'disconnected'
  }

  return plugin.connected ? 'unverified' : 'disconnected'
}

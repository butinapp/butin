import type { TroubleshootingAction, TroubleshootingCause } from '@butinapp/sdk'
import { useLabels } from '@butinapp/ui/i18n'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'

import type { PluginSummary } from '../../../shared/ipc.js'
import { SETTINGS_TAB_ID } from '../route-helpers.js'

// Resolve a failure into UI: the message (a plugin's own troubleshooting hint wins over the generic
// per-cause copy) and a dispatcher mapping each ErrorPanel action to a concrete effect. `retry` is supplied
// by the caller (re-run this capability / refresh); the rest are uniform across services.
export const useFailureUi = (plugin: PluginSummary) => {
  const t = useLabels()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const message = (cause: TroubleshootingCause): string =>
    plugin.troubleshooting?.[cause]?.hint ?? t.failureMessage[cause]

  const dispatch = (cause: TroubleshootingCause, action: TroubleshootingAction, onRetry: () => void): void => {
    if (action === 'retry') {
      onRetry()
    } else if (action === 'reconnect') {
      void window.butin.services.magicLogin(plugin.id).then(() => qc.invalidateQueries({ queryKey: ['plugins'] }))
    } else if (action === 'edit-settings') {
      void navigate({ to: '/service/$serviceId/$tab', params: { serviceId: plugin.id, tab: SETTINGS_TAB_ID } })
    } else if (action === 'open-dashboard') {
      if (plugin.dashboardUrl) {
        void window.butin.shell.openExternal(plugin.dashboardUrl)
      }
    } else {
      void window.butin.shell.openExternal(
        plugin.troubleshooting?.[cause]?.docUrl ?? 'https://butin.app/docs/troubleshooting'
      )
    }
  }

  return { message, dispatch }
}

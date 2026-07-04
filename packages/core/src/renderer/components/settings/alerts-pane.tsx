import { useLabels } from '@butinapp/ui/i18n'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { PaneSkeleton } from './parts.js'

import { AlertsPane } from '@/chrome'

// IPC wrapper around @butinapp/ui's prop-driven AlertsPane: loads the alert config, saves optimistically (mirrors
// how data-privacy-pane saves FX), and maps the i18n labels in.
export const AlertsSettingsPane = () => {
  const t = useLabels()
  const qc = useQueryClient()
  const { data: config } = useQuery({
    queryKey: ['alertConfig'],
    queryFn: () => window.butin.notifications.getAlertConfig()
  })

  if (!config) {
    return <PaneSkeleton />
  }

  return (
    <AlertsPane
      config={config}
      onChange={(next) => {
        qc.setQueryData(['alertConfig'], next)
        void window.butin.notifications.setAlertConfig(next)
      }}
      labels={{
        changeTitle: t.notifications.settingsChangeTitle,
        healthTitle: t.notifications.settingsHealthTitle,
        fxMissing: t.notifications.settingsFxMissing,
        hint: t.notifications.settingsHint,
        windows: { dod: t.notifications.windowDod, wow: t.notifications.windowWow, mom: t.notifications.windowMom },
        facets: { spend: t.notifications.facetSpend, usage: t.notifications.facetUsage }
      }}
    />
  )
}

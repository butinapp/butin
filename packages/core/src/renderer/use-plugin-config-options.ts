import { type ConfigOption } from '@butinapp/ui'
import { useLabels } from '@butinapp/ui/i18n'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import type { PluginSummary } from '../shared/ipc.js'

// Combobox config fields fetch their choices through the authed client, then PERSIST them to disk (in core).
// The picker seeds from that disk cache — like a capability report — so it shows the list (and the pinned
// choice by name) on relaunch with NO network. A network fetch runs only when nothing is cached yet (and
// connected), or on an explicit refresh (opening the picker). Editing never depends on connection. The
// result plugs straight into PluginConfigForm's combobox props, so the onboarding Settings step and the
// Settings tab share one source for option loading.
export const usePluginConfigOptions = (plugin: PluginSummary) => {
  const t = useLabels()
  const [fieldOptions, setFieldOptions] = useState<Record<string, ConfigOption[]>>({})
  const [fieldOptionsLoading, setFieldOptionsLoading] = useState<Record<string, boolean>>({})

  // The network fetch (re-runs loadOptions, overwrites the disk cache). The combobox's onOpen calls this so
  // opening the picker is the explicit "refresh"; the disk seed below covers the no-network startup path.
  const loadFieldOptions = useCallback(
    async (fieldKey: string): Promise<void> => {
      if (!plugin.connected) {
        return // fetching needs a live session; the cached/typed value still shows and stays editable
      }

      setFieldOptionsLoading((prev) => ({ ...prev, [fieldKey]: true }))

      try {
        const res = await window.butin.services.listConfigOptions(plugin.id, fieldKey)

        if (res.ok) {
          setFieldOptions((prev) => ({ ...prev, [fieldKey]: res.data }))
        } else {
          toast.error(res.error ?? t.fetchFailed)
        }
      } finally {
        setFieldOptionsLoading((prev) => ({ ...prev, [fieldKey]: false }))
      }
    },
    [plugin.id, plugin.connected, t.fetchFailed]
  )

  // Seed each combobox from its disk cache (no network) so the picker shows the last-fetched list + the
  // pinned choice by name on startup. Only when nothing is cached AND we're connected do we fetch once.
  useEffect(() => {
    let cancelled = false

    void (async () => {
      for (const f of plugin.configFields) {
        if (f.kind !== 'combobox' || fieldOptions[f.key]) {
          continue
        }

        const cached = await window.butin.services.getCachedConfigOptions(plugin.id, f.key)

        if (cancelled) {
          return
        }

        if (cached && cached.length > 0) {
          setFieldOptions((prev) => ({ ...prev, [f.key]: cached }))
        } else if (plugin.connected) {
          void loadFieldOptions(f.key)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [plugin.id, plugin.connected, plugin.configFields, fieldOptions, loadFieldOptions])

  return {
    optionsByField: fieldOptions,
    optionsLoading: fieldOptionsLoading,
    onLoadOptions: (key: string): void => void loadFieldOptions(key),
    canLoadOptions: plugin.connected
  }
}

import { type DataTableState } from '@butinapp/ui/primitives'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef } from 'react'

// Persist a table's prefs (sort · column order · visibility · page size) under a stable key, debounced,
// through the settings bridge. Reads the saved prefs once. `key` is any stable string — a service tab passes
// its `<pluginId>.<capabilityId>`, a synthetic page (People) passes a fixed name — so its table remembers
// its layout across visits.
export const useTablePrefs = (key: string) => {
  const qc = useQueryClient()
  const queryKey = ['tablePrefs', key]
  // Coalesce to null: getTablePrefs resolves undefined when nothing is saved, and TanStack Query forbids a
  // queryFn returning undefined ("Query data cannot be undefined").
  const prefsQ = useQuery({
    queryKey,
    queryFn: async () => (await window.butin.settings.getTablePrefs(key)) ?? null
  })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onStateChange = (next: DataTableState): void => {
    // Keep the cache authoritative so remounting seeds from the latest edit (not a stale read that would
    // briefly show the pre-edit value); the debounced write then lands on disk.
    qc.setQueryData(queryKey, next)

    if (timer.current) {
      clearTimeout(timer.current)
    }

    timer.current = setTimeout(() => void window.butin.settings.setTablePrefs(key, next), 400)
  }

  return { initialState: prefsQ.data ?? undefined, onStateChange }
}

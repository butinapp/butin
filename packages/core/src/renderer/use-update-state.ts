import { useLabels } from '@butinapp/ui/i18n'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

import type { UpdateStateDto } from '../shared/ipc.js'

const KEY = ['updateState']

// The app's update state: seeded from main on mount (a pane opened mid-download starts at the right point), then
// kept live off the push channel. Every subscriber shares the one query entry.
export const useUpdateState = (): UpdateStateDto | undefined => {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: KEY, queryFn: () => window.butin.updates.state() })

  useEffect(() => window.butin.onUpdateState((state) => qc.setQueryData(KEY, state)), [qc])

  return data
}

// Announce a downloaded update once, wherever the user is, with the restart as the toast's action. The toast
// stays until acted on or dismissed; a dismissed one is not repeated for the same version, since the restart
// button remains under Settings → About.
export const useUpdateToast = (): void => {
  const t = useLabels()
  const state = useUpdateState()
  const announced = useRef(new Set<string>())

  useEffect(() => {
    if (state?.kind !== 'ready' || announced.current.has(state.version)) {
      return
    }

    announced.current.add(state.version)
    toast(t.updateReady(state.version), {
      duration: Number.POSITIVE_INFINITY,
      action: { label: t.updateRestartShort, onClick: () => void window.butin.updates.install() }
    })
  }, [state, t])
}

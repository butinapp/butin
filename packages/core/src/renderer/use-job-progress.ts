import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import type { JobProgressDto } from '../shared/ipc.js'

// Subscribe to the shared job:progress channel, scoped to one plugin (and optionally one capability). The
// channel is global, so every panel filters; this hook centralizes that filter + the unsubscribe. `onTick`
// is kept in a ref so a fresh closure each render doesn't re-subscribe — only the ids do.
export const useJobProgress = (
  pluginId: string,
  capabilityId: string | null,
  onTick: (p: JobProgressDto) => void
): void => {
  const cb = useRef(onTick)

  cb.current = onTick

  useEffect(() => {
    const off = window.butin.onJobProgress((p) => {
      if (p.pluginId !== pluginId || (capabilityId !== null && p.capabilityId !== capabilityId)) {
        return
      }

      cb.current(p)
    })

    return off
  }, [pluginId, capabilityId])
}

// The export/extract progress tick shape (ExportProgressView ≡ ExtractAllProgressView) projected off a raw
// job:progress event — identical at both call sites.
export const phaseProgress = (
  p: JobProgressDto
): { phase: string; message?: string; completed?: number; total?: number } => ({
  phase: p.phase ?? '',
  message: p.message,
  completed: p.completed,
  total: p.total
})

// The per-plugin documents output folder, shared by the Documents + Export panels under one query key.
export const useDocFolder = (pluginId: string) =>
  useQuery({ queryKey: ['docFolder', pluginId], queryFn: () => window.butin.files.folderGet(pluginId, 'documents') })

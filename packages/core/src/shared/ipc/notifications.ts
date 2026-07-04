// The comparison window + the flow metric a change alert watches.
export type AlertWindow = 'dod' | 'wow' | 'mom'
export type AlertFacet = 'spend' | 'usage'

export type AlertConfigDto = {
  // pct thresholds keyed by window then facet; an absent facet key = that alert is off.
  change: Record<AlertWindow, Partial<Record<AlertFacet, number>>>
  health: { fxMissing: boolean }
}

// A stored notification. `id` IS the dedupe key:
//   change:<pluginId>:<facet>:<window>:<periodId>   |   health:fx:<pluginId>
// Title/body are NOT stored — the renderer formats them from these structured fields (current names + locale).
export type NotificationDto = {
  id: string
  createdAt: string // ISO
  kind: 'change' | 'health'
  severity: 'info' | 'warning'
  pluginId?: string // '__total__' for the cross-service spend total
  facet?: AlertFacet
  window?: AlertWindow
  current?: number
  previous?: number
  pct?: number // signed fraction; absent for "new spend" + health notices
  currency?: string
  read: boolean
}

// What an evaluator emits — identity (id) + structured fields, minus the persisted createdAt/read.
export type NotificationDraft = Omit<NotificationDto, 'createdAt' | 'read'>

// Structurally identical to core's NotificationDto / AlertConfigDto. @butinapp/ui defines its own so it stays
// decoupled from core's IPC layer (the app passes its DTOs straight through).
export type AlertWindow = 'dod' | 'wow' | 'mom'
export type AlertFacet = 'spend' | 'usage'

export type NotificationView = {
  id: string
  createdAt: string
  kind: 'change' | 'health'
  severity: 'info' | 'warning'
  pluginId?: string
  facet?: AlertFacet
  window?: AlertWindow
  current?: number
  previous?: number
  pct?: number
  currency?: string
  read: boolean
}

export type AlertConfigView = {
  change: Record<AlertWindow, Partial<Record<AlertFacet, number>>>
  health: { fxMissing: boolean }
}

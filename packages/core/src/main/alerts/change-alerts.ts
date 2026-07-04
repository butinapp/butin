import type { DailyPoint } from '@butinapp/shapes'

import type { AlertConfigDto, AlertFacet, AlertWindow, NotificationDraft } from '../../shared/ipc.js'

import { periodPair } from './windows.js'

export interface SeriesInput {
  pluginId: string
  facet: AlertFacet
  currency: string
  daily: DailyPoint[]
}

const WINDOWS: AlertWindow[] = ['dod', 'wow', 'mom']

// Emit one draft per (series, window) whose completed-period change meets the configured threshold. A rise
// from zero is reported as a "new spend/usage" notice with no percentage; an absent threshold is skipped.
export const evaluateChangeAlerts = (
  series: SeriesInput[],
  rules: AlertConfigDto['change'],
  now: Date
): NotificationDraft[] => {
  const out: NotificationDraft[] = []

  for (const s of series) {
    for (const window of WINDOWS) {
      const threshold = rules[window][s.facet]

      if (threshold === undefined) {
        continue
      }

      const pair = periodPair(s.daily, window, now)

      if (!pair) {
        continue
      }

      const base: NotificationDraft = {
        id: `change:${s.pluginId}:${s.facet}:${window}:${pair.periodId}`,
        kind: 'change',
        severity: 'info',
        pluginId: s.pluginId,
        facet: s.facet,
        window,
        previous: pair.prev,
        current: pair.curr,
        currency: s.currency
      }

      if (pair.prev === 0) {
        if (pair.curr > 0) {
          out.push(base) // new spend/usage — no pct
        }

        continue
      }

      const pct = (pair.curr - pair.prev) / pair.prev

      if (Math.abs(pct) * 100 >= threshold) {
        out.push({ ...base, pct })
      }
    }
  }

  return out
}

import { readLedger } from '../store/ledger.js'
import { buildOverview } from '../store/overview.js'
import { buildPeople } from '../store/people.js'
import { dailyByColumn, dailySpend } from '../store/project-ledger.js'
import { readCurrent, reconstructResult } from '../store/store.js'

import type { IpcHandlers } from './result.js'

export const reportHandlers = {
  get: async (_event, pluginId: string, capabilityId: string) => {
    const envelope = await readCurrent(pluginId, capabilityId)

    if (!envelope) {
      return null
    }

    // Serve a full CapabilityResult reconstructed from the stored projection + manifest (labels/spark/views
    // reattached), so the renderer draws it directly. A non-conforming payload passes through unchanged.
    return { ...envelope, data: reconstructResult(envelope.data) ?? envelope.data }
  },

  dailySpend: async (_event, pluginId: string, capabilityId: string) => {
    const led = await readLedger(pluginId, capabilityId)

    return led ? dailySpend(led) : []
  },

  ledger: (_event, pluginId: string, capabilityId: string) => readLedger(pluginId, capabilityId),

  rowDailySpend: async (_event, pluginId: string, capabilityId: string, datasetId: string, columnKey: string) => {
    const led = await readLedger(pluginId, capabilityId)
    const log = led?.datasets.find((d) => d.id === datasetId)

    if (!log) {
      return {}
    }

    // The stored column carries the reset semantics (a monthly-resetting MTD counter vs a plain running total),
    // so the daily differencing handles month rollovers without the renderer passing it.
    const resetPeriod = log.columns.find((c) => c.key === columnKey)?.resetPeriod

    return dailyByColumn(log, columnKey, resetPeriod)
  },

  overview: () => buildOverview(),

  people: () => buildPeople()
} satisfies IpcHandlers['reports']

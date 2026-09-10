import type { ButinPlugin, Capability } from '@butinapp/sdk'
import type { Ledger } from '@butinapp/shapes'

import { createLogger } from '../log.js'
import { plugins } from '../plugin/plugins.js'

import { getPluginInstalled } from './config-file.js'
import { readLedger, writeLedger } from './ledger.js'
import { projectCurrent } from './project-ledger.js'
import { readCurrent, saveCurrent, type StoredData } from './store.js'

// Retention arrived after these stores were already on disk, so a roster captured earlier reads as an append
// log: every member it ever saw still projects as current, and someone who left months ago keeps the role they
// last held. Both halves are repaired from data already recorded — a row's `seenTo` has always been the last
// fetch that carried it — so no service is refetched.

// The dataset ids a capability declares as snapshots. `sample()` is built by the SAME `build` as a live fetch,
// so its datasets carry the retention a real one would, with no network. A capability without a sample (an
// imperative collector) is skipped: its shape isn't knowable until it next runs, when the fetch stamps it.
export const snapshotIdsOf = (capability: Capability): Set<string> => {
  const result = capability.sample?.()

  return new Set(
    (result?.datasets ?? []).filter((d) => d.shape === 'table' && d.retention === 'snapshot').map((d) => d.id)
  )
}

// Stamp the snapshot mode onto logs that predate it, so the log is self-describing from here on. null when
// every log already declares its mode — the signal that this ledger needs no rewrite.
export const stampRetention = (led: Ledger, snapshotIds: Set<string>): Ledger | null => {
  const stale = led.datasets.filter((d) => snapshotIds.has(d.id) && d.retention === undefined)

  if (stale.length === 0) {
    return null
  }

  return {
    ...led,
    datasets: led.datasets.map((d) =>
      snapshotIds.has(d.id) && d.retention === undefined ? { ...d, retention: 'snapshot' as const } : d
    )
  }
}

// Re-project a stale cache's roster rows from the ledger, leaving every other dataset (and the summaries and
// manifest) untouched. null when no roster actually changed, so an unaffected profile is never rewritten.
export const repairRows = (data: StoredData, led: Ledger, snapshotIds: Set<string>): StoredData | null => {
  const projected = projectCurrent(led)
  let changed = false

  const datasets = data.datasets.map((ds) => {
    const proj = snapshotIds.has(ds.id) ? projected.get(ds.id) : undefined

    if (!proj || proj.rows.length === ds.rows.length) {
      return ds
    }

    changed = true

    return { ...ds, retention: 'snapshot' as const, rows: proj.rows }
  })

  return changed ? { ...data, datasets } : null
}

// Repair one capability's stores in place. Returns how many rows stopped counting as current.
const repairCapability = async (plugin: ButinPlugin, capability: Capability): Promise<number> => {
  const snapshotIds = snapshotIdsOf(capability)

  if (snapshotIds.size === 0) {
    return 0
  }

  const led = await readLedger(plugin.meta.id, capability.id)

  if (!led) {
    return 0
  }

  const stamped = stampRetention(led, snapshotIds)

  if (stamped) {
    await writeLedger(plugin.meta.id, capability.id, stamped)
  }

  const envelope = await readCurrent(plugin.meta.id, capability.id)
  const data = envelope?.data as StoredData | undefined

  if (!data?.datasets) {
    return 0
  }

  const repaired = repairRows(data, stamped ?? led, snapshotIds)

  if (!repaired) {
    return 0
  }

  const dropped = data.datasets.reduce(
    (n, ds) => n + (ds.rows.length - (repaired.datasets.find((r) => r.id === ds.id)?.rows.length ?? ds.rows.length)),
    0
  )

  // Keep the original fetch time: these rows were last confirmed then, and restamping it would assert the
  // roster was verified now — the very thing that made the stale cache misleading.
  await saveCurrent(plugin.meta.id, capability.id, repaired, envelope!.lastRunAt)

  return dropped
}

// Bring every installed service's cached rosters in line with what its last fetch actually returned. Runs once
// per launch; idempotent, and a no-op on a profile that has nothing stale.
export const repairSnapshotCurrents = async (): Promise<void> => {
  const log = createLogger({ scope: 'repair' })
  let dropped = 0

  for (const plugin of plugins.filter((p) => getPluginInstalled(p.meta.id))) {
    for (const capability of plugin.capabilities) {
      try {
        dropped += await repairCapability(plugin, capability)
      } catch (err) {
        // A single unreadable store must not stop the sweep, and never blocks launch.
        log.warn(`${plugin.meta.id}/${capability.id}: ${(err as Error).message}`)
      }
    }
  }

  if (dropped > 0) {
    log.info(`${dropped} departed rows dropped from cached rosters`)
  }
}

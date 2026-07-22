import type { OverviewPlugin } from '@butinapp/shapes'
import { EXPORT_BUNDLE_FORMAT_VERSION, type ExportBundle, type ExportPlugin } from '@butinapp/shapes/bundle'
import { app } from 'electron'

import type { OverviewTileDto } from '../../shared/ipc.js'
import { plugins } from '../plugin/plugins.js'
import { getPluginEnabled } from '../store/config-file.js'
import { readLedger } from '../store/ledger.js'
import { buildOverview } from '../store/overview.js'
import { listProfiles } from '../store/profiles.js'
import { dailySpend, rowDailyOf } from '../store/project-ledger.js'
import { readCurrent, reconstructResult } from '../store/store.js'

// Map one home tile (the IPC DTO core assembles) onto the @butinapp/ui Overview input, so the export bundle and
// the live app derive the Overview from one rule. balance is the value of the balance-section summary (a service
// can report spend AND balance). summaries threads the full per-section set so the bundle-fed rollup + section
// partition see every section a service reports, not just the primary.
export const toOverviewPlugin = (d: OverviewTileDto): OverviewPlugin => ({
  pluginId: d.pluginId,
  pluginName: d.name,
  color: d.color,
  icon: d.icon,
  monthly: d.monthly,
  daily: d.daily,
  balance: d.summaries?.find((s) => s.section === 'balance')?.value,
  itemCount: d.itemCount,
  lastRunAt: d.lastRunAt,
  state: d.state,
  summaries: d.summaries
})

// Gather one plugin's cached capability data into the bundle shape. Returns null when the plugin has no
// cached data at all (a never-fetched service contributes nothing to a shared export).
const toExportPlugin = async (p: (typeof plugins)[number]): Promise<ExportPlugin | null> => {
  const capabilities = await Promise.all(
    p.capabilities.map(async (c) => {
      const [report, led] = await Promise.all([readCurrent(p.meta.id, c.id), readLedger(p.meta.id, c.id)])

      // Reconstruct the stored projection + manifest into a full CapabilityResult so @butinapp/viewer renders the
      // bundle directly (labels/spark/views reattached). A non-conforming payload passes through unchanged.
      // `daily`/`rowDaily` carry the per-day detail derived from the ledger (the same series the live service
      // page fetches over IPC) so the drilldown + Trend sparklines render off the bundle alone.
      const daily = led ? dailySpend(led) : []

      return {
        id: c.id,
        label: c.label,
        result: report ? (reconstructResult(report.data) ?? report.data) : undefined,
        lastRunAt: report?.lastRunAt,
        daily: daily.length > 0 ? daily : undefined,
        rowDaily: led ? rowDailyOf(led) : undefined
      }
    })
  )

  if (!capabilities.some((c) => c.result !== undefined)) {
    return null
  }

  return {
    meta: {
      id: p.meta.id,
      name: p.meta.name,
      vendor: p.meta.vendor,
      category: p.meta.category,
      color: p.meta.color,
      icon: p.meta.icon,
      dashboardUrl: p.meta.dashboardUrl,
      capabilities: p.capabilities.map((c) => ({ id: c.id, label: c.label }))
    },
    capabilities
  }
}

// Assemble the portable export bundle from the active profile's cached reports — pure IO glue over the
// existing stores + overview assembler; no collectors run. Enabled plugins only (a disabled service is out
// of the shared view), further narrowed to `serviceIds` when the caller selects a subset. The bundle is
// self-contained (icons are inlined data-URIs) so a cloud page renders it through @butinapp/viewer with no network.
export const buildExportBundle = async (serviceIds?: string[]): Promise<ExportBundle> => {
  const pick = serviceIds && new Set(serviceIds)
  const enabled = plugins.filter((p) => getPluginEnabled(p.meta.id) && (!pick || pick.has(p.meta.id)))
  const tiles = await buildOverview()
  const enabledIds = new Set(enabled.map((p) => p.meta.id))

  const exported = (await Promise.all(enabled.map(toExportPlugin))).filter((p): p is ExportPlugin => p !== null)
  const profileName = listProfiles().find((p) => p.active)?.name

  return {
    formatVersion: EXPORT_BUNDLE_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    butinVersion: app.getVersion(),
    profileName,
    plugins: exported,
    overview: tiles.filter((t) => enabledIds.has(t.pluginId)).map(toOverviewPlugin)
  }
}

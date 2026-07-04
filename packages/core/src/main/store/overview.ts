import { type MonthPoint, type Section, type Summary } from '@butinapp/sdk/data'
import { currentMonthKey, round2 } from '@butinapp/sdk/util'
import { deriveDailySpend } from '@butinapp/shapes'
import { sumBy, uniqBy } from 'lodash-es'

import type { OverviewTileDto } from '../../shared/ipc.js'
import { log } from '../log.js'
import { isPluginConnected } from '../plugin/connection.js'
import { plugins } from '../plugin/plugins.js'

import { getPluginInstalled } from './config-file.js'
import { readLedger } from './ledger.js'
import { seriesPoints } from './project-ledger.js'
import { readCurrent, reconstructResult } from './store.js'

// Reconstruct a cached capability payload's summaries (label/spark reattached from the manifest). [] for a
// non-conforming payload (custom capabilities) or one carrying no summaries.
export const summariesFrom = (data: unknown): Summary[] => reconstructResult(data)?.summaries ?? []

// Pull a plugin's per-month series off a reconstructed CapabilityResult, using a chosen summary's `spark`
// pointer (dataset id + x/y keys). Returns [] when there's no spark or the referenced table isn't present.
export const monthlySeriesOf = (data: unknown, summary?: Summary): MonthPoint[] => {
  if (!summary?.spark) {
    return []
  }

  const datasets = (data as { datasets?: unknown }).datasets

  if (!Array.isArray(datasets)) {
    return []
  }

  const ds = datasets.find(
    (d): d is { id: string; shape: string; rows: Record<string, unknown>[] } =>
      typeof d === 'object' && d != null && (d as { id?: unknown }).id === summary.spark!.dataset
  )

  if (!ds || ds.shape !== 'table' || !Array.isArray(ds.rows)) {
    return []
  }

  const { x, y } = summary.spark

  return ds.rows.map((row) => ({ month: String(row[x] ?? ''), amount: Number(row[y]) || 0 }))
}

// Count the items a plugin's cached payload holds: every row across its table datasets, plus one per
// record dataset. Feeds the Activity tile ("N items") for non-monetary plugins. Tolerant of
// non-conforming payloads (custom capabilities / no datasets) — returns 0.
export const countItems = (data: unknown): number => {
  if (typeof data !== 'object' || data === null) {
    return 0
  }

  const datasets = (data as { datasets?: unknown }).datasets

  if (!Array.isArray(datasets)) {
    return 0
  }

  return datasets.reduce<number>((sum, d) => {
    if (typeof d !== 'object' || d === null) {
      return sum
    }

    const shape = (d as { shape?: unknown }).shape

    if (shape === 'table') {
      const rows = (d as { rows?: unknown }).rows

      return sum + (Array.isArray(rows) ? rows.length : 0)
    }

    if (shape === 'record') {
      return sum + 1
    }

    return sum
  }, 0)
}

const isSpend = (s?: Summary): boolean => s?.section === 'spend'

// A plugin's primary metric: an explicit headline:true wins, else spend > balance > other.
export const pickPrimarySummary = (entries: { summary?: Summary }[]): Summary | undefined => {
  const order: Section[] = ['spend', 'balance', 'other']

  return (
    entries.find((e) => e.summary?.headline)?.summary ??
    order.flatMap((sec) => entries.filter((e) => e.summary?.section === sec).map((e) => e.summary))[0]
  )
}

// Read every plugin's cached capability data, pick its primary summary, and shape a home tile. Pure
// IO glue over the tested selectors above — no collectors run.
export const buildOverview = async (): Promise<OverviewTileDto[]> => {
  // Only INSTALLED plugins are candidates — an Available (not-yet-installed) plugin has nothing here.
  const tiles = await Promise.all(
    plugins
      .filter((p) => getPluginInstalled(p.meta.id))
      .map(async (p) => {
        const reports = await Promise.all(
          p.capabilities.map(async (c) => ({ id: c.id, report: await readCurrent(p.meta.id, c.id) }))
        )

        // Materialize each report's summaries once — avoids repeated reconstructResult calls per capability.
        const withSummaries = reports.map((r) => ({ ...r, summaries: summariesFrom(r.report?.data) }))
        const entries = withSummaries.flatMap((r) => r.summaries.map((summary) => ({ summary })))
        const lastRunAt = reports
          .map((r) => r.report?.lastRunAt)
          .filter((t): t is string => Boolean(t))
          .sort()
          .at(-1)

        // The spend capability drives both the monthly spark and the daily series — found by a summary's
        // section. Its spend summary supplies the spark pointer for the monthly series.
        const spendReport = withSummaries.find((r) => r.summaries.some(isSpend))
        const spendSummary = spendReport?.summaries.find(isSpend)
        const monthly = monthlySeriesOf(spendReport?.report?.data, spendSummary)
        // countItems reads the stored datasets shape (StoredDataset[]) directly — no reconstruction needed.
        const itemCount = sumBy(reports, (r) => countItems(r.report?.data))
        const led = spendReport ? await readLedger(p.meta.id, spendReport.id) : null
        const spendPoints = led && spendSummary ? seriesPoints(led, 'spend') : []
        const daily = spendPoints.length > 0 ? deriveDailySpend(spendPoints) : []
        // Peak spend reading captured this (reporting-zone) month — the fallback THIS MO for an arrears service
        // whose just-closed month has no invoice bar yet AND whose live open-period figure has already reset for
        // the next period (Anthropic at the UTC month boundary). MAX ignores that reset drop; only meaningful for
        // the monthly-resetting 'spend' series, and only consulted by the rollup when there's no current-month bar.
        const nowMonth = currentMonthKey()
        const monthReadings = spendPoints.filter((pt) => pt.date.startsWith(nowMonth)).map((pt) => pt.value)
        const currentMonthAccrual = monthReadings.length > 0 ? round2(Math.max(...monthReadings)) : undefined

        // Deduplicate summaries by section (first-wins) across ALL capabilities — this is the full set of
        // metrics this service reports, used by the cross-service rollup + section partition (a service shows
        // in every section it reports).
        const allSummaries = uniqBy(entries.map((e) => e.summary).filter(Boolean), (s) => s.section)

        // One spend per service is the contract (the plugin reconciles its own lines). More than one across its
        // capabilities means the dedup above dropped some spend — surface it rather than silently under-count.
        const spendCount = entries.filter((e) => e.summary?.section === 'spend').length

        if (spendCount > 1) {
          log.warn('overview', `plugin '${p.meta.id}' emits ${spendCount} spend summaries; only one is allowed`)
        }

        const primary = pickPrimarySummary(entries)

        return {
          pluginId: p.meta.id,
          name: p.meta.name,
          color: p.meta.color,
          icon: p.meta.icon,
          state: isPluginConnected(p) ? 'connected' : 'disconnected',
          summary: primary,
          summaries: allSummaries.length > 0 ? allSummaries : undefined,
          // The currency the service's headline is actually denominated in — the primary summary's currency
          // (a plugin can bill in a currency that differs from its static reportingCurrency, e.g. a CAD account
          // on a USD-default plugin). This drives the FX pane's rate rows + the Overview's conversion, so it
          // MUST match the summary value's currency or a foreign figure converts to 0 (no rate) and the FX pane
          // never offers the rate. Falls back to reportingCurrency when no summary carries one (count facets).
          currency: primary?.currency ?? p.reportingCurrency,
          lastRunAt,
          monthly: monthly.length > 0 ? monthly : undefined,
          daily: daily.length > 0 ? daily : undefined,
          currentMonthAccrual,
          itemCount: itemCount > 0 ? itemCount : undefined
        } satisfies OverviewTileDto
      })
  )

  // The Overview is a DATA dashboard, so surface only services that have actually brought data home (a
  // report exists → lastRunAt). An installed-but-never-fetched service has nothing to show and would
  // otherwise render as an empty tile in the Activity band, flagged "connected" off a stored cookie — which
  // contradicts the sidebar (it hides a service until it has data). First fetch is what puts it on the home.
  return tiles.filter((t) => t.lastRunAt != null)
}

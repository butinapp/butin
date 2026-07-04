import type { MonthPoint, Summary } from '@butinapp/sdk/data'
import type { DailyPoint } from '@butinapp/shapes'

// One home tile: a plugin's identity, connection state, and primary metric (if any cached). Built from
// the report store — never triggers a collector.
export type OverviewTileDto = {
  pluginId: string
  name: string
  color?: string
  icon?: string
  state: 'connected' | 'disconnected'
  // The primary summary — drives the tile's displayed headline metric + band placement.
  summary?: Summary
  // All summaries this service reports, deduped by facet (first-wins). Carries every facet a service
  // reports so the cross-service rollup can include secondaries (e.g. a billing capability reporting
  // both spend.mtd and balance) — not just the primary. Absent when no summaries are present.
  summaries?: Summary[]
  lastRunAt?: string
  // The currency this plugin's monthly/daily series + summary are denominated in (its reportingCurrency), so
  // the cross-service rollup can convert to the user's base currency.
  currency?: string
  // Each plugin's per-month billing series (from summary.spark), so Overview can chart/compare without re-fetching.
  monthly?: MonthPoint[]
  // Per-day spend derived from this plugin's ledger spend series — summed across services for the combined
  // chart's Daily mode. Absent when no ledger series points exist for the plugin.
  daily?: DailyPoint[]
  // Peak spend reading captured this (reporting-zone) month — the rollup's fallback THIS MO for an arrears
  // service with no current-month invoice bar and a live figure that has reset for the next period.
  currentMonthAccrual?: number
  // Total items the plugin's cached payloads hold (Σ table rows + record datasets) — feeds Activity tiles.
  itemCount?: number
}

export type StoredReport = { lastRunAt: string; data: unknown } | null

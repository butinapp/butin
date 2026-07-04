import { MonthPointSchema, SummarySchema } from '@butinapp/sdk/schema'
import { z } from 'zod'

import { DailyPointSchema } from './daily.js'

// The pure INPUT view-model for the cross-service Overview. Lives here (not in @butinapp/ui) so both the
// producer (core's overview assembler / the export bundle) and the consumer (@butinapp/ui's derivation, the
// embed viewer) share one type. @butinapp/ui re-exports it and owns the DERIVATION (combinedMonthly, movers,
// byServiceRows, …) — this module is types only, no Electron, no React. Schema-defined so the export-bundle
// validator can reuse it at the cross-version boundary.

export const OverviewPluginSchema = z.object({
  pluginId: z.string(),
  pluginName: z.string(),
  color: z.string().optional(),
  icon: z.string().optional(),
  monthly: z.array(MonthPointSchema).optional(),
  // Pre-derived per-day spend (from this plugin's billing capture series), summed across services for the
  // combined chart's Daily mode.
  daily: z.array(DailyPointSchema).optional(),
  // Peak spend reading captured this (reporting-zone) month — the rollup's fallback THIS MO for an arrears
  // service whose just-closed month has no invoice bar yet and whose live open-period figure has reset.
  currentMonthAccrual: z.number().optional(),
  // The currency this plugin's monthly/daily spend series + balance are denominated in (its reportingCurrency).
  // Optional: a never-fetched / non-money plugin omits it. The Overview derivation converts from it to baseCurrency.
  currency: z.string().optional(),
  // Partition inputs: a service appears in every section its summaries report; balance feeds the Balances
  // rollup; itemCount + lastRunAt + state feed the Activity tiles. All optional — a never-fetched plugin
  // still gets a tile.
  balance: z.number().optional(),
  itemCount: z.number().optional(),
  lastRunAt: z.string().optional(),
  state: z.enum(['connected', 'disconnected']).optional(),
  // Every summary this service reports (deduped by section, first-wins). Drives the section partition + the
  // cross-service rollup so a bundle-fed Overview (via @butinapp/viewer) sees every section a service emits.
  // Absent when a tile has no summaries.
  summaries: z.array(SummarySchema).optional()
})
export type OverviewPlugin = z.infer<typeof OverviewPluginSchema>

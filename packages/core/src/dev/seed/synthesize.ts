// Compose the seed for one capability: a snapshot → the real split → the evolver's daily observations → the
// real ledger fold → the latest projection, exactly mirroring runCapability's persistence so the seeded store
// is byte-shaped like a genuinely-fetched one.

import {
  resolveCurrencies,
  validateCapabilityResult,
  type CapabilityResult,
  type CurrencyCode
} from '@butinapp/sdk/data'
import {
  splitResult,
  type Ledger,
  type PresentationManifest,
  type StoredDataset,
  type StoredSummary
} from '@butinapp/shapes'

import { appendObservation } from '../../main/store/ledger.js'
import { backfillAccrualBars, projectCurrent } from '../../main/store/project-ledger.js'

import { backfillMonthlySeries, type EvolveOptions, evolveObservations } from './evolver.js'

// Monthly history every spend series is padded to, so the Overview's detailed by-service table is dense at its
// widest setting (the 24-months column option) instead of pocked with holes where a service's sample was short.
const DENSE_MONTHS = 24

export type CurrentData = {
  datasets: StoredDataset[]
  summaries: StoredSummary[]
  manifest: PresentationManifest
}

export const synthesizeCapability = (
  snapshot: CapabilityResult,
  currency: CurrencyCode,
  opts: EvolveOptions,
  baseSeed: string
): { ledger: Ledger; current: CurrentData; lastRunAt: string } | null => {
  const resolved = resolveCurrencies(snapshot, currency)
  const errors = validateCapabilityResult(resolved)

  if (errors.length > 0) {
    throw new Error(`sample is contract-invalid: ${errors.join('; ')}`)
  }

  const { datasets, summaries, manifest } = splitResult(resolved)
  const dense = datasets.map((d) => backfillMonthlySeries(d, baseSeed, DENSE_MONTHS))
  const observations = evolveObservations({ datasets: dense, summaries }, opts, baseSeed)

  // A window entirely covered by a contributor's gaps yields no observations — nothing to persist.
  if (observations.length === 0) {
    return null
  }

  let ledger: Ledger | undefined

  for (const obs of observations) {
    ledger = appendObservation(ledger, obs)
  }

  const latest = observations.at(-1)!
  const proj = ledger ? projectCurrent(ledger) : new Map<string, { id: string; rows: Record<string, unknown>[] }>()
  // Keyed datasets render from the accumulated ledger; unkeyed datasets keep the latest day's rows verbatim.
  const projected = latest.datasets.map((d) => {
    const p = proj.get(d.id)

    return p ? { ...d, rows: p.rows } : d
  })

  // The last step runCapability takes before caching: fill the spend chart's missing months from the accrual
  // readings the ledger just recorded, so a service whose own payload carries no per-month amounts still charts.
  const backfilled = backfillAccrualBars(projected, latest.summaries, manifest, ledger ?? null)

  return {
    ledger: ledger!,
    current: { datasets: backfilled, summaries: latest.summaries, manifest },
    lastRunAt: latest.capturedAt
  }
}

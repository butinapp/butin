import { type Section, type Summary } from '@butinapp/sdk/data'
import type { MtdBasis } from '@butinapp/sdk/presets'
import { convert, round2, type FxRates } from '@butinapp/sdk/util'

export type RollupTile = {
  pluginId: string
  pluginName: string
  color?: string
  state?: 'connected' | 'disconnected'
  // Primary summary — the tile's displayed headline (the highest-priority section).
  summary?: Summary
  // All summaries this tile reports, deduped by section. The rollup reads the spend one off here.
  summaries?: Summary[]
}

export type CurrencySubtotal = {
  currency: string
  value: number
  contributors: number
}

export type RollupBand = {
  section: Section
  label: string
  role: 'money' | 'count'
  currency: string
  value: number
  contributors: number
  breakdown: CurrencySubtotal[]
  unconverted: number
  // The set of mtd bases the contributors declared — surfaced so a spend band built from mixed bases (an
  // accrued usage total + a flat fee + a last invoice) can be flagged rather than presented as one clean sum.
  bases?: Set<MtdBasis>
}

export type CurrencyRollup = {
  bands: RollupBand[]
}

// Combine the spend summaries across services into one band; balance + other never sum (they're per-service).
// Money is converted to baseCurrency (a currency with no rate stays out of the total and is counted in
// `unconverted`, never silently summed); the exact per-currency subtotals ride along in `breakdown`.
export const rollup = (tiles: RollupTile[], baseCurrency: string, rates: FxRates): CurrencyRollup => {
  const band: RollupBand = {
    section: 'spend',
    label: 'Spend this month',
    role: 'money',
    currency: baseCurrency,
    value: 0,
    contributors: 0,
    breakdown: [],
    unconverted: 0
  }

  for (const tile of tiles) {
    const spend = (tile.summaries ?? []).find((s) => s.section === 'spend')

    if (!spend || spend.role !== 'money') {
      continue
    }

    band.contributors += 1

    if (spend.basis) {
      ;(band.bases ??= new Set()).add(spend.basis)
    }

    const ccy = spend.currency ?? baseCurrency
    const sub = band.breakdown.find((b) => b.currency === ccy)

    if (sub) {
      sub.value = round2(sub.value + spend.value)
      sub.contributors += 1
    } else {
      band.breakdown.push({ currency: ccy, value: round2(spend.value), contributors: 1 })
    }

    const converted = convert(spend.value, ccy, baseCurrency, rates)

    if (converted === null) {
      band.unconverted += 1
    } else {
      band.value = round2(band.value + converted)
    }
  }

  return { bands: band.contributors > 0 ? [band] : [] }
}

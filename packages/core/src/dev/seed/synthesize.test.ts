import { billing } from '@butinapp/sdk/presets'
import { describe, expect, it } from 'vitest'

import { synthesizeCapability } from './synthesize.js'

const OPTS = { now: '2026-06-17T12:00:00.000Z', days: 8, window: 90 }

const snapshot = () =>
  billing.summary({
    currentMtd: 120,
    mtdBasis: 'invoiced',
    currency: 'USD',
    invoices: [
      { id: 'i1', date: '2026-06-08', amount: 120, status: 'paid' },
      { id: 'i2', date: '2026-05-08', amount: 100, status: 'paid' }
    ]
  })

describe('synthesizeCapability', () => {
  it('builds a ledger + current cache from a snapshot', () => {
    const { ledger, current, lastRunAt } = synthesizeCapability(snapshot(), 'USD', OPTS, 'serper:summary')!

    expect(lastRunAt).toBe(OPTS.now)
    expect(ledger.series.find((s) => s.section === 'spend')!.points.length).toBeGreaterThan(0)
    expect(current.manifest.views.length).toBeGreaterThan(0)
    // The latest current keeps the snapshot's headline value.
    expect(current.summaries.find((s) => s.section === 'spend')!.value).toBe(120)
  })

  it('pads the monthly spend series to a dense ~2-year window so the by-service table has no holes', () => {
    const { current } = synthesizeCapability(snapshot(), 'USD', OPTS, 'serper:summary')!
    const monthly = current.datasets.find((d) => d.id === 'monthly')!
    const months = [...new Set(monthly.rows.map((r) => String(r.month)))]

    // The sample carried only 2 months; the seed backfills older months so cross-service columns stay dense.
    expect(months.length).toBe(24)
    expect(months).toContain('2026-06') // the newest (current) month is preserved verbatim
    expect(monthly.rows.find((r) => r.month === '2026-06')!.amount).toBe(120)

    for (const r of monthly.rows) {
      expect(Number(r.amount)).toBeGreaterThanOrEqual(0) // every padded month is a real value, never a hole
    }
  })

  it('is deterministic', () => {
    const a = synthesizeCapability(snapshot(), 'USD', OPTS, 's')
    const b = synthesizeCapability(snapshot(), 'USD', OPTS, 's')

    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('returns null when the whole window is gapped (no observations to persist)', () => {
    const result = synthesizeCapability(snapshot(), 'USD', { ...OPTS, skipDay: () => true }, 's')

    expect(result).toBeNull()
  })

  it('throws on a contract-invalid snapshot', () => {
    // Duplicate dataset id — irreducibly invalid (resolveCurrencies can't fix it, unlike a missing money currency).
    const bad = {
      datasets: [
        { id: 'x', shape: 'record', fields: [{ key: 'a', role: 'count' }], value: { a: 1 } },
        { id: 'x', shape: 'record', fields: [{ key: 'a', role: 'count' }], value: { a: 1 } }
      ]
    } as never

    expect(() => synthesizeCapability(bad, 'USD', OPTS, 's')).toThrow()
  })
})

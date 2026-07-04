import type { StoredDataset, StoredSummary } from '@butinapp/shapes'
import { describe, expect, it } from 'vitest'

import { appendObservation } from '../../main/store/ledger.js'

import { backfillMonthlySeries, evolveObservations } from './evolver.js'

const OPTS = { now: '2026-06-17T12:00:00.000Z', days: 10, window: 90 }

const monthly: StoredDataset = {
  id: 'monthly',
  shape: 'table',
  key: 'month',
  columns: [
    { key: 'month', role: 'timestamp' },
    { key: 'amount', role: 'money', currency: 'USD' }
  ],
  rows: [{ month: '2026-06', amount: 120 }]
}

const invoices: StoredDataset = {
  id: 'invoices',
  shape: 'table',
  key: 'id',
  columns: [
    { key: 'id', role: 'identifier' },
    { key: 'date', role: 'timestamp' },
    { key: 'amount', role: 'money', currency: 'USD' },
    { key: 'status', role: 'status' }
  ],
  rows: [
    { id: 'i1', date: '2026-06-10', amount: 50, status: 'paid' },
    { id: 'i2', date: '2026-04-10', amount: 70, status: 'paid' }
  ]
}

const summaries: StoredSummary[] = [{ section: 'spend', value: 120, role: 'money', currency: 'USD' }]

describe('evolveObservations', () => {
  it('emits one observation per day, oldest→newest, newest === base', () => {
    const obs = evolveObservations({ datasets: [monthly, invoices], summaries }, OPTS, 'serper:summary')

    expect(obs).toHaveLength(10)
    expect(obs.map((o) => o.capturedAt)).toEqual([...obs.map((o) => o.capturedAt)].sort())
    expect(obs.at(-1)!.capturedAt).toBe(OPTS.now)
    const last = obs.at(-1)!

    expect(last.summaries.find((s) => s.section === 'spend')!.value).toBe(120)
  })

  it('is deterministic for the same seed', () => {
    const a = evolveObservations({ datasets: [monthly, invoices], summaries }, OPTS, 'serper:summary')
    const b = evolveObservations({ datasets: [monthly, invoices], summaries }, OPTS, 'serper:summary')

    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('reveals an inventory row only on/after its date column', () => {
    // i2 is dated 2026-04-10, well before the 10-day capture window starting 2026-06-08 → present every day.
    // A future-dated row must not appear before its date.
    const future: StoredDataset = {
      ...invoices,
      rows: [{ id: 'iF', date: '2026-06-16', amount: 10, status: 'paid' }]
    }
    const obs = evolveObservations({ datasets: [future], summaries: [] }, OPTS, 's')
    const day0 = obs[0]!.datasets.find((d) => d.id === 'invoices')!

    expect(day0.rows).toHaveLength(0) // 2026-06-08: before iF's date
    expect(obs.at(-1)!.datasets.find((d) => d.id === 'invoices')!.rows).toHaveLength(1)
  })

  it('keeps money ≥ 0 and counts integral across the walk', () => {
    const counts: StoredDataset = {
      id: 'monthly',
      shape: 'table',
      key: 'month',
      columns: [
        { key: 'month', role: 'timestamp' },
        { key: 'n', role: 'count' }
      ],
      rows: [{ month: '2026-06', n: 5 }]
    }
    const obs = evolveObservations({ datasets: [counts], summaries }, OPTS, 's')

    for (const o of obs) {
      for (const r of o.datasets[0]!.rows) {
        expect(Number(r.n)).toBeGreaterThanOrEqual(0)
        expect(Number.isInteger(Number(r.n))).toBe(true)
      }

      const v = o.summaries.find((s) => s.section === 'spend')

      if (v) {
        expect(v.value).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('a monthly-cumulative column ramps within a month and resets at the boundary (no negative day-diffs)', () => {
    const members: StoredDataset = {
      id: 'members',
      shape: 'table',
      key: 'email',
      columns: [
        { key: 'email', role: 'label' },
        { key: 'spend', role: 'money', currency: 'USD', accrual: 'cumulative', resetPeriod: 'monthly' }
      ],
      rows: [{ email: 'a@x.test', spend: 200 }]
    }
    // 40 days ending 2026-06-17 → the window crosses the May→June boundary.
    const obs = evolveObservations(
      { datasets: [members], summaries: [] },
      { now: '2026-06-17T12:00:00.000Z', days: 40, window: 90 },
      's'
    )
    const readings = obs.map((o) => ({
      day: o.capturedAt.slice(0, 10),
      spend: Number(o.datasets[0]!.rows[0]!.spend)
    }))

    expect(readings.at(-1)!.spend).toBe(200) // newest day == sample value

    const june = readings.filter((r) => r.day.startsWith('2026-06'))

    for (let i = 1; i < june.length; i++) {
      expect(june[i]!.spend).toBeGreaterThanOrEqual(june[i - 1]!.spend) // non-decreasing within the month
    }

    const jun1 = readings.find((r) => r.day === '2026-06-01')!.spend
    const may31 = readings.find((r) => r.day === '2026-05-31')!.spend

    expect(jun1).toBeLessThan(may31) // resets at the month boundary
  })

  it('skipDay omits exactly the gapped observations, leaving the survivors unchanged', () => {
    const full = evolveObservations({ datasets: [monthly, invoices], summaries }, OPTS, 'serper:summary')
    // The 10-day window is 2026-06-08…06-17; gap out 06-10 and 06-11.
    const gapped = new Set(['2026-06-10', '2026-06-11'])
    const skipped = evolveObservations(
      { datasets: [monthly, invoices], summaries },
      { ...OPTS, skipDay: (d) => gapped.has(d) },
      'serper:summary'
    )

    expect(skipped).toHaveLength(8)
    expect(skipped.some((o) => gapped.has(o.capturedAt.slice(0, 10)))).toBe(false)
    // A surviving day is byte-identical to the no-skip run (skipping a day changes no other day's readings).
    const survivors = full.filter((o) => !gapped.has(o.capturedAt.slice(0, 10)))

    expect(JSON.stringify(skipped)).toBe(JSON.stringify(survivors))
  })

  it('skipDay over the whole window yields no observations', () => {
    const obs = evolveObservations({ datasets: [monthly], summaries }, { ...OPTS, skipDay: () => true }, 's')

    expect(obs).toEqual([])
  })

  it('produces a ledger whose spend series spans the capture days', () => {
    const obs = evolveObservations({ datasets: [monthly], summaries }, OPTS, 's')
    const ledger = obs.reduce<ReturnType<typeof appendObservation> | undefined>(
      (acc, o) => appendObservation(acc, o),
      undefined
    )!

    expect(ledger.series.find((s) => s.section === 'spend')!.points).toHaveLength(10)
  })
})

describe('backfillMonthlySeries', () => {
  it('extends a monthly money series backward to the target month count, newest untouched', () => {
    const out = backfillMonthlySeries(monthly, 's', 6)
    const months = out.rows.map((r) => String(r.month))

    expect(out.rows).toHaveLength(6)
    expect(months).toEqual([...months].sort()) // ascending
    expect(months[0]).toBe('2026-01') // 6 months back from June (inclusive)
    expect(out.rows.at(-1)).toEqual({ month: '2026-06', amount: 120 }) // newest row verbatim

    for (const r of out.rows) {
      expect(Number(r.amount)).toBeGreaterThanOrEqual(0)
    }
  })

  it('leaves a series already at/over the target unchanged (same reference)', () => {
    expect(backfillMonthlySeries(monthly, 's', 1)).toBe(monthly)
  })

  it('ignores a day-keyed (non-monthly) series', () => {
    const daily: StoredDataset = { ...monthly, rows: [{ month: '2026-06-10', amount: 1 }] }

    expect(backfillMonthlySeries(daily, 's', 6)).toBe(daily)
  })

  it('clones every category of a stacked monthly series per backfilled month', () => {
    const stacked: StoredDataset = {
      id: 'monthly',
      shape: 'table',
      key: 'month',
      columns: [
        { key: 'month', role: 'timestamp' },
        { key: 'category', role: 'label' },
        { key: 'amount', role: 'money', currency: 'USD' }
      ],
      rows: [
        { month: '2026-06', category: 'Seats', amount: 100 },
        { month: '2026-06', category: 'Usage', amount: 50 }
      ]
    }
    const out = backfillMonthlySeries(stacked, 's', 3)

    expect(out.rows).toHaveLength(6) // 3 months × 2 categories
    expect(new Set(out.rows.filter((r) => r.month === '2026-04').map((r) => r.category))).toEqual(
      new Set(['Seats', 'Usage'])
    )
  })
})

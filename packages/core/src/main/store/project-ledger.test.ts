import type { DatasetLog, Ledger, PresentationManifest, StoredDataset, StoredSummary } from '@butinapp/shapes'
import { expect, test } from 'vitest'

import {
  backfillAccrualBars,
  dailySpend,
  dailyByColumn,
  primarySeries,
  projectCurrent,
  projectUnion,
  seriesPoints
} from './project-ledger.js'

const led: Ledger = {
  schemaVersion: 1,
  datasets: [
    {
      id: 'invoices',
      key: 'id',
      columns: [
        { key: 'id', role: 'identifier' },
        { key: 'status', role: 'status' }
      ],
      rows: [
        {
          id: 'a',
          firstSeen: 'T1',
          seenTo: 'T3',
          versions: [
            { from: 'T1', to: 'T2', data: { id: 'a', status: 'open' } },
            { from: 'T2', data: { id: 'a', status: 'paid' } }
          ]
        },
        { id: 'b', firstSeen: 'T1', seenTo: 'T1', versions: [{ from: 'T1', data: { id: 'b', status: 'open' } }] }
      ]
    }
  ],
  series: []
}

test('projectCurrent returns newest version per row', () => {
  const ds = projectCurrent(led).get('invoices')!

  expect(ds.rows.find((r) => r.id === 'a')!.status).toBe('paid')
  expect(ds.rows).toHaveLength(2)
})

test('projectUnion stamps presence newest-first and flags gone rows', () => {
  const ds = projectUnion(led, 'T3').get('invoices')!

  expect(ds.rows[0]!.id).toBe('a') // seenTo T3 sorts before b's T1
  const a = ds.rows.find((r) => r.id === 'a')!
  const b = ds.rows.find((r) => r.id === 'b')!

  expect(a.__lastSeen).toBe('T3')
  expect(a.__gone).toBeUndefined()
  expect(b.__gone).toBe('T1') // seenTo < latestFetch
})

test('seriesPoints maps a section series to DailySource points', () => {
  const l: Ledger = {
    schemaVersion: 1,
    datasets: [],
    series: [
      {
        section: 'spend',
        points: [
          { capturedAt: '2026-06-15T12:00:00Z', value: 10 },
          { capturedAt: '2026-06-16T12:00:00Z', value: 25 }
        ]
      }
    ]
  }

  expect(seriesPoints(l, 'spend')).toEqual([
    { date: '2026-06-15', capturedAt: '2026-06-15T12:00:00Z', section: 'spend', value: 10 },
    { date: '2026-06-16', capturedAt: '2026-06-16T12:00:00Z', section: 'spend', value: 25 }
  ])
  expect(seriesPoints(l, 'balance')).toEqual([])
})

test('dailySpend derives per-day spend from the ledger spend section', () => {
  const l: Ledger = {
    schemaVersion: 1,
    datasets: [],
    series: [
      {
        section: 'spend',
        points: [
          { capturedAt: '2026-06-15T12:00:00Z', value: 10 },
          { capturedAt: '2026-06-16T12:00:00Z', value: 25 }
        ]
      }
    ]
  }

  // MTD on 06-16 minus 06-15 = 15 for that day; the lone first point can't be diffed (not first-of-month).
  expect(dailySpend(l)).toEqual([{ date: '2026-06-16', value: 15 }])
})

test('dailySpend returns [] when the ledger holds no spend series', () => {
  const l: Ledger = {
    schemaVersion: 1,
    datasets: [],
    series: [{ section: 'other', points: [{ capturedAt: '2026-06-15T12:00:00Z', value: 10 }] }]
  }

  expect(dailySpend(l)).toEqual([])
})

test('primarySeries prefers the spend section and returns its values oldest→newest', () => {
  const l: Ledger = {
    schemaVersion: 1,
    datasets: [],
    series: [
      { section: 'other', points: [{ capturedAt: '2026-06-15T12:00:00Z', value: 99 }] },
      {
        section: 'spend',
        points: [
          { capturedAt: '2026-06-15T12:00:00Z', value: 10 },
          { capturedAt: '2026-06-16T12:00:00Z', value: 25 }
        ]
      }
    ]
  }

  expect(primarySeries(l)).toEqual([10, 25])
})

test('primarySeries falls back to the first series and is [] when none', () => {
  expect(
    primarySeries({
      schemaVersion: 1,
      datasets: [],
      series: [{ section: 'other', points: [{ capturedAt: 'T1', value: 7 }] }]
    })
  ).toEqual([7])
  expect(primarySeries({ schemaVersion: 1, datasets: [], series: [] })).toEqual([])
})

// A spend chart (settled-invoice bars) + a spend summary whose spark binds it, and a ledger whose open-period
// spend series grew through June to $720, then reset for July — where a boundary reading captured the prior
// period's $999 total before the real July accrual ($5) was observed. June + July have no invoice bar yet
// (arrears lag). The July $999 spike is exactly the case max() gets wrong: the latest reading ($5) is July's.
const monthly = (rows: { month: string; amount: number }[]): StoredDataset => ({
  id: 'monthly',
  shape: 'table',
  key: 'month',
  columns: [
    { key: 'month', role: 'timestamp' },
    { key: 'amount', role: 'money', currency: 'USD' }
  ],
  rows
})
const spendSummary: StoredSummary = { section: 'spend', value: 5, role: 'money', currency: 'USD', basis: 'accrued' }
const sparkManifest: PresentationManifest = {
  views: [],
  summaries: { spend: { label: 'This month', spark: { dataset: 'monthly', x: 'month', y: 'amount' } } }
}
const accrualLedger: Ledger = {
  schemaVersion: 1,
  datasets: [],
  series: [
    {
      section: 'spend',
      points: [
        { capturedAt: '2026-06-20T12:00:00Z', value: 610 },
        { capturedAt: '2026-06-30T22:00:00Z', value: 720 },
        { capturedAt: '2026-07-01T00:10:00Z', value: 999 }, // prior-period boundary spike — must be ignored
        { capturedAt: '2026-07-01T04:00:00Z', value: 5 }
      ]
    }
  ]
}

test('backfillAccrualBars fills months missing from the invoice chart with each month latest reading', () => {
  const ds = monthly([{ month: '2026-05', amount: 900 }])
  const [out] = backfillAccrualBars([ds], [spendSummary], sparkManifest, accrualLedger)

  // May (invoiced) untouched; June filled with its latest reading (720); July with the post-reset $5 — NOT the
  // $999 boundary spike a max() would have picked.
  expect(out!.rows).toEqual([
    { month: '2026-05', amount: 900 },
    { month: '2026-06', amount: 720 },
    { month: '2026-07', amount: 5 }
  ])
})

test('backfillAccrualBars never overwrites a month the invoice history already carries', () => {
  const ds = monthly([{ month: '2026-06', amount: 715 }]) // settled June invoice already posted
  const [out] = backfillAccrualBars([ds], [spendSummary], sparkManifest, accrualLedger)

  expect(out!.rows).toEqual([
    { month: '2026-06', amount: 715 },
    { month: '2026-07', amount: 5 }
  ])
})

test('backfillAccrualBars is a no-op without a spend summary, a spark, or a spend series', () => {
  const ds = monthly([{ month: '2026-05', amount: 900 }])

  expect(backfillAccrualBars([ds], [], sparkManifest, accrualLedger)).toEqual([ds])
  expect(backfillAccrualBars([ds], [spendSummary], { views: [] }, accrualLedger)).toEqual([ds])
  expect(backfillAccrualBars([ds], [spendSummary], sparkManifest, null)).toEqual([ds])
  expect(
    backfillAccrualBars([ds], [spendSummary], sparkManifest, { schemaVersion: 1, datasets: [], series: [] })
  ).toEqual([ds])
})

test('backfillAccrualBars only fills from an accrual basis — a settled invoiced/lastInvoice figure never seeds a bar', () => {
  const ds = monthly([{ month: '2026-05', amount: 900 }])

  // The captured series here is a past invoice / outstanding balance, not this month's accrual — filling the
  // in-progress month with it would repeat a prior bill as a phantom bar.
  for (const basis of ['invoiced', 'lastInvoice'] as const) {
    expect(backfillAccrualBars([ds], [{ ...spendSummary, basis }], sparkManifest, accrualLedger)).toEqual([ds])
  }

  // An absent basis defaults to settled ('invoiced' in the preset), so it is likewise not projected.
  expect(backfillAccrualBars([ds], [{ ...spendSummary, basis: undefined }], sparkManifest, accrualLedger)).toEqual([ds])
})

test('dailyByColumn differences a cumulative column per row from its versions', () => {
  const log: DatasetLog = {
    id: 'm',
    key: 'id',
    columns: [{ key: 'cost', role: 'money', accrual: 'cumulative' }],
    rows: [
      {
        id: 'alice',
        firstSeen: 'T1',
        seenTo: 'T2',
        versions: [
          { from: '2026-06-14T23:00:00Z', to: '2026-06-15T23:00:00Z', data: { id: 'alice', cost: 10 } },
          { from: '2026-06-15T23:00:00Z', data: { id: 'alice', cost: 25 } }
        ]
      }
    ]
  }

  expect(dailyByColumn(log, 'cost', 'monthly')).toEqual({ alice: [{ date: '2026-06-15', value: 15 }] })
})

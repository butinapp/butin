import type { DatasetLog, Ledger } from '@butinapp/shapes'
import { expect, test } from 'vitest'

import {
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

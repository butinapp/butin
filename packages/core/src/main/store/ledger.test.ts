import type { Ledger, StoredDataset, StoredSummary } from '@butinapp/shapes'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'

import { accumulate, appendObservation, readLedger } from './ledger.js'
import { setDataRoot } from './store.js'

const ds = (rows: Record<string, unknown>[], key: string | string[] = 'id'): StoredDataset => ({
  id: 'invoices',
  shape: 'table',
  key,
  columns: [
    { key: 'id', role: 'identifier' },
    { key: 'status', role: 'status' }
  ],
  rows
})
const obs = (datasets: StoredDataset[], summaries: StoredSummary[], at: string) => ({
  capturedAt: at,
  datasets,
  summaries
})

test('new key appends one open version with firstSeen=seenTo=now', () => {
  const led = appendObservation(undefined, obs([ds([{ id: 'a', status: 'open' }])], [], '2026-06-15T00:00:00Z'))
  const row = led.datasets[0]!.rows[0]!

  expect(row).toMatchObject({ id: 'a', firstSeen: '2026-06-15T00:00:00Z', seenTo: '2026-06-15T00:00:00Z' })
  expect(row.versions).toEqual([{ from: '2026-06-15T00:00:00Z', data: { id: 'a', status: 'open' } }])
})

test('unchanged data only advances seenTo (no new version)', () => {
  const a = appendObservation(undefined, obs([ds([{ id: 'a', status: 'open' }])], [], '2026-06-15T00:00:00Z'))
  const b = appendObservation(a, obs([ds([{ id: 'a', status: 'open' }])], [], '2026-06-16T00:00:00Z'))
  const row = b.datasets[0]!.rows[0]!

  expect(row.seenTo).toBe('2026-06-16T00:00:00Z')
  expect(row.versions).toHaveLength(1)
})

test('changed data closes the prior version and appends a new one', () => {
  const a = appendObservation(undefined, obs([ds([{ id: 'a', status: 'open' }])], [], '2026-06-15T00:00:00Z'))
  const b = appendObservation(a, obs([ds([{ id: 'a', status: 'paid' }])], [], '2026-06-16T00:00:00Z'))

  expect(b.datasets[0]!.rows[0]!.versions).toEqual([
    { from: '2026-06-15T00:00:00Z', to: '2026-06-16T00:00:00Z', data: { id: 'a', status: 'open' } },
    { from: '2026-06-16T00:00:00Z', data: { id: 'a', status: 'paid' } }
  ])
})

test('appendObservation does not mutate the existing ledger', () => {
  const a = appendObservation(undefined, obs([ds([{ id: 'a', status: 'open' }])], [], '2026-06-15T00:00:00Z'))

  appendObservation(a, obs([ds([{ id: 'a', status: 'paid' }])], [], '2026-06-16T00:00:00Z'))
  expect(a.datasets[0]!.rows[0]!.versions).toHaveLength(1)
  expect(a.datasets[0]!.rows[0]!.seenTo).toBe('2026-06-15T00:00:00Z')
})

test('a key absent from the fetch is kept untouched', () => {
  const a = appendObservation(undefined, obs([ds([{ id: 'a', status: 'open' }])], [], '2026-06-15T00:00:00Z'))
  const b = appendObservation(a, obs([ds([{ id: 'b', status: 'open' }])], [], '2026-06-16T00:00:00Z'))

  expect(b.datasets[0]!.rows.map((r) => r.id).sort()).toEqual(['a', 'b'])
  expect(b.datasets[0]!.rows.find((r) => r.id === 'a')!.seenTo).toBe('2026-06-15T00:00:00Z')
})

test('composite key joins parts', () => {
  const led = appendObservation(
    undefined,
    obs([ds([{ id: 'a', status: 'x' }], ['id', 'status'])], [], '2026-06-15T00:00:00Z')
  )

  expect(led.datasets[0]!.rows[0]!.id).toBe('ax')
})

test('a row missing its key value is skipped (not persisted)', () => {
  const led = appendObservation(
    undefined,
    obs([ds([{ id: null, status: 'y' }], ['id', 'status'])], [], '2026-06-15T00:00:00Z')
  )

  expect(led.datasets[0]!.rows).toEqual([])
})

test('summaries record one point per day', () => {
  const s: StoredSummary = { section: 'spend', value: 12.3, role: 'money', currency: 'USD' }
  const a = appendObservation(undefined, obs([], [s], '2026-06-15T00:00:00Z'))
  const b = appendObservation(a, obs([], [{ ...s, value: 20 }], '2026-06-16T00:00:00Z'))

  expect(b.series).toEqual([
    {
      section: 'spend',
      points: [
        { capturedAt: '2026-06-15T00:00:00Z', value: 12.3, currency: 'USD' },
        { capturedAt: '2026-06-16T00:00:00Z', value: 20, currency: 'USD' }
      ]
    }
  ])
})

test('a same-day re-observation replaces the day point with the latest reading (no extra bar)', () => {
  const s: StoredSummary = { section: 'spend', value: 10, role: 'money', currency: 'USD' }
  const a = appendObservation(undefined, obs([], [s], '2026-06-15T01:00:00Z'))
  const b = appendObservation(a, obs([], [{ ...s, value: 10 }], '2026-06-15T05:00:00Z'))
  const c = appendObservation(b, obs([], [{ ...s, value: 12 }], '2026-06-15T23:00:00Z'))

  expect(c.series[0]!.points).toEqual([{ capturedAt: '2026-06-15T23:00:00Z', value: 12, currency: 'USD' }])
})

test('pre-existing same-day duplicate points fold to one (latest of the day) on the next write', () => {
  const dirty: Ledger = {
    schemaVersion: 1,
    datasets: [],
    series: [
      {
        section: 'spend',
        points: [
          { capturedAt: '2026-06-15T01:00:00Z', value: 5, currency: 'USD' },
          { capturedAt: '2026-06-15T02:00:00Z', value: 5, currency: 'USD' },
          { capturedAt: '2026-06-15T03:00:00Z', value: 5, currency: 'USD' }
        ]
      }
    ]
  }
  const next = appendObservation(
    dirty,
    obs([], [{ section: 'spend', value: 7, role: 'money', currency: 'USD' }], '2026-06-16T00:00:00Z')
  )

  expect(next.series[0]!.points).toEqual([
    { capturedAt: '2026-06-15T03:00:00Z', value: 5, currency: 'USD' },
    { capturedAt: '2026-06-16T00:00:00Z', value: 7, currency: 'USD' }
  ])
})

let tempDir: string

test('accumulate persists and re-merges across calls', async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'butin-led-'))
  setDataRoot(tempDir)
  await accumulate('p', 'billing', {
    capturedAt: '2026-06-15T00:00:00Z',
    datasets: [ds([{ id: 'a', status: 'open' }])],
    summaries: []
  })
  await accumulate('p', 'billing', {
    capturedAt: '2026-06-16T00:00:00Z',
    datasets: [ds([{ id: 'b', status: 'open' }])],
    summaries: []
  })

  const led = await readLedger('p', 'billing')

  expect(led!.datasets[0]!.rows.map((r) => r.id).sort()).toEqual(['a', 'b'])
})

afterAll(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

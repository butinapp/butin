import type { Ledger, StoredDataset, StoredSummary } from '@butinapp/shapes'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'

import { isSealed, setScryptParamsForTest, setupVault } from '../vault/vault.js'

import { accumulate, appendObservation, readLedger } from './ledger.js'
import { ledgerPath, setDataRoot } from './store.js'

setScryptParamsForTest({ N: 2 ** 8, r: 8, p: 1 })

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

// A monthly rollup dataset keyed by 'month' (a sortable bucket), with the re-derived-rollup flag.
const monthlyDs = (rows: Record<string, unknown>[], rollup = true): StoredDataset => ({
  id: 'monthly',
  shape: 'table',
  key: 'month',
  rollup,
  columns: [
    { key: 'month', role: 'timestamp' },
    { key: 'amount', role: 'money' }
  ],
  rows
})

test('rollup heals a re-dated bucket: an above-range orphan is dropped, deep history below the range persists', () => {
  // Fetch 1 mis-dates the arrears bill into 2026-07; 2026-01 is deep history, 2026-05 a recent month.
  const a = appendObservation(
    undefined,
    obs(
      [
        monthlyDs([
          { month: '2026-01', amount: 10 },
          { month: '2026-05', amount: 50 },
          { month: '2026-07', amount: 70 }
        ])
      ],
      [],
      '2026-07-01T00:00:00Z'
    )
  )
  // Fetch 2 (fixed dating) re-emits the recent window [2026-05, 2026-06]; the stale 2026-07 is gone.
  const b = appendObservation(
    a,
    obs(
      [
        monthlyDs([
          { month: '2026-05', amount: 55 },
          { month: '2026-06', amount: 60 }
        ])
      ],
      [],
      '2026-07-02T00:00:00Z'
    )
  )
  const rows = b.datasets[0]!.rows

  // 2026-07 (>= the fetch's floor 2026-05, not re-emitted) is dropped; 2026-01 (< floor) persists.
  expect(rows.map((r) => r.id).sort()).toEqual(['2026-01', '2026-05', '2026-06'])
  // 2026-05's value was corrected in place (a new version).
  expect(rows.find((r) => r.id === '2026-05')!.versions.at(-1)!.data.amount).toBe(55)
})

test('without rollup a keyed table is an append log — the stale bucket is retained', () => {
  const a = appendObservation(
    undefined,
    obs(
      [
        monthlyDs(
          [
            { month: '2026-05', amount: 50 },
            { month: '2026-07', amount: 70 }
          ],
          false
        )
      ],
      [],
      '2026-07-01T00:00:00Z'
    )
  )
  const b = appendObservation(
    a,
    obs([monthlyDs([{ month: '2026-06', amount: 60 }], false)], [], '2026-07-02T00:00:00Z')
  )

  expect(b.datasets[0]!.rows.map((r) => r.id).sort()).toEqual(['2026-05', '2026-06', '2026-07'])
})

test('a rollup fetch with no rows retains everything (a transient empty fetch never wipes the series)', () => {
  const a = appendObservation(
    undefined,
    obs(
      [
        monthlyDs([
          { month: '2026-05', amount: 50 },
          { month: '2026-06', amount: 60 }
        ])
      ],
      [],
      '2026-07-01T00:00:00Z'
    )
  )
  const b = appendObservation(a, obs([monthlyDs([])], [], '2026-07-02T00:00:00Z'))

  expect(b.datasets[0]!.rows.map((r) => r.id).sort()).toEqual(['2026-05', '2026-06'])
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
let vaultDir: string

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

// The ledger is profile data, so it goes through secure-fs like every other store: on an encrypted profile it
// must round-trip sealed. Reading it as plaintext would return null and the next accumulate would overwrite the
// whole accumulated history with a fresh one — in the clear.
test('an encrypted profile keeps accumulating, sealed on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'butin-ledger-vault-'))

  vaultDir = dir
  setDataRoot(dir)
  setupVault(dir, 'correct horse battery staple')

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

  expect(isSealed(readFileSync(ledgerPath('p', 'billing')))).toBe(true)
  expect((await readLedger('p', 'billing'))!.datasets[0]!.rows.map((r) => r.id).sort()).toEqual(['a', 'b'])
})

afterAll(() => {
  for (const dir of [tempDir, vaultDir]) {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

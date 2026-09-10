import type { Ledger, StoredDataset } from '@butinapp/shapes'
import { expect, test } from 'vitest'

import { repairRows, stampRetention } from './repair-snapshots.js'

// A roster ledger written before retention was recorded: bob was last seen months before the latest fetch.
const legacyLedger = (): Ledger => ({
  schemaVersion: 1,
  datasets: [
    {
      id: 'members',
      key: 'id',
      columns: [
        { key: 'id', role: 'identifier' },
        { key: 'role', role: 'category' }
      ],
      rows: [
        {
          id: 'alice',
          firstSeen: '2026-07-01T00:00:00Z',
          seenTo: '2026-09-09T00:00:00Z',
          versions: [{ from: '2026-07-01T00:00:00Z', data: { id: 'alice', role: 'admin' } }]
        },
        {
          id: 'bob',
          firstSeen: '2026-07-01T00:00:00Z',
          seenTo: '2026-07-01T00:00:00Z',
          versions: [{ from: '2026-07-01T00:00:00Z', data: { id: 'bob', role: 'admin' } }]
        }
      ]
    }
  ],
  series: []
})

const membersDs = (rows: Record<string, unknown>[]): StoredDataset => ({
  id: 'members',
  shape: 'table',
  key: 'id',
  columns: [
    { key: 'id', role: 'identifier' },
    { key: 'role', role: 'category' }
  ],
  rows
})

test('stamps the snapshot mode onto a log written before retention was recorded', () => {
  const out = stampRetention(legacyLedger(), new Set(['members']))

  expect(out!.datasets[0]!.retention).toBe('snapshot')
})

test('leaves a ledger alone when its logs already declare their mode', () => {
  const led = stampRetention(legacyLedger(), new Set(['members']))!

  expect(stampRetention(led, new Set(['members']))).toBeNull()
})

test('drops a departed row from the cached rows a stale current still holds', () => {
  const data = {
    datasets: [
      membersDs([
        { id: 'alice', role: 'admin' },
        { id: 'bob', role: 'admin' }
      ])
    ],
    summaries: [],
    manifest: { views: [] }
  }
  const out = repairRows(data, stampRetention(legacyLedger(), new Set(['members']))!, new Set(['members']))

  expect(out!.datasets[0]!.rows).toEqual([{ id: 'alice', role: 'admin' }])
})

test('reports nothing to repair when the cache already matches the roster', () => {
  const data = { datasets: [membersDs([{ id: 'alice', role: 'admin' }])], summaries: [], manifest: { views: [] } }

  expect(repairRows(data, stampRetention(legacyLedger(), new Set(['members']))!, new Set(['members']))).toBeNull()
})

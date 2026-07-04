import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// A fake plugin with a node transport whose collect ignores the client (no network), so we can test
// runCapability's orchestration in isolation. Hoisted so the vi.mock factory can reference it.
const { fakePlugin } = vi.hoisted(() => ({
  fakePlugin: {
    meta: { id: 'fake', name: 'Fake' },
    reportingCurrency: 'USD',
    session: { loginUrl: 'https://x', dashboardMarkers: ['/'], cookieDomains: ['x'] },
    auth: { kind: 'cookie' },
    transport: { engine: 'node' },
    // A combobox field whose loadOptions ignores the client (no network) so we can test listConfigOptions.
    config: {
      fields: [
        { key: 'orgId', label: 'Org', kind: 'combobox', loadOptions: async () => [{ value: 'o1', label: 'Org One' }] },
        { key: 'note', label: 'Note', kind: 'text' }
      ]
    },
    capabilities: [
      {
        id: 'billing',
        label: 'Billing',
        collect: async () => ({
          datasets: [
            { id: 'acct', shape: 'record', fields: [{ key: 'mtd', label: 'MTD', role: 'money' }], value: { mtd: 42 } },
            {
              id: 'monthly',
              shape: 'table',
              key: 'month',
              columns: [
                { key: 'month', label: 'Month', role: 'timestamp' },
                { key: 'amount', label: 'Spend', role: 'money' }
              ],
              rows: [{ month: '2026-06', amount: 42 }]
            }
          ],
          summaries: [
            {
              section: 'spend',
              label: 'MTD',
              value: 42,
              role: 'money',
              spark: { dataset: 'monthly', x: 'month', y: 'amount' }
            }
          ]
        })
      },
      {
        id: 'members',
        label: 'Members',
        collect: async () => ({
          datasets: [
            {
              id: 'members',
              shape: 'table',
              key: 'id',
              columns: [{ key: 'id', label: 'ID', role: 'identifier' }],
              rows: [{ id: 'a' }, { id: 'b' }]
            }
          ]
        })
      },
      {
        // An incremental capability: `fetch` returns only the recent window once a watermark exists (the
        // service drops old orders), and `build` runs over the kept union. Models the core union/rebuild flow.
        id: 'orders',
        label: 'Orders',
        collect: async () => ({ datasets: [] }),
        incremental: {
          id: 'orderId',
          timestamp: 'date',
          window: { days: 60 },
          fetch: async (ctx: { since?: string }) =>
            ctx.since
              ? [
                  { orderId: 'B', date: '2026-06-01' },
                  { orderId: 'C', date: '2026-06-25' }
                ]
              : [
                  { orderId: 'A', date: '2020-01-01' },
                  { orderId: 'B', date: '2026-06-01' }
                ],
          build: (rows: Record<string, unknown>[]) => ({
            datasets: [
              {
                id: 'orders',
                shape: 'table',
                key: 'orderId',
                columns: [
                  { key: 'orderId', label: 'Order', role: 'identifier' },
                  { key: 'date', label: 'Date', role: 'timestamp' }
                ],
                rows
              }
            ]
          })
        }
      },
      {
        // Returns a result that violates the contract (key names no column or row field) — exercises the gate.
        id: 'broken',
        label: 'Broken',
        collect: async () => ({
          datasets: [
            {
              id: 't',
              shape: 'table',
              key: 'missing',
              columns: [{ key: 'a', label: 'A', role: 'label' }],
              rows: [{ a: 1 }]
            }
          ]
        })
      },
      {
        // collect() throws (a timeout / network drop) — exercises the failure-logging path.
        id: 'timeout',
        label: 'Timeout',
        collect: async () => {
          throw new Error('timeout of 30000ms exceeded')
        }
      }
    ]
  }
}))

vi.mock('./plugins.js', () => ({
  plugins: [fakePlugin],
  pluginById: (id: string) => (id === 'fake' ? fakePlugin : undefined)
}))

const { runCapability, listConfigOptions, getCachedConfigOptions } = await import('./plugin-host.js')
const { readCurrent, setDataRoot } = await import('../store/store.js')
const { readLedger } = await import('../store/ledger.js')
const { readRawUnion } = await import('../store/raw-union.js')
const { setConfigRoot } = await import('../store/credentials.js')
const { getRecentLogs, clearLogs } = await import('../log.js')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'butin-host-'))
  setDataRoot(dir)
  setConfigRoot(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('runCapability runs collect, stamps the reporting currency, and writes the current cache', async () => {
  const result = (await runCapability('fake', 'billing')) as {
    datasets: { fields: { key: string; currency?: string }[] }[]
    summaries?: { section: string; currency?: string }[]
  }

  // The plugin emitted money with no currency; resolveCurrencies stamped the plugin's reportingCurrency, and
  // the returned value is a full CapabilityResult reconstructed via the manifest (record dataset keeps `fields`).
  expect(result.datasets[0]!.fields[0]!.currency).toBe('USD')
  expect(result.summaries?.[0]?.currency).toBe('USD')

  // The current render cache holds the data-first stored shape: { datasets, summaries, manifest }.
  const envelope = (await readCurrent('fake', 'billing')) as {
    data: { summaries: { section: string; currency?: string }[]; manifest: { summaries?: Record<string, unknown> } }
  } | null

  expect(envelope?.data.summaries[0]!.currency).toBe('USD')
  expect(envelope?.data.manifest.summaries?.spend).toBeDefined()
})

test('a contract-violating result throws in dev and is never persisted', async () => {
  await expect(runCapability('fake', 'broken')).rejects.toThrow(/contract violation/)

  expect(await readCurrent('fake', 'broken')).toBeNull()
})

test('runCapability accumulates keyed datasets into the ledger', async () => {
  await runCapability('fake', 'members')

  const led = await readLedger('fake', 'members')
  const ds = led!.datasets.find((d) => d.id === 'members')!

  expect(ds.rows.map((r) => r.id).sort()).toEqual(['a', 'b'])
})

test('runCapability returns a full CapabilityResult with the keyed dataset projected from the ledger', async () => {
  const result = (await runCapability('fake', 'members')) as {
    datasets: { id: string; rows: Record<string, unknown>[] }[]
  }

  const ds = result.datasets.find((d) => d.id === 'members')!

  expect(ds.rows.map((r) => r.id).sort()).toEqual(['a', 'b'])
})

test('an incremental capability keeps prior rows and rebuilds over the full union', async () => {
  // First run: empty union → a full fetch (no watermark) returns A (old) + B.
  await runCapability('fake', 'orders')

  expect((await readRawUnion('fake', 'orders'))?.rows.map((r) => r.orderId).sort()).toEqual(['A', 'B'])

  // Second run: a watermark now exists, so the service returns only B (re-fetched in-window) + C (new) and drops
  // A. The union RETAINS A and adds C, and build runs over all three.
  const result = (await runCapability('fake', 'orders')) as {
    datasets: { id: string; rows: { orderId: string }[] }[]
  }

  expect(
    result.datasets
      .find((d) => d.id === 'orders')!
      .rows.map((r) => r.orderId)
      .sort()
  ).toEqual(['A', 'B', 'C'])
})

test('a forced refetch rebuilds the union from scratch', async () => {
  await runCapability('fake', 'orders') // union: A, B
  await runCapability('fake', 'orders') // union: A, B, C

  // Force clears the union, so the fetch runs with no watermark — the service's current full set is A + B, so the
  // rebuilt union drops C (a row the service no longer returns), as a deliberate full refetch should.
  await runCapability('fake', 'orders', { force: true })

  expect((await readRawUnion('fake', 'orders'))?.rows.map((r) => r.orderId).sort()).toEqual(['A', 'B'])
})

test('a failed fetch is logged at error level next to the fetching line, then rethrown', async () => {
  clearLogs()

  await expect(runCapability('fake', 'timeout')).rejects.toThrow(/timeout of 30000ms/)

  const failure = getRecentLogs().find((e) => e.plugin === 'fake' && e.action === 'timeout' && e.level === 'error')

  expect(failure?.message).toContain('fetch failed: timeout of 30000ms exceeded')
})

test('unknown plugin throws', async () => {
  await expect(runCapability('nope', 'billing')).rejects.toThrow(/unknown plugin/)
})

test('unknown capability throws', async () => {
  await expect(runCapability('fake', 'usage')).rejects.toThrow(/unknown capability/)
})

test('listConfigOptions runs a combobox field loadOptions through the authed context', async () => {
  await expect(listConfigOptions('fake', 'orgId')).resolves.toEqual([{ value: 'o1', label: 'Org One' }])
})

test('listConfigOptions throws for a field without loadOptions', async () => {
  await expect(listConfigOptions('fake', 'note')).rejects.toThrow(/no loadOptions/)
})

test('listConfigOptions persists the list; getCachedConfigOptions reads it back with no fetch', async () => {
  expect(await getCachedConfigOptions('fake', 'orgId')).toBeNull() // nothing cached yet

  await listConfigOptions('fake', 'orgId')

  expect(await getCachedConfigOptions('fake', 'orgId')).toEqual([{ value: 'o1', label: 'Org One' }])
})

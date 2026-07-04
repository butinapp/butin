import { type Capability, type CollectContext } from '@butinapp/sdk'
import { type CapabilityResult } from '@butinapp/sdk/data'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'

import { downloadResultFilesInto } from './documents.js'

// The download path doesn't touch the plugin registry (downloadResultFilesInto takes the result + ctx +
// cap directly), but plugins.js is imported transitively — stub it so the module graph resolves off-Electron.
vi.mock('../plugin/plugins.js', () => ({ pluginById: () => undefined, plugins: [] }))

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'butin-files-'))
})
afterAll(() => undefined)

const enc = (s: string) => new TextEncoder().encode(s)

// A CollectContext whose client.request returns the URL's last path segment as bytes — enough to assert the
// url-source GET path wrote the right file. Everything else is unused by the download path.
const fakeCtx = (): CollectContext =>
  ({
    client: {
      request: async ({ url }: { url: string }) => ({ data: enc(`body:${url.split('/').pop()}`).buffer })
    }
  }) as unknown as CollectContext

test('fetchFile source: one file per row, foldered by the folder column', async () => {
  const out = join(root, 'fetchfile')
  const calls: string[] = []
  const cap: Capability = {
    id: 'invoices',
    label: 'Invoices',
    collect: async () => ({ datasets: [] }),
    fetchFile: async (_ctx, row) => {
      calls.push(String(row.docId))

      return enc(`pdf:${row.docId}`)
    }
  }
  const result: CapabilityResult = {
    datasets: [
      {
        id: 'invoices',
        shape: 'table',
        columns: [{ key: 'date', label: 'Date', role: 'timestamp' }],
        rows: [
          { date: '2026-05-01', docId: 'D1', folder: 'Imaging', name: 'May' },
          { date: '2026-04-01', docId: 'D2', folder: 'Labs', name: 'Apr' }
        ]
      }
    ],
    views: [
      {
        type: 'table',
        dataset: 'invoices',
        files: { ext: 'pdf', name: 'name', folder: 'folder', source: { fetch: true } }
      }
    ]
  }

  const summary = await downloadResultFilesInto(cap, result, fakeCtx(), out, () => {})

  expect(summary.done).toBe(2)
  expect(calls.sort()).toEqual(['D1', 'D2'])
  expect(readFileSync(join(out, 'Imaging', 'May.pdf'), 'utf8')).toBe('pdf:D1')
  expect(readFileSync(join(out, 'Labs', 'Apr.pdf'), 'utf8')).toBe('pdf:D2')
})

test('url source: GET each row url into the literal category folder; rows without a url are skipped', async () => {
  const out = join(root, 'urlsource')
  const cap: Capability = { id: 'invoices', label: 'Invoices', collect: async () => ({ datasets: [] }) }
  const result: CapabilityResult = {
    datasets: [
      {
        id: 'invoices',
        shape: 'table',
        columns: [{ key: 'name', label: 'Name', role: 'label' }],
        rows: [
          { name: 'one', url: 'https://x/a.txt' },
          { name: 'two', url: '' } // no url → not a file
        ]
      }
    ],
    views: [
      {
        type: 'table',
        dataset: 'invoices',
        files: { name: 'name', source: { url: 'url' }, ext: 'txt', category: 'Invoices' }
      }
    ]
  }

  const summary = await downloadResultFilesInto(cap, result, fakeCtx(), out, () => {})

  expect(summary.done).toBe(1)
  expect(readFileSync(join(out, 'Invoices', 'one.txt'), 'utf8')).toBe('body:a.txt')
})

test('a result with no files view downloads nothing', async () => {
  const cap: Capability = { id: 'plain', label: 'Plain', collect: async () => ({ datasets: [] }) }
  const result: CapabilityResult = {
    datasets: [{ id: 't', shape: 'table', columns: [{ key: 'a', label: 'A', role: 'label' }], rows: [{ a: '1' }] }],
    views: [{ type: 'table', dataset: 't' }]
  }

  const summary = await downloadResultFilesInto(cap, result, fakeCtx(), join(root, 'none'), () => {})

  expect(summary).toEqual({ total: 0, done: 0, skipped: 0, errors: [] })
})

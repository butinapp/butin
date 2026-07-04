import { expect, it } from 'vitest'

import { resolveTableFiles, TableFilesSchema, ViewSchema } from './view.js'

it('accepts an explicit timeseries granularity', () => {
  const v = ViewSchema.parse({
    type: 'timeseries',
    dataset: 'monthly',
    x: 'month',
    y: 'amount',
    granularity: 'monthly'
  })

  expect(v.type === 'timeseries' && v.granularity).toBe('monthly')
})

it('accepts the new files shape', () => {
  const f = TableFilesSchema.parse({ name: 'name', source: { url: 'pdfUrl' }, ext: 'pdf', category: 'Invoices' })

  expect(f.source).toEqual({ url: 'pdfUrl' })
})

it('requires a byte source', () => {
  expect(() => TableFilesSchema.parse({ name: 'name', ext: 'pdf' })).toThrow()
})

it('accepts a fetch source', () => {
  expect(TableFilesSchema.parse({ name: 'title', source: { fetch: true } }).source).toEqual({ fetch: true })
})

it('resolves a table-files descriptor to the internal accessor keys', () => {
  expect(
    resolveTableFiles({ name: 'name', source: { url: 'pdfUrl' }, ext: 'pdf', category: 'Invoices', folder: 'kind' })
  ).toEqual({ urlKey: 'pdfUrl', nameKey: 'name', folderKey: 'kind', ext: 'pdf', category: 'Invoices', useFetch: false })
})

it('marks a fetch source as useFetch', () => {
  expect(resolveTableFiles({ name: 'n', source: { fetch: true } })).toMatchObject({ urlKey: undefined, useFetch: true })
})

it('accepts a table row-detail binding', () => {
  const v = ViewSchema.parse({ type: 'table', dataset: 'members', detail: { dataset: 'keys', on: 'creatorId' } })

  expect(v.type === 'table' && v.detail).toEqual({ dataset: 'keys', on: 'creatorId' })
})

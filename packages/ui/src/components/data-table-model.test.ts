import { describe, expect, it } from 'vitest'

import { formatRows, normalizeTablePrefs, selection, sortRows, type DataTableColumn } from './data-table-model.js'

type Row = { id: string; vendor: string; amount: number; note?: string }

const columns: DataTableColumn<Row>[] = [
  { key: 'vendor', label: 'Vendor' },
  { key: 'amount', label: 'Amount', exportValue: (r) => r.amount },
  { key: 'note', label: 'Note' }
]

const rows: Row[] = [
  { id: '1', vendor: 'GitHub', amount: 21, note: 'has, comma' },
  { id: '2', vendor: 'Quote "Co"', amount: 0, note: undefined }
]

describe('formatRows', () => {
  it('emits CSV with a header row, quotes fields containing commas/quotes, blanks undefined', () => {
    const out = formatRows(columns, rows, 'csv')

    expect(out.mime).toBe('text/csv')
    expect(out.ext).toBe('csv')
    expect(out.text).toBe(['Vendor,Amount,Note', 'GitHub,21,"has, comma"', '"Quote ""Co""",0,'].join('\n'))
  })

  it('emits JSON as an array of objects keyed by column key over export values', () => {
    const out = formatRows(columns, rows, 'json')

    expect(out.mime).toBe('application/json')
    expect(out.ext).toBe('json')
    expect(JSON.parse(out.text)).toEqual([
      { vendor: 'GitHub', amount: 21, note: 'has, comma' },
      { vendor: 'Quote "Co"', amount: 0, note: null }
    ])
  })

  it('respects the column list it is given (already filtered to visible columns by the caller)', () => {
    const out = formatRows([columns[0]], rows, 'csv')

    expect(out.text).toBe(['Vendor', 'GitHub', '"Quote ""Co"""'].join('\n'))
  })
})

describe('sortRows', () => {
  const cols: DataTableColumn<Row>[] = [
    { key: 'vendor', label: 'Vendor' },
    { key: 'amount', label: 'Amount', sortValue: (r) => r.amount }
  ]

  it('sorts numbers numerically, not lexically', () => {
    const data: Row[] = [
      { id: 'a', vendor: 'A', amount: 9 },
      { id: 'b', vendor: 'B', amount: 100 },
      { id: 'c', vendor: 'C', amount: 21 }
    ]

    expect(sortRows(data, { key: 'amount', dir: 'asc' }, cols).map((r) => r.amount)).toEqual([9, 21, 100])
    expect(sortRows(data, { key: 'amount', dir: 'desc' }, cols).map((r) => r.amount)).toEqual([100, 21, 9])
  })

  it('sorts strings case-insensitively and is stable, undefined sorts last', () => {
    const data: Row[] = [
      { id: '1', vendor: 'beta', amount: 1 },
      { id: '2', vendor: 'Alpha', amount: 1 },
      { id: '3', vendor: 'alpha', amount: 1 }
    ]

    expect(sortRows(data, { key: 'vendor', dir: 'asc' }, cols).map((r) => r.id)).toEqual(['2', '3', '1'])
  })

  it('returns a new array and leaves the input untouched', () => {
    const data: Row[] = [
      { id: 'a', vendor: 'A', amount: 2 },
      { id: 'b', vendor: 'B', amount: 1 }
    ]
    const out = sortRows(data, { key: 'amount', dir: 'asc' }, cols)

    expect(out).not.toBe(data)
    expect(data.map((r) => r.amount)).toEqual([2, 1])
  })
})

describe('selection helpers', () => {
  it('toggle adds then removes an id, returning a new set', () => {
    const a = selection.toggle(new Set<string>(), 'x')

    expect([...a]).toEqual(['x'])
    expect([...selection.toggle(a, 'x')]).toEqual([])
  })

  it('setGroup(on) adds all ids; setGroup(off) removes only those ids', () => {
    const base = new Set(['keep'])

    expect([...selection.setGroup(base, ['a', 'b'], true)].sort()).toEqual(['a', 'b', 'keep'])
    expect([...selection.setGroup(new Set(['a', 'b', 'keep']), ['a', 'b'], false)]).toEqual(['keep'])
  })

  it('allOn is true only when every id is present', () => {
    expect(selection.allOn(new Set(['a', 'b']), ['a', 'b'])).toBe(true)
    expect(selection.allOn(new Set(['a']), ['a', 'b'])).toBe(false)
    expect(selection.allOn(new Set(), [])).toBe(false)
  })
})

describe('normalizeTablePrefs', () => {
  const keys = ['vendor', 'amount']

  it('drops sort/order/visibility entries that reference unknown column keys', () => {
    const out = normalizeTablePrefs(
      {
        sort: { key: 'gone', dir: 'asc' },
        columnOrder: ['amount', 'gone', 'vendor'],
        columnVisibility: { vendor: false, gone: false },
        pageSize: 25
      },
      keys
    )

    expect(out).toEqual({
      columnOrder: ['amount', 'vendor'],
      columnVisibility: { vendor: false },
      pageSize: 25
    })
  })

  it('returns an empty object for undefined or fully-stale input', () => {
    expect(normalizeTablePrefs(undefined, keys)).toEqual({})
    expect(normalizeTablePrefs({ sort: { key: 'nope', dir: 'desc' } }, keys)).toEqual({})
  })

  it('keeps a valid sort and clamps a non-positive pageSize away', () => {
    expect(normalizeTablePrefs({ sort: { key: 'amount', dir: 'desc' }, pageSize: 0 }, keys)).toEqual({
      sort: { key: 'amount', dir: 'desc' }
    })
  })
})

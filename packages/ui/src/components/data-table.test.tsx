import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import type { DataTableColumn, DataTableState } from './data-table-model.js'
import { DataTable } from './data-table.js'

type Row = { id: string; name: string }

const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: `Row ${i}` }))
const columns: DataTableColumn<Row>[] = [{ key: 'name', label: 'Name' }]
const getRowId = (r: Row): string => r.id

test('renders the row count in the footer', () => {
  render(<DataTable columns={columns} rows={rows} getRowId={getRowId} paginated />)

  expect(screen.getByText('30 items')).toBeInTheDocument()
})

test('row count is singular for one row', () => {
  render(<DataTable columns={columns} rows={[rows[0]]} getRowId={getRowId} paginated />)

  expect(screen.getByText('1 item')).toBeInTheDocument()
})

test('expandable rows: a chevron toggles a detail row, and rows whose expandable returns null have none', () => {
  const expandable = (r: Row) => (r.id === '0' ? <div>detail for {r.name}</div> : null)

  render(<DataTable columns={columns} rows={[rows[0], rows[1]]} getRowId={getRowId} expandable={expandable} />)

  // Only the row that yields content carries a toggle.
  const toggles = screen.getAllByRole('button', { name: /toggle row details/i })

  expect(toggles).toHaveLength(1)
  expect(screen.queryByText('detail for Row 0')).not.toBeInTheDocument()

  fireEvent.click(toggles[0])
  expect(screen.getByText('detail for Row 0')).toBeInTheDocument()

  fireEvent.click(toggles[0])
  expect(screen.queryByText('detail for Row 0')).not.toBeInTheDocument()
})

test('clicking a row toggles its detail, so the chevron is not the only target', () => {
  const expandable = (r: Row) => (r.id === '0' ? <div>detail for {r.name}</div> : null)

  render(<DataTable columns={columns} rows={[rows[0], rows[1]]} getRowId={getRowId} expandable={expandable} />)

  fireEvent.click(screen.getByText('Row 0'))
  expect(screen.getByText('detail for Row 0')).toBeInTheDocument()

  fireEvent.click(screen.getByText('Row 0'))
  expect(screen.queryByText('detail for Row 0')).not.toBeInTheDocument()
})

test('a row with no detail is not clickable', () => {
  const expandable = (r: Row) => (r.id === '0' ? <div>detail for {r.name}</div> : null)

  render(<DataTable columns={columns} rows={[rows[0], rows[1]]} getRowId={getRowId} expandable={expandable} />)

  fireEvent.click(screen.getByText('Row 1'))
  expect(screen.queryByText('detail for Row 1')).not.toBeInTheDocument()
})

test("a click on a control inside a row is the control's, and does not also expand the row", () => {
  const onPick = vi.fn()
  const withButton: DataTableColumn<Row>[] = [
    { key: 'name', label: 'Name' },
    { key: 'pick', label: 'Pick', cell: () => <button onClick={onPick}>Pick me</button> }
  ]

  render(
    <DataTable
      columns={withButton}
      rows={[rows[0]]}
      getRowId={getRowId}
      expandable={(r) => <div>detail for {r.name}</div>}
    />
  )

  fireEvent.click(screen.getByRole('button', { name: 'Pick me' }))

  expect(onPick).toHaveBeenCalledOnce()
  expect(screen.queryByText('detail for Row 0')).not.toBeInTheDocument()
})

test("search 'always' renders an open input, where the collapsed placements need a click first", () => {
  const { unmount } = render(<DataTable columns={columns} rows={rows} getRowId={getRowId} paginated search="always" />)

  expect(screen.getByPlaceholderText('Search…')).toBeInTheDocument()
  unmount()

  render(<DataTable columns={columns} rows={rows} getRowId={getRowId} paginated search="floating" />)

  expect(screen.queryByPlaceholderText('Search…')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Search…' }))
  expect(screen.getByPlaceholderText('Search…')).toBeInTheDocument()
})

test("search 'off' offers no search affordance at all", () => {
  render(<DataTable columns={columns} rows={rows} getRowId={getRowId} paginated />)

  expect(screen.queryByPlaceholderText('Search…')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Search…' })).not.toBeInTheDocument()
})

test('a pinned search filters the rows as you type', () => {
  render(<DataTable columns={columns} rows={rows} getRowId={getRowId} paginated search="always" />)

  fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'Row 17' } })

  expect(screen.getByText('1 item')).toBeInTheDocument()
  expect(screen.getByText('Row 17')).toBeInTheDocument()
  expect(screen.queryByText('Row 16')).not.toBeInTheDocument()
})

test('adopting asynchronously-loaded prefs does NOT echo back to the host', async () => {
  const onStateChange = vi.fn()

  // First mount with no prefs (the host is still loading them), then the saved prefs arrive.
  const { rerender } = render(
    <DataTable columns={columns} rows={rows} getRowId={getRowId} paginated onStateChange={onStateChange} />
  )

  rerender(
    <DataTable
      columns={columns}
      rows={rows}
      getRowId={getRowId}
      paginated
      initialState={{ sort: { key: 'name', dir: 'desc' } } as DataTableState}
      onStateChange={onStateChange}
    />
  )

  // The seed adopt re-seeds internal state but must be silent — otherwise it would clobber the just-loaded
  // config with the pre-load default.
  await waitFor(() => expect(screen.getByText('30 items')).toBeInTheDocument())
  expect(onStateChange).not.toHaveBeenCalled()
})

test('a user-driven change DOES emit to the host', async () => {
  const onStateChange = vi.fn()

  render(
    <DataTable
      columns={columns}
      rows={rows}
      getRowId={getRowId}
      paginated
      initialState={{} as DataTableState}
      onStateChange={onStateChange}
    />
  )

  fireEvent.click(screen.getByRole('button', { name: 'Name' }))

  await waitFor(() =>
    expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({ sort: { key: 'name', dir: 'asc' } }))
  )
})

test('the header checkbox selects only the rows on the current page, not every page', () => {
  const onSelectionChange = vi.fn()

  // 30 rows over a 25-row page: page one shows 25, the rest sit on page two.
  render(
    <DataTable
      columns={columns}
      rows={rows}
      getRowId={getRowId}
      paginated
      selection={new Set<string>()}
      onSelectionChange={onSelectionChange}
    />
  )

  const master = screen.getByRole('checkbox', { name: 'Select all 25' })

  fireEvent.click(master)

  const selected = onSelectionChange.mock.calls[0][0] as Set<string>

  expect(selected.size).toBe(25)
  expect(selected.has('24')).toBe(true)
  // Row 25 lives on the next page — it must not be swept in.
  expect(selected.has('25')).toBe(false)
})

test('the header checkbox reads checked once this page is selected, and clears just this page', () => {
  const onSelectionChange = vi.fn()
  // Everything on page one, plus one row from page two selected by hand earlier.
  const selection = new Set([...rows.slice(0, 25).map(getRowId), '27'])

  render(
    <DataTable
      columns={columns}
      rows={rows}
      getRowId={getRowId}
      paginated
      selection={selection}
      onSelectionChange={onSelectionChange}
    />
  )

  const master = screen.getByRole('checkbox', { name: 'Select all 25' })

  expect(master).toBeChecked()

  fireEvent.click(master)

  // Clearing drops this page's rows and leaves the off-page selection alone.
  expect(onSelectionChange.mock.calls[0][0]).toEqual(new Set(['27']))
})

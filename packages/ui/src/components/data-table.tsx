import {
  type ColumnDef,
  type ColumnOrderState,
  type SortingState,
  type VisibilityState,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable
} from '@tanstack/react-table'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Columns3,
  Download,
  Search
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { useLabels } from '../i18n/context.js'
import { cn } from '../lib/utils.js'

import { Checkbox } from './checkbox.js'
import {
  formatRows,
  normalizeTablePrefs,
  selection as sel,
  sortRows,
  type DataTableColumn,
  type DataTableState,
  type ExportFormat
} from './data-table-model.js'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './dropdown-menu.js'
import { Input } from './input.js'

export type DataTableProps<Row> = {
  columns: DataTableColumn<Row>[]
  rows: Row[]
  getRowId: (row: Row) => string

  // Selection (controlled by the host; undefined = non-selectable).
  selection?: Set<string>
  onSelectionChange?: (next: Set<string>) => void

  // Category grouping into collapsible sections. When set, pagination is disabled. groupAction is handed
  // both every id in the group AND the subset currently selected, so a host can render a selection-aware action.
  grouped?: {
    by: (row: Row) => string
    order?: string[]
    groupAction?: (key: string, ids: string[], selectedIds: string[]) => ReactNode
  }

  // Optional per-row expandable detail. When it returns content for a row, that row shows a leading expand
  // chevron; clicking toggles a full-width detail row beneath it. Returns null → that row has no detail (no
  // chevron). Expansion state is the table's own ephemeral concern (not persisted).
  expandable?: (row: Row) => ReactNode | null

  paginated?: boolean
  pageSizes?: number[]

  // Persisted prefs (host owns storage). initialState seeds; onStateChange fires on every change.
  initialState?: DataTableState
  onStateChange?: (next: DataTableState) => void

  // Export. When omitted, the toolbar Export menu is hidden. The component formats; the host saves.
  onExport?: (blob: { text: string; mime: string }, filename: string) => void
  exportName?: string

  toolbar?: { search?: boolean; columns?: boolean }
  toolbarExtra?: ReactNode
  actionBar?: ReactNode
  emptyLabel?: string
  // Whether the search affordance floats up into a title row above the table (costing no vertical space).
  // True only when the host renders such a row; without one (a titleless panel) the search sits inline at the
  // top-right of the table instead of floating into the empty space above the card.
  searchFloating?: boolean
}

// The per-row expansion hooks the row renderers need, derived once from the `expandable` prop: the detail
// builder (null → no chevron for that row), and open-state read/toggle keyed by row id.
type RowExpand<Row> = {
  detail: (row: Row) => ReactNode | null
  isOpen: (id: string) => boolean
  toggle: (id: string) => void
}

const DEFAULT_PAGE_SIZES = [15, 25, 50, 100]
// The page size a table opens at when nothing is saved (see pageSize seeding below).
const DEFAULT_PAGE_SIZE = 25

// Generic, headless, theme-portable table. TanStack owns sorting/column-order/visibility/pagination;
// selection (external Set) and grouping (manual collapsible sections over the sorted rows) are layered
// on top so grouping stays fully controllable. Pure — prefs in via props, export out via callback.
export const DataTable = <Row,>({
  columns,
  rows,
  getRowId,
  selection,
  onSelectionChange,
  grouped,
  expandable,
  paginated,
  pageSizes = DEFAULT_PAGE_SIZES,
  initialState,
  onStateChange,
  onExport,
  exportName = 'export',
  toolbar,
  toolbarExtra,
  actionBar,
  emptyLabel,
  searchFloating = true
}: DataTableProps<Row>) => {
  const t = useLabels()
  const selectable = Boolean(selection && onSelectionChange)
  const usePaging = Boolean(paginated) && !grouped

  // Local, ephemeral row expansion (which rows have their detail open) — never persisted, same as group
  // collapse below. `expand` bundles the per-row hooks the rows need; absent when no expandable prop.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const expand: RowExpand<Row> | undefined = expandable
    ? {
        detail: expandable,
        isOpen: (id) => expandedRows.has(id),
        toggle: (id) =>
          setExpandedRows((prev) => {
            const next = new Set(prev)

            if (next.has(id)) {
              next.delete(id)
            } else {
              next.add(id)
            }

            return next
          })
      }
    : undefined

  // Sanitize persisted prefs against the CURRENT column keys before seeding — a plugin may have added/
  // removed/renamed columns since the prefs were saved. Seeded once; later changes are local state.
  const seed = useMemo(
    () =>
      normalizeTablePrefs(
        initialState,
        columns.map((c) => c.key)
      ),
    [initialState, columns]
  )

  // The controlled state the seed maps to. Computed from `seed` so it tracks the persisted prefs, which the
  // host loads asynchronously — the real values arrive AFTER first mount.
  const seedStates = useMemo(
    () => ({
      sorting: (seed.sort ? [{ id: seed.sort.key, desc: seed.sort.dir === 'desc' }] : []) as SortingState,
      columnOrder: (seed.columnOrder ?? []) as ColumnOrderState,
      columnVisibility: (seed.columnVisibility ?? {}) as VisibilityState,
      pageSize:
        seed.pageSize ??
        (pageSizes.includes(DEFAULT_PAGE_SIZE) ? DEFAULT_PAGE_SIZE : (pageSizes[0] ?? DEFAULT_PAGE_SIZE))
    }),
    [seed, pageSizes]
  )

  const [sorting, setSorting] = useState<SortingState>(seedStates.sorting)
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(seedStates.columnOrder)
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(seedStates.columnVisibility)
  const [pageSize, setPageSize] = useState(seedStates.pageSize)
  const [pageIndex, setPageIndex] = useState(0)
  const [query, setQuery] = useState('')

  // The host owns persistence and may recreate `onStateChange` every render; hold it in a ref so emitting
  // never depends on (and never re-fires from) its identity churning.
  const onStateChangeRef = useRef(onStateChange)

  onStateChangeRef.current = onStateChange

  // Adopt the seed whenever its CONTENT changes — the persisted prefs load after first mount, so re-seed the
  // controlled state once they arrive, and mark that change programmatic (`skipEmit`) so it is NOT echoed back
  // to the host. Without this, the post-load emit would clobber the just-loaded config with the pre-load
  // default. Compared by content (not object identity) so a host refetch returning the same values is a no-op
  // and never discards an unsaved in-flight edit.
  const seedSig = JSON.stringify(seedStates)
  const appliedSig = useRef(seedSig)
  const skipEmit = useRef(false)

  useEffect(() => {
    if (appliedSig.current === seedSig) {
      return
    }

    appliedSig.current = seedSig
    skipEmit.current = true
    setSorting(seedStates.sorting)
    setColumnOrder(seedStates.columnOrder)
    setColumnVisibility(seedStates.columnVisibility)
    setPageSize(seedStates.pageSize)
  }, [seedSig, seedStates])

  // Emit prefs on a USER change (sort/order/visibility/pageSize); the host debounces before persisting. The
  // first run (mount) and any programmatic seed-adopt are skipped, so only real edits persist.
  const firstRun = useRef(true)

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false

      return
    }

    if (skipEmit.current) {
      skipEmit.current = false

      return
    }

    onStateChangeRef.current?.({
      sort: sorting[0] ? { key: sorting[0].id, dir: sorting[0].desc ? 'desc' : 'asc' } : undefined,
      columnOrder: columnOrder.length > 0 ? columnOrder : undefined,
      columnVisibility,
      pageSize
    })
  }, [sorting, columnOrder, columnVisibility, pageSize])

  const tanCols = useMemo<ColumnDef<Row>[]>(
    () =>
      columns.map((col) => ({
        id: col.key,
        accessorFn: (row) => (col.sortValue ? col.sortValue(row) : (row as Record<string, unknown>)[col.key]),
        header: col.label,
        enableSorting: col.sortable !== false,
        enableHiding: col.hideable !== false
      })),
    [columns]
  )

  const table = useReactTable({
    data: rows,
    columns: tanCols,
    state: { sorting, columnOrder, columnVisibility, ...(usePaging ? { pagination: { pageIndex, pageSize } } : {}) },
    onSortingChange: setSorting,
    onColumnOrderChange: setColumnOrder,
    onColumnVisibilityChange: setColumnVisibility,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  })

  // The fully-resolved, ordered, visible leaf columns (for export + drag reorder + header render).
  const leafCols = table.getVisibleLeafColumns()
  const visibleModelCols = useMemo(
    () =>
      leafCols.map((c) => columns.find((dc) => dc.key === c.id)).filter((c): c is DataTableColumn<Row> => c != null),
    [leafCols, columns]
  )

  // Sorted, search-filtered rows (raw Row objects). Search matches across export values, case-insensitive.
  const filtered = useMemo(() => {
    const sorted = sorting[0]
      ? sortRows(rows, { key: sorting[0].id, dir: sorting[0].desc ? 'desc' : 'asc' }, columns)
      : rows
    const q = query.trim().toLowerCase()

    if (!q) {
      return sorted
    }

    return sorted.filter((row) =>
      columns.some((c) => {
        const v = c.exportValue ? c.exportValue(row) : (row as Record<string, unknown>)[c.key]

        return v != null && String(v).toLowerCase().includes(q)
      })
    )
  }, [rows, sorting, query, columns])

  const allIds = useMemo(() => filtered.map(getRowId), [filtered, getRowId])
  const pageRows = usePaging ? filtered.slice(pageIndex * pageSize, pageIndex * pageSize + pageSize) : filtered

  // Master select-all state for the header checkbox: checked when every filtered row is selected,
  // indeterminate when only some are. Clicking selects all filtered rows (across pages/groups), or clears.
  const allSelected = selectable && selection ? sel.allOn(selection, allIds) : false
  const someSelected = selectable && selection ? !allSelected && allIds.some((id) => selection.has(id)) : false
  const masterChecked: boolean | 'indeterminate' = allSelected ? true : someSelected ? 'indeterminate' : false

  const doExport = (format: ExportFormat): void => {
    const blob = formatRows(visibleModelCols, filtered, format)

    onExport?.({ text: blob.text, mime: blob.mime }, `${exportName}.${blob.ext}`)
  }

  // Native HTML5 drag reorder on header cells -> columnOrder.
  const dragId = useRef<string | null>(null)
  const onDrop = (targetId: string): void => {
    const src = dragId.current

    dragId.current = null

    if (!src || src === targetId) {
      return
    }

    const order = leafCols.map((c) => c.id)
    const from = order.indexOf(src)
    const to = order.indexOf(targetId)

    order.splice(to, 0, order.splice(from, 1)[0])
    setColumnOrder(order)
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  // The top toolbar is just a collapsed search affordance (an icon that expands into an input, right-aligned)
  // so it costs almost no space; select-all lives in the header-row checkbox; column/export live in the footer.
  const hideableCount = table.getAllLeafColumns().filter((c) => c.getCanHide()).length
  const showColumnsMenu = Boolean(toolbar?.columns) && hideableCount > 0
  const searchEnabled = Boolean(toolbar?.search)

  // The search floats up into the right of the section's title row (absolute, negative-top) so it costs the
  // table no vertical space — the data starts at the very top. Sticky offsets therefore ignore it.
  const headTop = 'top-0'
  const groupTop = 'top-9'

  const columnsMenu = showColumnsMenu ? (
    <DropdownMenu>
      <DropdownMenuTrigger className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 outline-none">
        <Columns3 className="size-3.5" /> {t.tableColumns}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {table
          .getAllLeafColumns()
          .filter((c) => c.getCanHide())
          .map((c) => {
            const dc = columns.find((x) => x.key === c.id)

            return (
              <DropdownMenuCheckboxItem
                key={c.id}
                checked={c.getIsVisible()}
                onCheckedChange={(v) => c.toggleVisibility(v)}
              >
                {dc?.label ?? c.id}
              </DropdownMenuCheckboxItem>
            )
          })}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null

  const exportMenu = onExport ? (
    <DropdownMenu>
      <DropdownMenuTrigger className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 outline-none">
        <Download className="size-3.5" /> {t.tableExport}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => doExport('csv')}>CSV</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => doExport('json')}>JSON</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null

  return (
    <div className="relative space-y-2">
      {searchEnabled ? (
        <div className={cn('z-30 flex items-center justify-end', searchFloating && 'absolute -top-8 right-0')}>
          <TableSearch query={query} onChange={setQuery} placeholder={t.searchPlaceholder} />
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <p className="text-muted-foreground text-xs">{emptyLabel ?? t.noRows}</p>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="text-left">
              {expand ? <th className={cn('bg-card sticky z-10 w-6 border-b py-1 pl-0.5', headTop)} /> : null}
              {selectable ? (
                <th className={cn('bg-card sticky z-10 w-6 border-b py-1 pr-3 pl-0.5', headTop)}>
                  <Checkbox
                    checked={masterChecked}
                    onCheckedChange={() => onSelectionChange?.(sel.setGroup(selection!, allIds, !allSelected))}
                    aria-label={t.tableSelectAll(allIds.length)}
                  />
                </th>
              ) : null}
              {leafCols.map((c) => {
                const dc = columns.find((x) => x.key === c.id)
                const sorted = c.getIsSorted()

                return (
                  <th
                    key={c.id}
                    draggable
                    onDragStart={() => (dragId.current = c.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => onDrop(c.id)}
                    className={cn(
                      'bg-card sticky z-10 border-b py-1 font-medium select-none last:pr-0',
                      headTop,
                      // Right-aligned (numeric) columns get extra trailing room so the figures don't crowd the
                      // next column's label/badge.
                      dc?.align === 'right' ? 'pr-8 text-right' : 'pr-4',
                      dc?.noWrap && 'whitespace-nowrap',
                      dc?.grow && 'w-full',
                      dc?.minWidth
                    )}
                  >
                    <button
                      className="hover:text-foreground inline-flex items-center gap-1"
                      disabled={!c.getCanSort()}
                      onClick={c.getToggleSortingHandler()}
                    >
                      {dc?.label ?? c.id}
                      {c.getCanSort() ? (
                        sorted === 'asc' ? (
                          <ArrowUp className="size-3" />
                        ) : sorted === 'desc' ? (
                          <ArrowDown className="size-3" />
                        ) : (
                          <ChevronsUpDown className="size-3 opacity-40" />
                        )
                      ) : null}
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {grouped ? (
              <Groups
                rows={filtered}
                grouped={grouped}
                visibleModelCols={visibleModelCols}
                selectable={selectable}
                selection={selection}
                onSelectionChange={onSelectionChange}
                getRowId={getRowId}
                stickyTop={groupTop}
                expand={expand}
              />
            ) : (
              pageRows.map((row) => (
                <DataRow
                  key={getRowId(row)}
                  row={row}
                  cols={visibleModelCols}
                  selectable={selectable}
                  checked={selection?.has(getRowId(row)) ?? false}
                  onToggle={() => onSelectionChange?.(sel.toggle(selection!, getRowId(row)))}
                  expand={expand}
                  rowId={getRowId(row)}
                />
              ))
            )}
          </tbody>
        </table>
      )}

      {filtered.length > 0 ? (
        // One footer row: row count + optional extra (left) · pagination (center) · column/export utilities
        // (right). The flanking flex-1 zones keep pagination optically centered whether or not the sides are
        // filled. Always present (even without paging/columns/export) so the row count has a home.
        <div className="text-muted-foreground flex items-center gap-2 pt-1 text-xs">
          <div className="flex flex-1 items-center gap-2">
            {toolbarExtra}
            <span className="tabular-nums">{t.tableRowCount(filtered.length)}</span>
          </div>

          {usePaging ? (
            <div className="flex items-center justify-center gap-2">
              <button
                className="hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent inline-flex size-7 items-center justify-center rounded-md border"
                disabled={pageIndex === 0}
                onClick={() => setPageIndex((i) => i - 1)}
                aria-label={t.tablePrev}
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="border-input inline-flex h-7 min-w-12 items-center justify-center rounded-md border px-2 tabular-nums">
                {t.tablePageOf(pageIndex + 1, totalPages)}
              </span>
              <button
                className="hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent inline-flex size-7 items-center justify-center rounded-md border"
                disabled={pageIndex + 1 >= totalPages}
                onClick={() => setPageIndex((i) => i + 1)}
                aria-label={t.tableNext}
              >
                <ChevronRight className="size-4" />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger className="hover:bg-accent inline-flex h-7 items-center gap-1 rounded-md border px-2 outline-none">
                  {t.tablePerPage(pageSize)} <ChevronDown className="size-3.5 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="center">
                  {pageSizes.map((n) => (
                    <DropdownMenuItem
                      key={n}
                      onSelect={() => {
                        setPageSize(n)
                        setPageIndex(0)
                      }}
                    >
                      {t.tablePerPage(n)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}

          <div className="flex flex-1 items-center justify-end gap-3">
            {columnsMenu}
            {exportMenu}
          </div>
        </div>
      ) : null}

      {actionBar ? (
        <div className="bg-card sticky bottom-0 flex flex-wrap items-center gap-2 border-t py-3">{actionBar}</div>
      ) : null}
    </div>
  )
}

// Collapsed-by-default search: a magnifier button that expands into an input on click, so the top of the
// table costs only an icon's width until you actually search. Stays expanded while a query is present;
// Escape or blurring an empty field collapses it back to the icon.
const TableSearch = ({
  query,
  onChange,
  placeholder
}: {
  query: string
  onChange: (next: string) => void
  placeholder: string
}) => {
  const [open, setOpen] = useState(false)
  const expanded = open || query.length > 0

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={placeholder}
        className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-7 items-center justify-center rounded-md outline-none"
      >
        <Search className="size-4" />
      </button>
    )
  }

  return (
    <div className="relative">
      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
      <Input
        autoFocus
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (query.length === 0) {
            setOpen(false)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onChange('')
            setOpen(false)
          }
        }}
        placeholder={placeholder}
        className="h-7 w-48 pl-7 text-xs"
      />
    </div>
  )
}

const DataRow = <Row,>({
  row,
  cols,
  selectable,
  checked,
  onToggle,
  expand,
  rowId
}: {
  row: Row
  cols: DataTableColumn<Row>[]
  selectable: boolean
  checked: boolean
  onToggle: () => void
  // Present only when the table is expandable. `rowId` keys the open-state lookup/toggle.
  expand?: RowExpand<Row>
  rowId?: string
}) => {
  const t = useLabels()
  const detail = expand ? expand.detail(row) : null
  const isOpen = Boolean(expand && rowId != null && expand.isOpen(rowId))
  const colSpan = cols.length + (selectable ? 1 : 0) + (expand ? 1 : 0)

  return (
    <>
      <tr className="border-border/50 hover:bg-muted/30 border-t transition-colors">
        {expand ? (
          <td className="w-6 py-1 pl-0.5 align-middle">
            {detail != null ? (
              <button
                onClick={() => rowId != null && expand.toggle(rowId)}
                aria-expanded={isOpen}
                aria-label={t.toggleRowDetails}
                className="text-muted-foreground hover:text-foreground inline-flex"
              >
                {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              </button>
            ) : null}
          </td>
        ) : null}
        {selectable ? (
          <td className="py-1 pr-3 pl-0.5 align-middle">
            <Checkbox checked={checked} onCheckedChange={onToggle} />
          </td>
        ) : null}
        {cols.map((c) => (
          <td
            key={c.key}
            className={cn(
              'py-1 tabular-nums last:pr-0',
              // Match the header: right-aligned numerics keep extra trailing room from the next column.
              c.align === 'right' ? 'pr-8 text-right' : 'pr-4',
              c.noWrap && 'whitespace-nowrap',
              // The greedy column takes all leftover width (w-full) without its content forcing the table wider
              // (max-w-0) — its cell truncates to fit. No overflow-clip on the td, so a cell popover still escapes.
              c.grow && 'w-full max-w-0',
              c.minWidth
            )}
          >
            {c.cell ? c.cell(row) : String((row as Record<string, unknown>)[c.key] ?? '')}
          </td>
        ))}
      </tr>
      {isOpen && detail != null ? (
        <tr className="border-border/40 border-t">
          <td colSpan={colSpan} className="bg-muted/20 px-2 py-2">
            {detail}
          </td>
        </tr>
      ) : null}
    </>
  )
}

// Partition the (already sorted/filtered) rows into collapsible category sections. Each section header
// carries a select-all checkbox + count + chevron + optional per-group action. Collapse is local state.
const Groups = <Row,>({
  rows,
  grouped,
  visibleModelCols,
  selectable,
  selection,
  onSelectionChange,
  getRowId,
  stickyTop,
  expand
}: {
  rows: Row[]
  grouped: NonNullable<DataTableProps<Row>['grouped']>
  visibleModelCols: DataTableColumn<Row>[]
  selectable: boolean
  selection?: Set<string>
  onSelectionChange?: (next: Set<string>) => void
  getRowId: (row: Row) => string
  stickyTop: string
  expand?: RowExpand<Row>
}) => {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const order = grouped.order ?? []
  const keys = [...new Set([...order, ...rows.map(grouped.by)])].filter((k) => rows.some((r) => grouped.by(r) === k))
  const colSpan = visibleModelCols.length + (selectable ? 1 : 0) + (expand ? 1 : 0)

  // A single category adds no information — its header would just be visual noise (and the cramped inline
  // action the user flagged). Render the rows flat; the top toolbar still owns select-all / none.
  if (keys.length <= 1) {
    return (
      <>
        {rows.map((row) => (
          <DataRow
            key={getRowId(row)}
            row={row}
            cols={visibleModelCols}
            selectable={selectable}
            checked={selection?.has(getRowId(row)) ?? false}
            onToggle={() => onSelectionChange?.(sel.toggle(selection!, getRowId(row)))}
            expand={expand}
            rowId={getRowId(row)}
          />
        ))}
      </>
    )
  }

  return (
    <>
      {keys.map((key) => {
        const groupRows = rows.filter((r) => grouped.by(r) === key)
        const ids = groupRows.map(getRowId)
        const selectedIds = selection ? ids.filter((id) => selection.has(id)) : []
        const allOn = selectable && selection ? sel.allOn(selection, ids) : false
        const isOpen = !collapsed.has(key)

        return (
          <GroupSection
            key={key}
            groupKey={key}
            count={groupRows.length}
            colSpan={colSpan}
            stickyTop={stickyTop}
            isOpen={isOpen}
            allOn={allOn}
            selectable={selectable}
            onToggleOpen={() =>
              setCollapsed((prev) => {
                const next = new Set(prev)

                if (next.has(key)) {
                  next.delete(key)
                } else {
                  next.add(key)
                }

                return next
              })
            }
            onToggleAll={() => onSelectionChange?.(sel.setGroup(selection!, ids, !allOn))}
            action={grouped.groupAction?.(key, ids, selectedIds)}
          >
            {isOpen
              ? groupRows.map((row) => (
                  <DataRow
                    key={getRowId(row)}
                    row={row}
                    cols={visibleModelCols}
                    selectable={selectable}
                    checked={selection?.has(getRowId(row)) ?? false}
                    onToggle={() => onSelectionChange?.(sel.toggle(selection!, getRowId(row)))}
                    expand={expand}
                    rowId={getRowId(row)}
                  />
                ))
              : null}
          </GroupSection>
        )
      })}
    </>
  )
}

const GroupSection = ({
  groupKey,
  count,
  colSpan,
  stickyTop,
  isOpen,
  allOn,
  selectable,
  onToggleOpen,
  onToggleAll,
  action,
  children
}: {
  groupKey: string
  count: number
  colSpan: number
  stickyTop: string
  isOpen: boolean
  allOn: boolean
  selectable: boolean
  onToggleOpen: () => void
  onToggleAll: () => void
  action?: ReactNode
  children: ReactNode
}) => (
  <>
    <tr className={cn('bg-muted sticky z-[5] border-y', stickyTop)}>
      <td colSpan={colSpan} className="bg-muted py-1.5">
        <div className="flex items-center gap-2 pl-0.5 text-xs font-medium">
          {selectable ? (
            <Checkbox checked={allOn} onCheckedChange={onToggleAll} aria-label={`Select all ${groupKey}`} />
          ) : null}
          <button
            onClick={onToggleOpen}
            className="hover:text-foreground inline-flex items-center gap-1.5"
            aria-expanded={isOpen}
          >
            {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {groupKey}
            <span className="text-muted-foreground font-normal">{count}</span>
          </button>
          {action ? <span className="ml-auto">{action}</span> : null}
        </div>
      </td>
    </tr>
    {children}
  </>
)

import type { ReactNode } from 'react'

// A generic, contract-agnostic column. The CALLER supplies display (`cell`), sort key (`sortValue`) and
// export value (`exportValue`) so <DataTable> never depends on the data-view SemanticRole — the dashboard
// caller wires formatByRole, the documents caller wires badges/icons. Defaults read row[key] verbatim.
export type DataTableColumn<Row> = {
  key: string
  label: string
  align?: 'left' | 'right'
  // Keep this column on a single line (short fixed-width values — dates, money, counts, status, ids — that
  // shouldn't wrap; browsers otherwise break 'YYYY-MM-DD' at its hyphens). Free-text columns leave it off so
  // they absorb the slack and wrap. Set by the caller from the column's semantic role.
  noWrap?: boolean
  // Make this the table's greedy column: it absorbs the leftover horizontal width (others size to content) and
  // its cell truncates to fit. Used for a long free-text column so it fills the row instead of a fixed cap.
  grow?: boolean
  // A Tailwind min-width class (e.g. 'min-w-28') giving this column a floor so the greedy column can't squeeze
  // it below a comfortable width. Applied to both the header and body cells.
  minWidth?: string
  sortable?: boolean // default true
  hideable?: boolean // default true
  cell?: (row: Row) => ReactNode
  sortValue?: (row: Row) => string | number | undefined
  exportValue?: (row: Row) => string | number | undefined
}

// Persisted, embed-portable table state. Stored per-capability by the host; <DataTable> is pure.
export type DataTableState = {
  sort?: { key: string; dir: 'asc' | 'desc' }
  columnOrder?: string[]
  columnVisibility?: Record<string, boolean> // false = hidden
  pageSize?: number
}

export type ExportFormat = 'csv' | 'json'
export type ExportBlob = { text: string; mime: string; ext: ExportFormat }

const exportValueOf = <Row>(col: DataTableColumn<Row>, row: Row): string | number | undefined =>
  col.exportValue ? col.exportValue(row) : ((row as Record<string, unknown>)[col.key] as string | number | undefined)

// One field of a CSV record. Quote when it contains a comma, quote, or newline; double embedded quotes.
const csvCell = (value: string | number | undefined): string => {
  if (value === undefined || value === null) {
    return ''
  }

  const s = String(value)

  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// Format the GIVEN columns + rows to a downloadable blob. The caller passes only the columns it wants
// exported (visible, in display order) and only the rows it wants (current sort/filter, all pages).
export const formatRows = <Row>(columns: DataTableColumn<Row>[], rows: Row[], format: ExportFormat): ExportBlob => {
  if (format === 'json') {
    const objects = rows.map((row) => {
      const o: Record<string, string | number | null> = {}

      for (const col of columns) {
        const v = exportValueOf(col, row)

        o[col.key] = v === undefined ? null : v
      }

      return o
    })

    return { text: JSON.stringify(objects, null, 2), mime: 'application/json', ext: 'json' }
  }

  const header = columns.map((c) => csvCell(c.label)).join(',')
  const body = rows.map((row) => columns.map((c) => csvCell(exportValueOf(c, row))).join(','))

  return { text: [header, ...body].join('\n'), mime: 'text/csv', ext: 'csv' }
}

const sortValueOf = <Row>(col: DataTableColumn<Row> | undefined, row: Row): string | number | undefined => {
  if (!col) {
    return undefined
  }

  return col.sortValue ? col.sortValue(row) : ((row as Record<string, unknown>)[col.key] as string | number | undefined)
}

// Stable, type-aware sort. Numbers compare numerically; everything else compares as a case-insensitive
// string. undefined/null always sort last regardless of direction. Returns a new array.
export const sortRows = <Row>(
  rows: Row[],
  sort: { key: string; dir: 'asc' | 'desc' },
  columns: DataTableColumn<Row>[]
): Row[] => {
  const col = columns.find((c) => c.key === sort.key)
  const factor = sort.dir === 'desc' ? -1 : 1

  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const av = sortValueOf(col, a.row)
      const bv = sortValueOf(col, b.row)

      if (av === undefined || av === null) {
        return bv === undefined || bv === null ? a.i - b.i : 1
      }

      if (bv === undefined || bv === null) {
        return -1
      }

      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv), undefined, { sensitivity: 'accent' })

      return cmp === 0 ? a.i - b.i : cmp * factor
    })
    .map((x) => x.row)
}

export const selection = {
  toggle: (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set)

    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }

    return next
  },

  setGroup: (set: Set<string>, ids: string[], on: boolean): Set<string> => {
    const next = new Set(set)

    ids.forEach((id) => (on ? next.add(id) : next.delete(id)))

    return next
  },

  allOn: (set: Set<string>, ids: string[]): boolean => ids.length > 0 && ids.every((id) => set.has(id))
}

// Sanitize persisted prefs against the table's CURRENT column keys. A plugin may add/remove/rename
// columns between releases; stale references are silently dropped so a saved pref never throws or
// hides/sorts by a column that no longer exists. Never returns undefined fields.
export const normalizeTablePrefs = (prefs: DataTableState | undefined, columnKeys: string[]): DataTableState => {
  const known = new Set(columnKeys)
  const out: DataTableState = {}

  if (prefs?.sort && known.has(prefs.sort.key)) {
    out.sort = prefs.sort
  }

  if (prefs?.columnOrder) {
    const order = prefs.columnOrder.filter((k) => known.has(k))

    if (order.length > 0) {
      out.columnOrder = order
    }
  }

  if (prefs?.columnVisibility) {
    const vis: Record<string, boolean> = {}

    for (const [k, v] of Object.entries(prefs.columnVisibility)) {
      if (known.has(k)) {
        vis[k] = v
      }
    }

    if (Object.keys(vis).length > 0) {
      out.columnVisibility = vis
    }
  }

  if (typeof prefs?.pageSize === 'number' && prefs.pageSize > 0) {
    out.pageSize = prefs.pageSize
  }

  return out
}

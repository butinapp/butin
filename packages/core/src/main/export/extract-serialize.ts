import {
  type CapabilityResult,
  type Column,
  type Dataset,
  type RecordDataset,
  type TableDataset
} from '@butinapp/sdk/data'

// HTML escaping for the self-contained index.html (below).
const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// A CapabilityResult is any object carrying a `datasets` array — enough to serialize. Custom capabilities
// return a plain object (no datasets) and are dumped as raw JSON instead.
export const isCapabilityResult = (data: unknown): data is CapabilityResult =>
  typeof data === 'object' && data != null && Array.isArray((data as { datasets?: unknown }).datasets)

// Export-stable formatting (NOT the UI's display formatting): files want parseable values. Money → fixed
// 2-decimals; null/undefined → empty; non-primitives → JSON; everything else → its string form as stored.
export const formatCell = (value: unknown, column: Column): string => {
  if (value == null) {
    return ''
  }

  if (column.role === 'money' && typeof value === 'number') {
    return value.toFixed(2)
  }

  if (typeof value === 'object') {
    return JSON.stringify(value)
  }

  return String(value)
}

// Hidden columns are machinery (accumulation key, download filename, fetchFile payload) — never displayed
// nor exported. Every serializer iterates only the visible columns so headers and cells stay aligned.
const visibleCols = (cols: Column[]): Column[] => cols.filter((c) => !c.hidden)

// Drop the given keys from a row object, so emitted data carries no machinery field without a matching column.
const omitKeys = (row: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {}

  for (const [k, v] of Object.entries(row)) {
    if (!keys.includes(k)) {
      out[k] = v
    }
  }

  return out
}

// RFC-4180: quote a field that holds a comma, quote, CR or LF; double interior quotes.
const escapeCsv = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

// One CSV per table dataset: a label header row + role-formatted, escaped cells. Trailing newline (POSIX).
export const datasetToCsv = (ds: TableDataset): string => {
  const cols = visibleCols(ds.columns)
  const header = cols.map((c) => escapeCsv(c.label ?? c.key)).join(',')
  const lines = ds.rows.map((row) => cols.map((c) => escapeCsv(formatCell(row[c.key], c))).join(','))

  return [header, ...lines].join('\n') + '\n'
}

// A Markdown table cell can't hold a raw pipe or newline — neutralize both.
const mdCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

const tableToMarkdown = (ds: TableDataset): string => {
  const cols = visibleCols(ds.columns)
  const head = `| ${cols.map((c) => mdCell(c.label ?? c.key)).join(' | ')} |`
  const sep = `| ${cols.map(() => '---').join(' | ')} |`
  const rows = ds.rows.map((row) => `| ${cols.map((c) => mdCell(formatCell(row[c.key], c))).join(' | ')} |`)

  return [head, sep, ...rows].join('\n')
}

const recordToMarkdown = (ds: RecordDataset): string =>
  visibleCols(ds.fields)
    .map((f) => `- **${f.label ?? f.key}:** ${formatCell(ds.value[f.key], f)}`)
    .join('\n')

const datasetToMarkdown = (ds: Dataset): string => (ds.shape === 'table' ? tableToMarkdown(ds) : recordToMarkdown(ds))

// Render every dataset in a result, datasets separated by a blank line. The capability heading is added
// by buildIndexDoc, so this stays a pure dataset renderer.
export const resultToMarkdown = (result: CapabilityResult): string =>
  result.datasets.map(datasetToMarkdown).join('\n\n')

// --- Consumable JSON export. The raw CapabilityResult is an INTERNAL, render-coupled shape (presentation
// `views`, per-column `badges`, a `shape` discriminator) that's awkward to consume downstream. The export
// payload is the data without the presentation: provenance up top, the headline summary, and each dataset
// as a plain typed-row table / flat record with a compact column schema (key · label · role · currency) so
// it's self-documenting and directly loadable (jq, pandas). Values pass through as stored — money stays a
// number of dollars, not a formatted string (that's what CSV is for). ---

export type ExportColumn = { key: string; label: string; role: Column['role']; currency?: string }

export type ExportDataset =
  | { id: string; type: 'table'; title?: string; columns: ExportColumn[]; rows: Record<string, unknown>[] }
  | { id: string; type: 'record'; title?: string; fields: ExportColumn[]; values: Record<string, unknown> }

export type ExportMeta = { service: string; capability: string; label: string; generatedAt: string }

export type ExportPayload = ExportMeta & {
  summaries?: CapabilityResult['summaries']
  datasets?: ExportDataset[]
  data?: unknown // non-CapabilityResult ('custom') capabilities: the raw object, kept under the same envelope
}

const exportColumn = (c: Column): ExportColumn => ({
  key: c.key,
  label: c.label ?? c.key,
  role: c.role,
  ...(c.currency ? { currency: c.currency } : {})
})

// A dataset's display title comes from its bound view (if any) — the only bit of `views` worth keeping.
const datasetTitle = (result: CapabilityResult, datasetId: string): string | undefined => {
  const view = (result.views ?? []).find((v) => v.dataset === datasetId)

  return view && 'title' in view && view.title ? view.title : undefined
}

const exportDataset = (result: CapabilityResult, ds: Dataset): ExportDataset => {
  const title = datasetTitle(result, ds.id)

  if (ds.shape === 'table') {
    const cols = visibleCols(ds.columns)
    const hiddenKeys = ds.columns.filter((c) => c.hidden).map((c) => c.key)
    const rows = hiddenKeys.length ? ds.rows.map((row) => omitKeys(row, hiddenKeys)) : ds.rows

    return { id: ds.id, type: 'table', ...(title ? { title } : {}), columns: cols.map(exportColumn), rows }
  }

  const fields = visibleCols(ds.fields)
  const hiddenKeys = ds.fields.filter((f) => f.hidden).map((f) => f.key)
  const values = hiddenKeys.length ? omitKeys(ds.value, hiddenKeys) : ds.value

  return { id: ds.id, type: 'record', ...(title ? { title } : {}), fields: fields.map(exportColumn), values }
}

// The data/<capability>.json contents: a clean, documented envelope instead of the raw internal result.
export const buildExportPayload = (data: unknown, meta: ExportMeta): ExportPayload => {
  if (!isCapabilityResult(data)) {
    return { ...meta, data }
  }

  return {
    ...meta,
    ...(data.summaries?.length ? { summaries: data.summaries } : {}),
    datasets: data.datasets.map((ds) => exportDataset(data, ds))
  }
}

export type IndexSection = { label: string; markdown: string }

export type IndexDocInput = {
  pluginName: string
  runAt: string
  sections: IndexSection[]
  fileCount: number
  exportFolders: string[]
}

// The generic human-readable index.md: a title, the run timestamp, one `## <label>` section per
// capability (rendered body, a raw-JSON fence, or a failure note — the caller decides), then a footer
// pointing at the downloaded files and any bespoke export subfolders.
export const buildIndexDoc = (opts: IndexDocInput): string => {
  const head = `# ${opts.pluginName} — extract\n\n_Run: ${opts.runAt}_`
  const body = opts.sections.map((s) => `## ${s.label}\n\n${s.markdown}`).join('\n\n')
  const footerLines = [`${opts.fileCount} file(s) downloaded under \`files/\`.`]

  for (const folder of opts.exportFolders) {
    footerLines.push(`Bespoke export: \`${folder}/\``)
  }

  return [head, body, '---', footerLines.join('\n')].filter(Boolean).join('\n\n') + '\n'
}

// --- index.html: a self-contained, human-browsable HTML record of everything saved (the browser entry
// point for an extract folder). Renders the same CapabilityResults the in-app DashboardRenderer draws, but
// as static HTML with inline CSS (no React/Tailwind in the main process) + links to the downloaded files. ---

// One cell, role-aware: url → link, everything else → escaped, export-stable text.
const cellHtml = (value: unknown, col: Column): string => {
  const text = formatCell(value, col)

  if (!text) {
    return ''
  }

  if (col.role === 'url') {
    return `<a href="${escapeHtml(text)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`
  }

  return escapeHtml(text)
}

// A table dataset → an HTML table. When `fileLink` is given (the dataset backs a downloadable `files` view),
// a trailing "Document" column links each row to its on-disk file.
const tableToHtml = (ds: TableDataset, fileLink?: (rowIndex: number) => string | undefined): string => {
  const cols = visibleCols(ds.columns)
  const headExtra = fileLink ? '<th>Document</th>' : ''
  const head = `<tr>${cols.map((c) => `<th>${escapeHtml(c.label ?? c.key)}</th>`).join('')}${headExtra}</tr>`
  const rows = ds.rows
    .map((row, i) => {
      const cells = cols.map((c) => `<td>${cellHtml(row[c.key], c)}</td>`).join('')
      const link = fileLink?.(i)
      const fileCell = fileLink
        ? `<td>${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">PDF</a>` : ''}</td>`
        : ''

      return `<tr>${cells}${fileCell}</tr>`
    })
    .join('')

  return `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`
}

const recordToHtml = (ds: RecordDataset): string =>
  `<dl>${visibleCols(ds.fields)
    .map((f) => `<dt>${escapeHtml(f.label ?? f.key)}</dt><dd>${cellHtml(ds.value[f.key], f) || '—'}</dd>`)
    .join('')}</dl>`

// Render a whole CapabilityResult to HTML. `fileMap` (row-index → relative file path, from planResultFiles)
// turns a downloadable table's rows into file links.
export const resultToHtml = (result: CapabilityResult, fileMap?: Map<string, string>): string => {
  const views = result.views ?? []

  return result.datasets
    .map((ds) => {
      const view = views.find((v) => v.dataset === ds.id)
      const title = view && 'title' in view && view.title ? `<h3>${escapeHtml(view.title)}</h3>` : ''

      if (ds.shape === 'record') {
        return title + recordToHtml(ds)
      }

      const hasFiles = views.some((v) => v.type === 'table' && v.dataset === ds.id && Boolean(v.files))
      const fileLink =
        hasFiles && fileMap
          ? (i: number) => {
              const rel = fileMap.get(String(i))

              return rel ? `files/${rel.replace(/\\/g, '/')}` : undefined
            }
          : undefined

      return title + tableToHtml(ds, fileLink)
    })
    .join('\n')
}

export type HtmlSection = { label: string; html: string }

const INDEX_HTML_CSS = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;color:#1a1a1a;background:#fafafa}
header{padding:24px 32px;background:#fff;border-bottom:1px solid #e5e5e5}
header h1{margin:0 0 4px;font-size:22px}
header p{margin:0;color:#666;font-size:13px}
nav{padding:12px 32px;background:#fff;border-bottom:1px solid #e5e5e5;position:sticky;top:0;font-size:13px}
nav a{color:#0a6b3b;text-decoration:none;margin-right:4px}
main{max-width:1100px;margin:0 auto;padding:24px 32px}
section{margin-bottom:40px}
section h2{font-size:18px;border-bottom:2px solid #0a6b3b;padding-bottom:6px}
section h3{font-size:14px;color:#555;margin:18px 0 6px}
table{border-collapse:collapse;width:100%;font-size:13px;background:#fff}
th,td{border:1px solid #e5e5e5;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f3f3f3;font-weight:600}
tbody tr:nth-child(even){background:#fafafa}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;background:#fff;padding:16px;border:1px solid #e5e5e5;font-size:13px}
dt{font-weight:600;color:#555}
dd{margin:0}
a{color:#0a6b3b}
`.trim()

// Assemble the self-contained index.html: inline CSS, a title + run stamp, a section nav, one section per
// capability. No external assets (other than relative links into files/).
export const buildIndexHtml = (opts: { pluginName: string; runAt: string; sections: HtmlSection[] }): string => {
  const nav = opts.sections.map((s, i) => `<a href="#s${i}">${escapeHtml(s.label)}</a>`).join(' · ')
  const body = opts.sections
    .map((s, i) => `<section id="s${i}"><h2>${escapeHtml(s.label)}</h2>${s.html}</section>`)
    .join('\n')

  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(opts.pluginName)}</title><style>${INDEX_HTML_CSS}</style></head>` +
    `<body><header><h1>${escapeHtml(opts.pluginName)}</h1><p>${escapeHtml(opts.runAt)}</p></header>` +
    `<nav>${nav}</nav><main>${body}</main></body></html>\n`
  )
}

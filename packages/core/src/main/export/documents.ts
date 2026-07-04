import { type Capability, type CollectContext, type DocumentBytes, type DownloadTransport } from '@butinapp/sdk'
import { resolveTableFiles, type CapabilityResult, type TableFiles, type View } from '@butinapp/sdk/data'
import { existsSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import type { LocatedFile } from '../../shared/ipc.js'
import { buildContext, requireCapability, requirePlugin } from '../plugin/plugin-context.js'
import { writeBytes } from '../store/secure-fs.js'
import { dataRootDir, readCurrent, reconstructResult, resolveDocumentsDir } from '../store/store.js'

import { getDocumentsOutputDir } from './documents-config.js'
import { type PlanEntry, planDownloads, sanitizeFilename } from './documents-plan.js'

export type DocumentProgressState = 'queued' | 'downloading' | 'done' | 'skipped' | 'error'

export type DocumentProgress = {
  docId: string
  state: DocumentProgressState
  error?: string
  // Set on 'done': where the file landed + its on-disk size, so the renderer can light up its Open action and
  // size column immediately rather than after the end-of-batch refetch.
  path?: string
  sizeBytes?: number
  completed: number
  total: number
}

export type DownloadSummary = {
  total: number
  done: number
  skipped: number
  errors: { docId: string; error: string }[]
}

const CONCURRENCY = 4

// One downloadable file derived from a table row: the planning metadata + a byte-source thunk. `fetch` is
// agnostic — it GETs a URL via the authed client, or calls the capability's fetchFile(ctx, row) hook.
type FileEntry = {
  id: string
  title: string
  category?: string
  ext?: string
  fetch: (ctx: CollectContext) => Promise<DocumentBytes>
}

type FetchFileHook = (ctx: CollectContext, row: Record<string, unknown>) => Promise<DocumentBytes>

const fetchFileOf = (cap: Capability): FetchFileHook | undefined =>
  'fetchFile' in cap ? (cap.fetchFile as FetchFileHook | undefined) : undefined

const toBytes = (raw: DocumentBytes): { data: Uint8Array; filename?: string } =>
  raw instanceof Uint8Array ? { data: raw } : { data: raw.data, filename: raw.filename }

// True when `abs` lands inside the active profile's data root. Files there go through secure-fs so they're
// sealed on an encrypted profile; a CUSTOM external output dir is deliberately outside the vault (so external
// tools can read it) and keeps the raw write.
const isInsideProfile = (abs: string): boolean => {
  const root = resolve(dataRootDir())

  return resolve(abs).startsWith(root + sep)
}

// Write file bytes to disk, sealing through the profile vault for in-profile destinations and writing raw for a
// custom external output dir. On an OFF profile secure-fs passes bytes straight through, so the default-dir
// path is byte-identical either way.
const writeFileBytes = async (abs: string, data: Uint8Array): Promise<void> => {
  if (isInsideProfile(abs)) {
    await writeBytes(dataRootDir(), abs, Buffer.from(data))
  } else {
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, data)
  }
}

// The shared download pool: fetch a selection of entries to `outputDir`. Per-file errors don't abort the
// batch; a small pool bounds concurrency; no per-file retry; force re-fetches files already on disk.
const downloadEntries = async (
  ctx: CollectContext,
  entries: FileEntry[],
  selection: string[] | 'all',
  opts: { force?: boolean },
  onProgress: (p: DocumentProgress) => void,
  outputDir: string,
  maxConcurrency?: number
): Promise<DownloadSummary> => {
  const byId = new Map(entries.map((d) => [d.id, d]))
  const ids = selection === 'all' ? entries.map((d) => d.id) : selection

  const planEntries = ids.map((id) => byId.get(id)).filter((d): d is FileEntry => Boolean(d))
  const planned = planDownloads(planEntries, (rel) => !opts.force && existsSync(join(outputDir, rel)))
  const total = planned.length
  const summary: DownloadSummary = { total, done: 0, skipped: 0, errors: [] }

  let next = 0

  const worker = async (): Promise<void> => {
    while (next < planned.length) {
      const item = planned[next++]
      const entry = byId.get(item.docId) as FileEntry

      if (item.skip) {
        summary.skipped++
        onProgress({
          docId: item.docId,
          state: 'skipped',
          completed: summary.done + summary.skipped + summary.errors.length,
          total
        })

        continue
      }

      onProgress({
        docId: item.docId,
        state: 'downloading',
        completed: summary.done + summary.skipped + summary.errors.length,
        total
      })

      try {
        // No retry — a failed fetch (verification needed, expired session) surfaces as a per-file error
        // immediately rather than re-hammering the service.
        const fetchedBytes = toBytes(await entry.fetch(ctx))
        const rel = fetchedBytes.filename
          ? join(dirname(item.relPath), sanitizeFilename(fetchedBytes.filename))
          : item.relPath
        const abs = join(outputDir, rel)

        await writeFileBytes(abs, fetchedBytes.data)
        summary.done++
        onProgress({
          docId: item.docId,
          state: 'done',
          path: abs,
          sizeBytes: statSync(abs).size,
          completed: summary.done + summary.skipped + summary.errors.length,
          total
        })
      } catch (err) {
        const error = (err as Error).message

        summary.errors.push({ docId: item.docId, error })
        onProgress({
          docId: item.docId,
          state: 'error',
          error,
          completed: summary.done + summary.skipped + summary.errors.length,
          total
        })
      }
    }
  }

  const pool = Math.max(1, Math.min(maxConcurrency ?? CONCURRENCY, planned.length))

  await Promise.all(Array.from({ length: pool }, worker))

  return summary
}

// --- downloadable tables: a collect capability whose result has a table view with a `files` descriptor.
// The same rows render as a data table AND download as files. Items are derived in main from the STORED
// report (no items cross IPC); the row id is the dataset row INDEX so the renderer's selection lines up.

type DownloadableTable = { files: TableFiles; rows: Record<string, unknown>[] }

const downloadableFromReport = (data: unknown): DownloadableTable | null => {
  const result = data as CapabilityResult | null | undefined

  if (!result || !Array.isArray(result.datasets)) {
    return null
  }

  const view = (result.views ?? []).find(
    (v): v is Extract<View, { type: 'table' }> => v.type === 'table' && Boolean(v.files)
  )

  if (!view?.files) {
    return null
  }

  const ds = result.datasets.find((d) => d.id === view.dataset)

  if (!ds || ds.shape !== 'table') {
    return null
  }

  return { files: view.files, rows: ds.rows }
}

// Build a FileEntry per row. id = full-array row index (matches the renderer's getRowId). Byte source: a row
// url column (GET that row's URL, rows without a URL skipped) when one resolves and the source isn't a fetch
// source; otherwise the capability's fetchFile hook (every row is a candidate). Subfolder: the per-row folder
// column value, else the literal category.
const fileEntries = (
  table: DownloadableTable,
  fetchFile?: FetchFileHook,
  download?: DownloadTransport
): FileEntry[] => {
  const { urlKey, nameKey, ext, category, folderKey, useFetch } = resolveTableFiles(table.files)
  const referer = download?.referer

  return table.rows
    .map((row, i): FileEntry | null => {
      const base = nameKey && row[nameKey] != null ? String(row[nameKey]) : String(i + 1)
      const folder = folderKey && row[folderKey] != null ? String(row[folderKey]) : category
      const common = { id: String(i), title: base, category: folder, ext }

      if (urlKey && !useFetch) {
        const url = row[urlKey]

        if (typeof url !== 'string' || url === '') {
          return null
        }

        return {
          ...common,
          fetch: async (ctx) =>
            new Uint8Array((await ctx.client.request<ArrayBuffer>({ url, responseType: 'arraybuffer', referer })).data)
        }
      }

      if (!fetchFile) {
        return null
      }

      return { ...common, fetch: (ctx) => fetchFile(ctx, row) }
    })
    .filter((e): e is FileEntry => e != null)
}

const resolveTable = async (
  pluginId: string,
  capabilityId: string
): Promise<{ cap: Capability; table: DownloadableTable } | null> => {
  const plugin = requirePlugin(pluginId)
  const cap = requireCapability(plugin, capabilityId)
  const stored = await readCurrent(pluginId, capabilityId)
  // Reconstruct the stored data into a CapabilityResult so the `files` view (which lives in the manifest) is
  // visible to the downloadable-table resolver — the same shape an in-memory collect result has.
  const table = downloadableFromReport(reconstructResult(stored?.data))

  return table ? { cap, table } : null
}

// Download a collect capability's downloadable-table files. Throws if the stored report has no such table
// or the table declares no byte source. `outputDirOverride` lands files elsewhere (the Extract-all run).
export const downloadReportFiles = async (
  pluginId: string,
  capabilityId: string,
  selection: string[] | 'all',
  opts: { force?: boolean },
  onProgress: (p: DocumentProgress) => void,
  outputDirOverride?: string
): Promise<DownloadSummary> => {
  const resolved = await resolveTable(pluginId, capabilityId)

  if (!resolved) {
    throw new Error(`no downloadable table in report: ${pluginId}/${capabilityId}`)
  }

  const { cap, table } = resolved
  const fetchFile = fetchFileOf(cap)
  const { urlKey, useFetch } = resolveTableFiles(table.files)

  if (!(urlKey && !useFetch) && !fetchFile) {
    throw new Error(
      `files table has no byte source (source.url / urlKey or capability.fetchFile): ${pluginId}/${capabilityId}`
    )
  }

  const plugin = requirePlugin(pluginId)
  const download = plugin.transport?.download
  const ctx = buildContext(plugin, capabilityId)
  const outputDir = outputDirOverride ?? resolveDocumentsDir(pluginId, getDocumentsOutputDir(pluginId))

  return downloadEntries(
    ctx,
    fileEntries(table, fetchFile, download),
    selection,
    opts,
    onProgress,
    outputDir,
    download?.concurrency
  )
}

// Download an in-memory collect result's files into a folder (the Extract-all run, which holds the freshly
// collected result + auth context rather than reading the stored report). No-op summary when no files table.
export const downloadResultFilesInto = async (
  cap: Capability,
  result: CapabilityResult,
  ctx: CollectContext,
  outputDir: string,
  onProgress: (p: DocumentProgress) => void,
  download?: DownloadTransport
): Promise<DownloadSummary> => {
  const table = downloadableFromReport(result)

  if (!table) {
    return { total: 0, done: 0, skipped: 0, errors: [] }
  }

  return downloadEntries(
    ctx,
    fileEntries(table, fetchFileOf(cap), download),
    'all',
    {},
    onProgress,
    outputDir,
    download?.concurrency
  )
}

// The exact row-index → relative output path the download will write for a result's downloadable table, so
// the generated index.html can link each row to its file. Uses the SAME planning as the download, so paths
// (incl. dedup suffixes) match. Empty map when the result has no files table.
export const planResultFiles = (
  cap: Capability,
  result: CapabilityResult,
  download?: DownloadTransport
): Map<string, string> => {
  const table = downloadableFromReport(result)

  if (!table) {
    return new Map()
  }

  const planEntries: PlanEntry[] = fileEntries(table, fetchFileOf(cap), download).map(
    ({ id, title, category, ext }) => ({
      id,
      title,
      category,
      ext
    })
  )

  return new Map(planDownloads(planEntries, () => false).map((p) => [p.docId, p.relPath]))
}

// row id → on-disk path + size for a downloadable table's files already on disk (drives Open + the size
// column). Plans the same paths downloadReportFiles writes to, then stats what exists. {} when no such table.
export const locateReportFiles = async (
  pluginId: string,
  capabilityId: string
): Promise<Record<string, LocatedFile>> => {
  const resolved = await resolveTable(pluginId, capabilityId)

  if (!resolved) {
    return {}
  }

  const download = requirePlugin(pluginId).transport?.download
  const planEntries: PlanEntry[] = fileEntries(resolved.table, fetchFileOf(resolved.cap), download).map(
    ({ id, title, category, ext }) => ({ id, title, category, ext })
  )
  const outputDir = resolveDocumentsDir(pluginId, getDocumentsOutputDir(pluginId))
  const located: Record<string, LocatedFile> = {}

  for (const item of planDownloads(planEntries, () => false)) {
    const abs = join(outputDir, item.relPath)

    if (existsSync(abs)) {
      // On an encrypted profile this is the on-disk ciphertext size (the envelope overhead), not the plaintext
      // size — acceptable; sizing would otherwise force a decrypt of every located file.
      located[item.docId] = { path: abs, sizeBytes: statSync(abs).size }
    }
  }

  return located
}

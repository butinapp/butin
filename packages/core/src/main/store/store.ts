import { type CapabilityResult } from '@butinapp/sdk/data'
import { toDisplayResult, type PresentationManifest, type StoredDataset, type StoredSummary } from '@butinapp/shapes'
import { readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readJson as readJsonSecure, writeJson as writeJsonSecure } from './secure-fs.js'

// The `current` render cache: the latest projection of a capability run, kept for fast reads (no ledger
// replay on open). `data` holds `{ datasets, summaries, manifest }` — enough to reconstruct a CapabilityResult.
export type ReportEnvelope = { pluginId: string; capabilityId: string; lastRunAt: string; data: unknown }

// The `current` envelope's `data` shape: the stored data-first records + summaries + presentation manifest.
export type StoredData = { datasets: StoredDataset[]; summaries: StoredSummary[]; manifest: PresentationManifest }

const isStoredData = (data: unknown): data is StoredData => {
  if (typeof data !== 'object' || data === null) {
    return false
  }

  const d = data as { datasets?: unknown; summaries?: unknown; manifest?: unknown }

  return (
    Array.isArray(d.datasets) && Array.isArray(d.summaries) && typeof d.manifest === 'object' && d.manifest !== null
  )
}

// Rebuild a renderable CapabilityResult from a `current` envelope's `data` (label/spark/views reattached from
// the manifest). null when the payload isn't conforming stored data (a custom capability / corrupt cache).
export const reconstructResult = (data: unknown): CapabilityResult | null =>
  isStoredData(data) ? toDisplayResult(data.datasets, data.summaries, data.manifest) : null

let dataRoot = join(homedir(), 'butin')

export const setDataRoot = (dir: string): void => {
  dataRoot = dir
}

// Long writes into the profile's data tree — a capability run, a document download, an extract run. The
// profile archive refuses to pack while any is in flight, because a `current`/`ledger`/document file caught
// half-written would restore as corrupt data on the other machine.
let writesInFlight = 0

export const profileWritesInFlight = (): boolean => writesInFlight > 0

export const trackProfileWrite = async <T>(fn: () => Promise<T>): Promise<T> => {
  writesInFlight += 1

  try {
    return await fn()
  } finally {
    writesInFlight -= 1
  }
}

// Current data root, so sibling stores (snapshots) share the same base + test seam.
export const dataRootDir = (): string => dataRoot

// Parse a JSON file, or null on any failure (missing/corrupt/locked) — the "no cache yet" signal everywhere
// here. Every read flows through secure-fs against the active profile's data root, so an encrypted profile is
// transparent: UNLOCKED decrypts, LOCKED yields null, OFF is plaintext.
const readJson = <T>(path: string): Promise<T | null> => readJsonSecure<T>(dataRoot, path)

// Pretty-write a JSON value (sealed on an UNLOCKED profile, plaintext on an OFF one), creating its parent dir.
const writeJson = (path: string, value: unknown): Promise<void> => writeJsonSecure(dataRoot, path, value)

const currentPath = (pluginId: string, capabilityId: string): string =>
  join(dataRoot, pluginId, 'current', `${capabilityId}.json`)

export const ledgerPath = (pluginId: string, capabilityId: string): string =>
  join(dataRoot, pluginId, 'ledger', `${capabilityId}.json`)

export const saveCurrent = async (pluginId: string, capabilityId: string, data: unknown): Promise<string> => {
  const lastRunAt = new Date().toISOString()

  await writeJson(currentPath(pluginId, capabilityId), { pluginId, capabilityId, lastRunAt, data })

  return lastRunAt
}

export const readCurrent = (pluginId: string, capabilityId: string): Promise<ReportEnvelope | null> =>
  readJson<ReportEnvelope>(currentPath(pluginId, capabilityId))

// --- generic per-plugin disk cache --------------------------------------------------------------------
// One primitive for any "fetch once, keep until refreshed, survive relaunch" cache: a namespaced, timestamped
// JSON blob at ~/butin/<plugin>/<namespace>/<key>.json (e.g. combobox config options). Reports + document
// manifests keep their own envelopes (lastRunAt/enumeratedAt, which listReportTimes reads).
export type CacheEnvelope<T> = { pluginId: string; namespace: string; key: string; cachedAt: string; data: T }

const cachePath = (pluginId: string, namespace: string, key: string): string =>
  join(dataRoot, pluginId, namespace, `${key}.json`)

export const writeCache = async <T>(pluginId: string, namespace: string, key: string, data: T): Promise<string> => {
  const cachedAt = new Date().toISOString()

  await writeJson(cachePath(pluginId, namespace, key), { pluginId, namespace, key, cachedAt, data })

  return cachedAt
}

export const readCache = <T>(pluginId: string, namespace: string, key: string): Promise<CacheEnvelope<T> | null> =>
  readJson<CacheEnvelope<T>>(cachePath(pluginId, namespace, key))

// Drop a whole cache namespace for a plugin (e.g. on disconnect / erase). No-op when it never existed.
export const clearCache = (pluginId: string, namespace: string): Promise<void> =>
  rm(join(dataRoot, pluginId, namespace), { recursive: true, force: true })

// The service's data root (~/butin/<plugin>/) — the folder Settings surfaces + opens.
export const serviceDir = (pluginId: string): string => join(dataRoot, pluginId)

// Remove a service's ENTIRE data folder — cached reports, downloaded documents, extracts, caches, all of it.
// Used by an uninstall that opts to erase all data; a plain uninstall leaves downloaded files in place. No-op
// when the folder never existed.
export const clearServiceFolder = (pluginId: string): Promise<void> =>
  rm(serviceDir(pluginId), { recursive: true, force: true })

// Last-refresh timestamp per capability, keyed by capability id — the SAME time each tab shows. Merges
// both stores so it matches every tab: standard capabilities save a `report` (lastRunAt); `documents`
// capabilities save a display-only `manifest` (enumeratedAt) instead. Newest of the two wins. Empty when
// nothing is cached.
export const listReportTimes = async (pluginId: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {}

  // ISO-8601 strings sort lexicographically by time, so a plain `>` picks the newer one.
  const note = (capId: string, when?: string): void => {
    if (when && (!out[capId] || when > out[capId])) {
      out[capId] = when
    }
  }

  const scan = async (
    subdir: string,
    pick: (env: { lastRunAt?: string; enumeratedAt?: string }) => string | undefined
  ) => {
    const dir = join(dataRoot, pluginId, subdir)

    let files: string[]

    try {
      files = await readdir(dir)
    } catch {
      return // dir doesn't exist yet
    }

    for (const f of files) {
      if (!f.endsWith('.json')) {
        continue
      }

      const env = await readJson<{ lastRunAt?: string; enumeratedAt?: string }>(join(dir, f))

      if (env) {
        note(f.slice(0, -'.json'.length), pick(env))
      }
    }
  }

  await scan('current', (env) => env.lastRunAt)
  await scan('manifests', (env) => env.enumeratedAt)

  return out
}

// Newest report time across all of a plugin's capabilities (ISO-8601), or undefined if nothing is cached —
// the freshness the Management list shows + filters on. ISO strings sort lexically by time, so max is the last.
export const newestReportTime = async (pluginId: string): Promise<string | undefined> =>
  Object.values(await listReportTimes(pluginId))
    .sort()
    .at(-1)

// Erase a service's cached tab data (the current render cache + the append-only ledger + display-only
// document manifests). Keeps the stored session, downloaded documents, and extract folders — those are
// removed by Disconnect / a manual clean, not this.
export const clearReports = async (pluginId: string): Promise<void> => {
  await rm(join(dataRoot, pluginId, 'current'), { recursive: true, force: true })
  await rm(join(dataRoot, pluginId, 'ledger'), { recursive: true, force: true })
  await rm(join(dataRoot, pluginId, 'manifests'), { recursive: true, force: true })
}

// Erase ONE capability's accumulated data — its current render cache, its ledger, its raw fetch union, and its
// document manifest — so a forced full refetch rebuilds it from scratch. Leaves every other capability, the
// stored session, and downloaded documents intact. No-op for files that never existed.
export const clearCapabilityReports = async (pluginId: string, capabilityId: string): Promise<void> => {
  for (const sub of ['current', 'ledger', 'manifests', 'raw']) {
    await rm(join(dataRoot, pluginId, sub, `${capabilityId}.json`), { force: true })
  }
}

// Default documents folder; an override (from documents-config) wins when provided.
export const resolveDocumentsDir = (pluginId: string, override?: string): string =>
  override ?? join(dataRoot, pluginId, 'documents')

// Extracts root for the "Extract everything" run folders: ~/butin/<plugin>/extracts/. No override — extract
// always writes here.
export const resolveExtractsDir = (pluginId: string): string => join(dataRoot, pluginId, 'extracts')

// Remove on-disk stores superseded by the ledger model (the old reports/ + mergeHistory history/). Best-effort,
// idempotent — the next fetch rebuilds the ledger. Called once on startup.
export const eraseLegacyStores = async (): Promise<void> => {
  let entries: string[]

  try {
    entries = await readdir(dataRoot)
  } catch {
    return
  }

  for (const pluginId of entries) {
    for (const legacy of ['reports', 'history', 'snapshots']) {
      await rm(join(dataRoot, pluginId, legacy), { recursive: true, force: true }).catch(() => {})
    }
  }
}

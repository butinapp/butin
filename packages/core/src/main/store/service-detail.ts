import type { AuthKind } from '@butinapp/sdk'

import type { FolderStatsDto, ServiceDetailDto, ServiceMechanicsDto } from '../../shared/ipc.js'
import { getDocumentsOutputDir } from '../export/documents-config.js'
import { plugins } from '../plugin/plugins.js'

import { readLedger } from './ledger.js'
import { countItems } from './overview.js'
import { primarySeries } from './project-ledger.js'
import { readCurrent, resolveDocumentsDir, serviceDir } from './store.js'
import { walkFiles } from './walk.js'

// Plain-language sentence per auth kind, for the Settings tab's "Under the hood" section — so a non-expert
// reads how Butin gets the data, and the local-first story (your own session, no credential custody) shows.
const AUTH_SUMMARY: Record<AuthKind, string> = {
  cookie: 'Replays your stored session cookie, fetched headless — no browser, no credential custody.',
  'bearer-token': 'Sends your stored bearer token with each request, fetched headless.',
  external: 'Authenticates with the keys you enter in Settings. Butin stores no login session.',
  'api-key': 'Uses your stored API key with each request, fetched headless.',
  'cookie-csrf': 'Replays your session cookie plus a CSRF token derived for each request.',
  'minted-jwt': 'Exchanges your stored session for a short-lived token on every fetch.',
  'rotating-refresh': 'Exchanges a refresh token for a fresh access token each fetch, rotating it back.',
  'spa-bearer': 'Boots your dashboard in an offscreen window to capture a short-lived token, re-minted on expiry.'
}

export const authSummary = (kind: AuthKind): string => AUTH_SUMMARY[kind]

// The descriptor fields the "Under the hood" section reads. Narrow enough to test without a whole plugin.
type MechanicsSource = {
  auth: { kind: AuthKind }
  transport?: { engine?: 'node' | 'electron'; requiresBrowserEngine?: boolean }
  session?: { loginUrl?: string; cookieDomains?: string[]; requiredCookie?: string }
  meta: { category?: string; homepage?: string; version?: string }
}

// Derive the read mechanics from a plugin descriptor. requiresBrowserEngine forces the Electron transport (its
// readable alias), so it wins over a declared engine.
export const serviceMechanics = (plugin: MechanicsSource): ServiceMechanicsDto => {
  const requiresBrowserEngine = Boolean(plugin.transport?.requiresBrowserEngine)

  return {
    authKind: plugin.auth.kind,
    authSummary: authSummary(plugin.auth.kind),
    transportEngine: requiresBrowserEngine ? 'electron' : (plugin.transport?.engine ?? 'node'),
    requiresBrowserEngine,
    cookieDomains: plugin.session?.cookieDomains ?? [],
    loginUrl: plugin.session?.loginUrl,
    requiredCookie: plugin.session?.requiredCookie,
    category: plugin.meta.category,
    homepage: plugin.meta.homepage,
    version: plugin.meta.version
  }
}

// Assemble the reshaped Settings tab's info payload from cached reports + the descriptor. Pure IO glue over
// the tested selectors (countItems) — runs no collector.
export const buildServiceDetail = async (pluginId: string): Promise<ServiceDetailDto> => {
  const plugin = plugins.find((p) => p.meta.id === pluginId)

  if (!plugin) {
    throw new Error(`unknown plugin: ${pluginId}`)
  }

  const capabilities = await Promise.all(
    plugin.capabilities.map(async (c) => {
      const report = await readCurrent(pluginId, c.id)
      const ledger = await readLedger(pluginId, c.id)
      const spark = ledger ? primarySeries(ledger) : []

      return {
        id: c.id,
        label: c.label,
        recordCount: countItems(report?.data),
        lastRunAt: report?.lastRunAt,
        snapshotCount: spark.length,
        spark: spark.length > 0 ? spark : undefined
      }
    })
  )

  const recordCount = capabilities.reduce((sum, c) => sum + c.recordCount, 0)
  // ISO strings sort lexicographically by time → the last is the newest.
  const lastRunAt = capabilities
    .map((c) => c.lastRunAt)
    .filter((t): t is string => Boolean(t))
    .sort()
    .at(-1)

  return { mechanics: serviceMechanics(plugin), capabilities, recordCount, lastRunAt }
}

// Recursively total a folder's file count + bytes. Best-effort: an unreadable dir/file is skipped, never
// thrown — a missing service folder (nothing fetched yet) returns zeroes.
export const computeFolderStats = async (dir: string): Promise<{ fileCount: number; totalBytes: number }> => {
  const files = await walkFiles(dir)

  return { fileCount: files.length, totalBytes: files.reduce((sum, f) => sum + f.size, 0) }
}

// Whole-folder footprint plus a separate count of downloaded documents (the files a normal erase/uninstall
// keeps), so the UI can reassure the user those survive. The documents folder honours its per-plugin override.
export const getFolderStats = async (pluginId: string): Promise<FolderStatsDto> => {
  const total = await computeFolderStats(serviceDir(pluginId))
  const docs = await computeFolderStats(resolveDocumentsDir(pluginId, getDocumentsOutputDir(pluginId)))

  return { ...total, documentCount: docs.fileCount }
}

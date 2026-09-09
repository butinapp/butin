import type { AuthKind, TransportEngine } from '@butinapp/sdk'
import { clipboard, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { primaryHost, resolveSurface } from '../detect/domains.js'
import { aggregateProfile, foldProfiles } from '../detect/profile.js'
import { loadRun, loadRunProfile } from '../detect/run-data.js'
import type { DomainProfile, EndpointCategory, RunData } from '../detect/types.js'

import { readAppLock, type AppLockStatus } from './app-lock.js'
import { kickstart, planCapabilities, resolveEvidence, suggestIdentity } from './kickstart/index.js'
import { createRecorderWindow, DEFAULT_PARTITION } from './recorder-window.js'
import { defaultFilters } from './recording/filters.js'
import { domainLabel } from './recording/naming.js'
import { deleteRecording } from './recording/storage.js'
import type { RecordingManifest } from './recording/types.js'
import { resolveRepoRoot } from './repo-root.js'
import { domainsFile, profilesRegistry, recorderPrefsFile, recordingsRoot } from './store.js'

// Published on window.recorder — one entry per IPC channel.
export interface DomainSummary {
  surface: string
  runCount: number
  authKind: AuthKind
  engine: TransportEngine
  /** ISO timestamp of the most recent run under this surface — the sort key for "most recent" ordering. */
  lastRecordedAt: string
}

// One selectable app profile: its name + the browser partition a recording targets to share that
// profile's captured session. `active` is the profile the app currently has open.
export interface ProfileOption {
  id: string
  name: string
  partition: string
  active: boolean
}

// Preview of what a kickstart will produce, shown in the Create-plugin dialog before any file is written.
export interface PluginSuggestion {
  id: string
  name: string
  vendor: string
  /** True when plugins/<id>/ already exists — the author must pick a different id. */
  collision: boolean
  capabilities: { capId: string; label: string; category?: EndpointCategory; evidenceCount: number }[]
}

// The outcome of a kickstart: where the files landed + the prompt that was copied to the clipboard.
export interface KickstartOutcome {
  pluginPath: string
  briefPath: string
  prompt: string
}

// The app's profiles.json record shape (the subset the recorder reads).
type ProfileRecord = { id: string; name: string; partition?: string }

// Resolve a profile record to its browser partition. App-written records store an explicit partition;
// the fallback mirrors the app's convention for any record predating that field — the default `personal`
// profile shares persist:butin, every other profile is isolated under persist:butin-<id>.
const partitionForRecord = (r: ProfileRecord): string =>
  r.partition ?? (r.id === 'personal' ? 'persist:butin' : `persist:butin-${r.id}`)

// ---- helpers ----------------------------------------------------------------

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T

// The profile id behind a partition — the key the real-Chrome sign-in hand-off uses for its persistent Chrome
// user-data-dir. Resolving it from the registry (rather than parsing the partition) means a recording reuses
// the very Chrome profile the app signed in for that Butin profile. Falls back to a filesystem-safe key drawn
// from the partition when the app has never run or the partition matches no record.
const chromeScopeForPartition = async (partition: string): Promise<string> => {
  const path = profilesRegistry()

  if (existsSync(path)) {
    try {
      const file = await readJson<{ profiles: ProfileRecord[] }>(path)
      const match = file.profiles.find((p) => partitionForRecord(p) === partition)

      if (match) {
        return match.id
      }
    } catch {
      // unreadable registry — fall through to the partition-derived key
    }
  }

  return partition.replace(/^persist:/, '').replace(/[^a-z0-9._-]+/gi, '-')
}

// Read the user-authored merge table from domains.json (host → canonical surface name).
// Returns an empty object when the file does not exist yet.
const readMerges = async (): Promise<Record<string, string>> => {
  const path = domainsFile()

  if (!existsSync(path)) {
    return {}
  }

  try {
    return await readJson<Record<string, string>>(path)
  } catch {
    return {}
  }
}

// Enumerate every completed run dir under recordingsRoot (dirs that contain a manifest.json).
const listRunDirs = async (): Promise<string[]> => {
  const root = recordingsRoot()

  if (!existsSync(root)) {
    return []
  }

  const entries = await readdir(root, { withFileTypes: true })
  const dirs: string[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const manifestPath = join(root, entry.name, 'manifest.json')

    if (existsSync(manifestPath)) {
      dirs.push(join(root, entry.name))
    }
  }

  return dirs
}

// The run dirs whose recording resolves to one surface within one profile's partition. Reads only the tiny
// manifest per run — the shared filter behind loadSurfaceRuns (full requests) and get-domain (cached profiles).
const matchingSurfaceDirs = async (surface: string, partition: string): Promise<string[]> => {
  const [runDirs, merges] = await Promise.all([listRunDirs(), readMerges()])
  const matching: string[] = []

  for (const dir of runDirs) {
    try {
      const manifest = await readJson<{ startUrl: string; partition?: string; hostCounts?: Record<string, number> }>(
        join(dir, 'manifest.json')
      )

      if (manifest.partition !== partition) {
        continue
      }

      if (resolveSurface(primaryHost(manifest as Parameters<typeof primaryHost>[0]), merges) === surface) {
        matching.push(dir)
      }
    } catch {
      // skip unreadable manifests
    }
  }

  return matching
}

// Load every run (full RunData, with request bodies) for one surface — the source suggest-plugin and
// kickstart-plugin need to mine evidence from. get-domain does NOT use this; it folds from cached profiles.
const loadSurfaceRuns = async (surface: string, partition: string): Promise<RunData[]> =>
  Promise.all((await matchingSurfaceDirs(surface, partition)).map(loadRun))

// ---- handlers ---------------------------------------------------------------

// Register all recorder IPC channels with ipcMain.
export const registerRecorderHandlers = (): void => {
  // List the app's profiles (read from the shared ~/butin/profiles.json) so a recording can target the
  // browser session a given profile uses. Empty when the app has never run (no registry yet) — the dialog
  // then records on the default partition.
  ipcMain.handle('recorder:list-profiles', async (): Promise<ProfileOption[]> => {
    const path = profilesRegistry()

    if (!existsSync(path)) {
      return []
    }

    try {
      const file = await readJson<{ activeProfileId: string; profiles: ProfileRecord[] }>(path)

      return file.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        partition: partitionForRecord(p),
        active: p.id === file.activeProfileId
      }))
    } catch {
      return []
    }
  })

  // The profile the recorder last had selected, so a relaunch reopens it. '' when never set (the renderer then
  // falls back to the app's active profile).
  ipcMain.handle('recorder:get-last-profile', async (): Promise<string> => {
    const path = recorderPrefsFile()

    if (!existsSync(path)) {
      return ''
    }

    try {
      return (await readJson<{ lastProfileId?: string }>(path)).lastProfileId ?? ''
    } catch {
      return ''
    }
  })

  ipcMain.handle('recorder:set-last-profile', async (_event, profileId: string): Promise<void> => {
    await mkdir(recordingsRoot(), { recursive: true })
    await writeFile(recorderPrefsFile(), JSON.stringify({ lastProfileId: profileId }, null, 2))
  })

  // List every surface (grouped + aggregated across runs) for one profile's partition, with a one-line
  // summary. Scoping by partition is what keeps each profile's recordings truly separate in the UI.
  ipcMain.handle('recorder:list-domains', async (_event, partition: string): Promise<DomainSummary[]> => {
    const [runDirs, merges] = await Promise.all([listRunDirs(), readMerges()])

    // Group run dirs by their resolved surface, keeping only runs recorded in the requested partition. The
    // grouping reads only the tiny manifest per run; the classification folds from each run's cached summary.
    const bySurface = new Map<string, { dir: string; startedAt: string }[]>()

    for (const dir of runDirs) {
      try {
        const manifest = await readJson<{
          startUrl: string
          partition?: string
          startedAt?: string
          hostCounts?: Record<string, number>
        }>(join(dir, 'manifest.json'))

        if (manifest.partition !== partition) {
          continue
        }

        const surface = resolveSurface(primaryHost(manifest as Parameters<typeof primaryHost>[0]), merges)

        const existing = bySurface.get(surface) ?? []

        existing.push({ dir, startedAt: manifest.startedAt ?? '' })
        bySurface.set(surface, existing)
      } catch {
        // skip unreadable manifests
      }
    }

    const summaries: DomainSummary[] = []

    for (const [surface, entries] of bySurface) {
      try {
        const profiles = await Promise.all(entries.map((e) => loadRunProfile(e.dir)))
        const profile = foldProfiles(surface, profiles)
        const lastRecordedAt = entries
          .map((e) => e.startedAt)
          .filter(Boolean)
          .sort()
          .at(-1)

        summaries.push({
          surface,
          runCount: profile.runCount,
          authKind: profile.auth.value,
          engine: profile.transport.value.engine,
          lastRecordedAt: lastRecordedAt ?? ''
        })
      } catch {
        // skip surfaces where a run fails to load
      }
    }

    summaries.sort((a, b) => a.surface.localeCompare(b.surface))

    return summaries
  })

  // Return the full aggregated profile + per-run metadata for one surface.
  ipcMain.handle(
    'recorder:get-domain',
    async (
      _event,
      surface: string,
      partition: string
    ): Promise<{
      profile: DomainProfile
      runs: { runId: string; label: string; startUrl: string; startedAt: string; requestCount: number }[]
    }> => {
      // Fold from each run's cached summary + its tiny manifest — no request bodies read, so opening a domain
      // is as fast as the sidebar. suggest/kickstart, which need the full requests, still load them on demand.
      const dirs = await matchingSurfaceDirs(surface, partition)
      const loaded = await Promise.all(
        dirs.map(async (dir) => ({
          manifest: await readJson<RecordingManifest>(join(dir, 'manifest.json')),
          profile: await loadRunProfile(dir)
        }))
      )

      const profile = foldProfiles(
        surface,
        loaded.map((l) => l.profile)
      )

      const runs = loaded.map(({ manifest: m }) => ({
        runId: m.runId,
        label: m.label ?? '',
        startUrl: m.startUrl ?? '',
        startedAt: m.startedAt ?? '',
        requestCount: m.requestCount ?? 0
      }))

      runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))

      return { profile, runs }
    }
  )

  // Open a recorder window for a new recording session. Returns the runId so the renderer can track and
  // later display the recording once the window closes. The capture window's toolbar (the shared magic
  // toolbar, 'record' variant) wires its own controls directly per-webContents, so there's no toolbar IPC
  // to route here anymore.
  ipcMain.handle(
    'recorder:start-recording',
    async (
      event,
      input: { label?: string; startUrl: string; partition?: string; autoRecord?: boolean; isolated?: boolean }
    ): Promise<{ runId: string }> => {
      // Label is optional from the UI; when blank, name the run after the start URL's host.
      const label = input.label?.trim() || domainLabel(input.startUrl)
      // The renderer that started the recording — notified when the capture window closes and the run is
      // saved, so the domain list refreshes without a manual reload. (onStarted only fires at start, before
      // the run dir + manifest exist, so the new domain wouldn't show up.)
      const sender = event.sender

      const handle = await createRecorderWindow({
        label,
        startUrl: input.startUrl,
        partition: input.partition,
        isolated: input.isolated ?? false,
        chromeScopeId: await chromeScopeForPartition(input.partition ?? DEFAULT_PARTITION),
        captureAll: false,
        filters: defaultFilters(),
        // Default on: opening a recording usually means "capture from the first request". Unchecking the
        // dialog's auto-start (or picking the paused Record-again option) opens the window paused so a
        // browser-verification challenge can be cleared with no CDP debugger attached before capture begins.
        autoRecord: input.autoRecord ?? true,
        exportHar: false,
        debug: {
          autoOpenDevTools: false,
          freezeRedirects: false,
          autoPauseOnError: false,
          browserHeaders: true
        },
        icon: '',
        onProgress: () => {},
        onClosed: (h) => {
          if (!sender.isDestroyed()) {
            sender.send('recorder:recording-saved', { runId: h.runId })
          }
        }
      })

      return { runId: handle.runId }
    }
  )

  // Write (or update) a host → surface merge entry in domains.json.
  ipcMain.handle('recorder:merge-surfaces', async (_event, input: { host: string; into: string }): Promise<void> => {
    const merges = await readMerges()

    merges[input.host] = input.into

    await writeFile(domainsFile(), JSON.stringify(merges, null, 2), 'utf8')
  })

  // Open the run folder in the OS file explorer.
  ipcMain.handle('recorder:open-run-folder', async (_event, runId: string): Promise<void> => {
    const dir = join(recordingsRoot(), runId)

    shell.showItemInFolder(dir)
  })

  // Copy a run's absolute folder path to the clipboard (via Electron, so it works regardless of the
  // renderer's clipboard permissions) and return it so the UI can confirm. runId is renderer-supplied;
  // it's only ever joined under recordingsRoot and never touches the filesystem here.
  ipcMain.handle('recorder:copy-run-path', (_event, runId: string): string => {
    const dir = join(recordingsRoot(), runId)

    clipboard.writeText(dir)

    return dir
  })

  // Preview a kickstart for a surface: the suggested id/name/vendor, whether that id collides with an
  // existing plugin, and the capabilities that would be stubbed (with their matched-evidence counts). Writes
  // nothing — it just feeds the Create-plugin dialog so the author can edit before committing.
  ipcMain.handle(
    'recorder:suggest-plugin',
    async (_event, input: { surface: string; partition: string }): Promise<PluginSuggestion> => {
      const runs = await loadSurfaceRuns(input.surface, input.partition)
      const profile = aggregateProfile(input.surface, runs)
      const identity = suggestIdentity(input.surface)
      const capabilities = resolveEvidence(planCapabilities(profile), runs, recordingsRoot())

      return {
        ...identity,
        collision: existsSync(join(resolveRepoRoot(), 'plugins', identity.id, 'main.ts')),
        capabilities: capabilities.map((c) => ({
          capId: c.capId,
          label: c.label,
          category: c.category,
          evidenceCount: c.evidence.length
        }))
      }
    }
  )

  // Kickstart a plugin from a surface's recordings: scaffold a pre-filled plugins/<id>/{main.ts,main.test.ts}
  // (refusing if it exists), write PLUGIN-BRIEF.md into the newest run dir, and copy the kickoff prompt to the
  // clipboard. The id is author-confirmed in the dialog; the plugin path is built under the resolved repo root.
  ipcMain.handle(
    'recorder:kickstart-plugin',
    async (
      _event,
      input: { surface: string; partition: string; id: string; name: string; vendor: string }
    ): Promise<KickstartOutcome> => {
      const repoRoot = resolveRepoRoot()
      const pluginDir = join(repoRoot, 'plugins', input.id)

      if (existsSync(join(pluginDir, 'main.ts'))) {
        throw new Error(`plugins/${input.id}/ already exists — choose a different id.`)
      }

      const runsRoot = recordingsRoot()
      const runs = await loadSurfaceRuns(input.surface, input.partition)

      if (runs.length === 0) {
        throw new Error(`No recordings found for ${input.surface}.`)
      }

      const profile = aggregateProfile(input.surface, runs)
      const result = kickstart({
        surface: input.surface,
        id: input.id,
        name: input.name,
        vendor: input.vendor,
        profile,
        runs,
        repoRoot,
        runsRoot
      })

      await mkdir(pluginDir, { recursive: true })
      await writeFile(join(pluginDir, 'main.ts'), result.mainTs, 'utf8')
      await writeFile(join(pluginDir, 'main.test.ts'), result.testTs, 'utf8')

      const briefPath = join(runsRoot, result.briefRunId, 'PLUGIN-BRIEF.md')

      await writeFile(briefPath, result.brief, 'utf8')
      clipboard.writeText(result.prompt)

      return { pluginPath: join(pluginDir, 'main.ts'), briefPath, prompt: result.prompt }
    }
  )

  // Whether the Butin app is currently running (and which profile it holds open) — the recorder blocks
  // recording that profile, since its browser partition's cookie store can't be opened twice.
  ipcMain.handle('recorder:app-lock-status', (): AppLockStatus => readAppLock())

  // Delete one recording (its whole run dir). runId is renderer-supplied, so deleteRecording guards traversal.
  ipcMain.handle('recorder:delete-recording', async (_event, runId: string): Promise<void> => {
    await deleteRecording(recordingsRoot(), runId)
  })

  // Delete every recording under one surface for one profile's partition — the "delete this whole domain"
  // action. Run dirs come from listRunDirs (trusted), so they're removed directly.
  ipcMain.handle(
    'recorder:delete-domain',
    async (_event, input: { surface: string; partition: string }): Promise<void> => {
      const [runDirs, merges] = await Promise.all([listRunDirs(), readMerges()])

      for (const dir of runDirs) {
        try {
          const manifest = await readJson<{
            startUrl: string
            partition?: string
            hostCounts?: Record<string, number>
          }>(join(dir, 'manifest.json'))

          if (manifest.partition !== input.partition) {
            continue
          }

          if (resolveSurface(primaryHost(manifest as Parameters<typeof primaryHost>[0]), merges) === input.surface) {
            await rm(dir, { recursive: true, force: true })
          }
        } catch {
          // skip unreadable manifests
        }
      }
    }
  )
}

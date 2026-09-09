import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { NavigationLogLine, RecordedRequest, RecordingManifest } from '../main/recording/types.js'

import { profileRun } from './profile.js'
import type { RunData, RunProfile } from './types.js'

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T

const readJsonl = async <T>(path: string): Promise<T[]> => {
  const text = await readFile(path, 'utf8').catch(() => '')

  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

export const loadRun = async (runDir: string): Promise<RunData> => {
  const manifest = await readJson<RecordingManifest>(join(runDir, 'manifest.json'))
  const navigation = await readJsonl<NavigationLogLine>(join(runDir, 'navigation.jsonl'))
  const files = (await readdir(join(runDir, 'requests'))).filter((f) => f.endsWith('.json')).sort()
  const requests = await Promise.all(files.map((f) => readJson<RecordedRequest>(join(runDir, 'requests', f))))

  return { manifest, navigation, requests }
}

// A finished run dir is immutable, so its classification never changes — cache it in `summary.json` beside the
// run and fold from that. `list-domains` / `get-domain` then read a tiny file per run instead of every request
// body (hundreds of MB across a full history), which is what makes startup instant. Bump the version to force a
// recompute when the classifiers change.
const SUMMARY_VERSION = 2

// A recording in progress rewrites its own manifest on a checkpoint interval so the run is listable before it
// ends, so `complete: false` alone doesn't mean nothing more is coming — a run cut short by a crash keeps that
// flag forever and IS final. A manifest whose last checkpoint is well past the interval is one nothing is
// writing to any more, and can be cached like any finished run.
const CHECKPOINT_GRACE_MS = 60_000

const stillRecording = (manifest: RecordingManifest): boolean =>
  manifest.complete === false && Date.now() - Date.parse(manifest.endedAt) < CHECKPOINT_GRACE_MS

interface RunSummary {
  version: number
  profile: RunProfile
}

// Return a run's cached RunProfile, computing it on first read (or after a version bump / a run added on disk
// by another tool) and writing the cache back for every run but one still recording. The full-request read
// happens once per run; every later startup reads only the cached summary. A cache write failure is non-fatal
// — it just recomputes next time.
export const loadRunProfile = async (runDir: string): Promise<RunProfile> => {
  const summaryPath = join(runDir, 'summary.json')

  try {
    const cached = await readJson<RunSummary>(summaryPath)

    if (cached.version === SUMMARY_VERSION) {
      return cached.profile
    }
  } catch {
    // no cache yet, or unreadable/stale — recompute below
  }

  const run = await loadRun(runDir)
  const profile = profileRun(run)

  if (!stillRecording(run.manifest)) {
    await writeFile(summaryPath, JSON.stringify({ version: SUMMARY_VERSION, profile } satisfies RunSummary)).catch(
      () => {}
    )
  }

  return profile
}

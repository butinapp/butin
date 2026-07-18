import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

import { domainLabel, requestRecordFileName, runIdPrefix, runIdSlug, screenshotFileName, wsFileName } from './naming.js'
import sessionGuide from './session-guide.md?raw'
import type {
  NavigationLogLine,
  NetworkLogLine,
  RecordedRequest,
  RecordedWebSocket,
  RecorderLogLine,
  RecordingManifest,
  RecordingSummary
} from './types.js'

export async function ensureSessionsRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
}

export async function ensureRunDir(root: string, runId: string): Promise<string> {
  const runDir = join(root, runId)

  await mkdir(join(runDir, 'requests'), { recursive: true })
  await mkdir(join(runDir, 'websockets'), { recursive: true })
  await mkdir(join(runDir, 'screenshots'), { recursive: true })

  return runDir
}

export async function writeRequestFile(runDir: string, req: RecordedRequest): Promise<string> {
  const name = requestRecordFileName(req)
  const requestsDir = join(runDir, 'requests')

  await mkdir(requestsDir, { recursive: true })
  const fullPath = join(requestsDir, name)

  await writeFile(fullPath, JSON.stringify(req, null, 2), 'utf8')

  return fullPath
}

export async function writeWebSocketFile(runDir: string, ws: RecordedWebSocket): Promise<string> {
  const name = wsFileName(ws.index, ws.url)
  const dir = join(runDir, 'websockets')

  await mkdir(dir, { recursive: true })
  const fullPath = join(dir, name)

  await writeFile(fullPath, JSON.stringify(ws, null, 2), 'utf8')

  return fullPath
}

export async function writeScreenshot(runDir: string, index: number, url: string, png: Buffer): Promise<void> {
  const dir = join(runDir, 'screenshots')

  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, screenshotFileName(index, url)), png)
}

export async function appendNetworkLog(runDir: string, line: NetworkLogLine): Promise<void> {
  await appendFile(join(runDir, 'network.jsonl'), `${JSON.stringify(line)}\n`, 'utf8')
}

export async function appendNavigationLog(runDir: string, line: NavigationLogLine): Promise<void> {
  await appendFile(join(runDir, 'navigation.jsonl'), `${JSON.stringify(line)}\n`, 'utf8')
}

// A marker line in network.jsonl recording a pause/resume — lets an agent see
// where the user's deliberate action begins versus earlier exploratory clicking.
export async function appendNetworkMarker(runDir: string, marker: 'pause' | 'resume'): Promise<void> {
  await appendFile(
    join(runDir, 'network.jsonl'),
    `${JSON.stringify({ marker, ts: new Date().toISOString() })}\n`,
    'utf8'
  )
}

// A line in log.jsonl — the run's diagnostic trace (navigations, load failures, pause/resume, errors).
export async function appendRunLog(runDir: string, line: RecorderLogLine): Promise<void> {
  await appendFile(join(runDir, 'log.jsonl'), `${JSON.stringify(line)}\n`, 'utf8')
}

export async function writeRunSummary(runDir: string, markdown: string): Promise<void> {
  await writeFile(join(runDir, 'summary.md'), markdown, 'utf8')
}

export async function writeManifest(runDir: string, manifest: RecordingManifest): Promise<void> {
  await writeFile(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
}

// The structured list of detected downloadable documents (PDF invoices/statements) for this run — the
// machine-readable companion to the "Detected downloads" section of summary.md.
export async function writeDownloads(runDir: string, downloads: unknown): Promise<void> {
  await writeFile(join(runDir, 'downloads.json'), JSON.stringify(downloads, null, 2), 'utf8')
}

export async function writeCookies(runDir: string, cookies: unknown): Promise<void> {
  await writeFile(join(runDir, 'cookies.json'), JSON.stringify(cookies, null, 2), 'utf8')
}

export async function writeStorageSnapshot(runDir: string, storage: unknown): Promise<void> {
  await writeFile(join(runDir, 'storage.json'), JSON.stringify(storage, null, 2), 'utf8')
}

// Copies the agent reading guide into the run as AGENTS.md so any AI agent pointed
// at the folder is auto-briefed on how to interpret the captured data.
export async function writeSessionGuide(runDir: string): Promise<void> {
  await writeFile(join(runDir, 'AGENTS.md'), sessionGuide, 'utf8')
}

export async function listRecordings(root: string): Promise<RecordingSummary[]> {
  if (!existsSync(root)) {
    return []
  }

  const entries = await readdir(root, { withFileTypes: true })
  const summaries: RecordingSummary[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const manifestPath = join(root, entry.name, 'manifest.json')

    if (!existsSync(manifestPath)) {
      continue
    }

    try {
      const raw = await readFile(manifestPath, 'utf8')
      const m = JSON.parse(raw)

      let host

      try {
        host = new URL(m.startUrl ?? '').hostname.replace(/^www\./, '') || undefined
      } catch {
        host = undefined
      }

      summaries.push({
        runId: m.runId ?? entry.name,
        label: m.label ?? entry.name,
        startedAt: m.startedAt ?? new Date(0).toISOString(),
        requestCount: m.requestCount ?? 0,
        webSocketCount: m.webSocketCount ?? 0,
        host
      })
    } catch {
      // skip corrupt manifests
    }
  }

  summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt))

  return summaries
}

export async function deleteRecording(root: string, runId: string): Promise<void> {
  if (runId.includes('/') || runId.includes('\\') || runId.includes('..')) {
    throw new Error(`invalid runId: ${runId}`)
  }

  await rm(join(root, runId), { recursive: true, force: true })
}

// Renames a recording: updates the manifest label and re-slugs the run folder,
// keeping the original timestamp prefix. An empty name falls back to the host of
// the recorded start URL. Returns the (possibly new) runId so callers can re-point.
export async function renameRecording(
  root: string,
  runId: string,
  newLabel: string
): Promise<{ runId: string; label: string }> {
  if (runId.includes('/') || runId.includes('\\') || runId.includes('..')) {
    throw new Error(`invalid runId: ${runId}`)
  }

  const dir = join(root, runId)
  const manifestPath = join(dir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

  const label = newLabel.trim() || domainLabel(manifest.startUrl ?? '')

  let target = `${runIdPrefix(runId)}_${runIdSlug(label)}`

  if (target !== runId) {
    let n = 2

    while (existsSync(join(root, target))) {
      target = `${runIdPrefix(runId)}_${runIdSlug(label)}-${n++}`
    }
  }

  manifest.label = label
  manifest.runId = target
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  if (target !== runId) {
    await rename(dir, join(root, target))
  }

  return { runId: target, label }
}

import type { ExportBundle } from '@butinapp/shapes/bundle'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { readBytes, writeBytes } from './secure-fs.js'
import { dataRootDir } from './store.js'

// The pluggable destination an export bundle lands in. Callers talk only to this interface — swapping
// deployment (local file → hosted blob → company endpoint) swaps the implementation, nothing else.
export type BundleRef = { id: string; path?: string; createdAt: string }

export interface ReportStore {
  put(bundle: ExportBundle): Promise<BundleRef>
  list(): Promise<BundleRef[]>
  get(ref: BundleRef): Promise<ExportBundle>
}

// Where file-based exports live: ~/butin/<profile>/exports/ (profile-scoped via the shared data root).
const exportsDir = (): string => join(dataRootDir(), 'exports')

// A filesystem ReportStore: each put() writes one timestamped bundle JSON into the exports folder. I/O flows
// through secure-fs against the active profile's data root, so the bundle is sealed on an encrypted profile and
// plaintext on an OFF one — transparently. The id is the filename stem, so list()/get() round-trip by name.
export class FileReportStore implements ReportStore {
  async put(bundle: ExportBundle): Promise<BundleRef> {
    const createdAt = new Date().toISOString()
    const id = `snapshot-${createdAt.replace(/[:.]/g, '-')}`
    const path = join(exportsDir(), `${id}.json`)

    await writeBytes(dataRootDir(), path, Buffer.from(JSON.stringify(bundle, null, 2), 'utf8'))

    return { id, path, createdAt }
  }

  async list(): Promise<BundleRef[]> {
    let files: string[]

    try {
      files = await readdir(exportsDir())
    } catch {
      return [] // no exports yet
    }

    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const id = f.slice(0, -'.json'.length)

        return { id, path: join(exportsDir(), f), createdAt: id.replace(/^snapshot-/, '') }
      })
      .sort((a, b) => b.id.localeCompare(a.id)) // newest first
  }

  async get(ref: BundleRef): Promise<ExportBundle> {
    const path = ref.path ?? join(exportsDir(), `${ref.id}.json`)
    const raw = await readBytes(dataRootDir(), path)

    if (raw === null) {
      throw new Error(`export bundle not found or unreadable: ${path}`)
    }

    return JSON.parse(raw.toString('utf8')) as ExportBundle
  }
}

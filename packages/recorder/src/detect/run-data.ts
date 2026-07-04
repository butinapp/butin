import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { NavigationLogLine, RecordedRequest, RecordingManifest } from '../main/recording/types.js'

import type { RunData } from './types.js'

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

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadRun, loadRunProfile } from './run-data.js'

const writeRun = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'run-'))

  mkdirSync(join(dir, 'requests'))
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      runId: 'r',
      label: 'x',
      startUrl: 'https://a.com',
      partition: 'persist:butin',
      captureAll: false,
      startedAt: '',
      endedAt: '',
      requestCount: 1,
      navigationCount: 0
    })
  )
  writeFileSync(join(dir, 'navigation.jsonl'), '')
  writeFileSync(
    join(dir, 'requests', '0001.json'),
    JSON.stringify({
      index: 1,
      timestamp: '',
      type: 'XHR',
      request: { url: 'https://a.com/api', method: 'GET', headers: {}, body: null },
      response: { status: 200, headers: {}, body: '', base64Encoded: false, mimeType: 'application/json' },
      timing: { requestSentMs: 0, responseReceivedMs: 1 }
    })
  )

  return dir
}

describe('loadRun', () => {
  it('reads the manifest and every request record', async () => {
    const run = await loadRun(writeRun())

    expect(run.manifest.startUrl).toBe('https://a.com')
    expect(run.requests).toHaveLength(1)
    expect(run.requests[0].request.url).toBe('https://a.com/api')
  })
})

describe('loadRunProfile', () => {
  it('computes and caches summary.json on first read, then folds from the cache', async () => {
    const dir = writeRun()

    expect(existsSync(join(dir, 'summary.json'))).toBe(false)

    const first = await loadRunProfile(dir)

    // The write-back cache now exists and holds the same classification.
    expect(existsSync(join(dir, 'summary.json'))).toBe(true)
    expect(first.auth.value).toBe('external')

    // Second read serves the cache — proven by deleting the requests so a recompute could not succeed.
    rmSync(join(dir, 'requests'), { recursive: true, force: true })

    const cached = await loadRunProfile(dir)

    expect(cached.auth.value).toBe('external')
  })

  it('recomputes when the cached summary is a stale version', async () => {
    const dir = writeRun()

    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ version: 0, profile: { auth: { value: 'bogus' } } }))

    const profile = await loadRunProfile(dir)

    expect(profile.auth.value).toBe('external')
    expect(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).version).toBe(2)
  })
})

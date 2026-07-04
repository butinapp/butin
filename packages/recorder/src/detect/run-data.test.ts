import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadRun } from './run-data.js'

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

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { renameRecording } from './storage.js'

async function seedRun(root: string, runId: string, label: string, startUrl: string) {
  const dir = join(root, runId)

  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ runId, label, startUrl }), 'utf8')
}

async function readLabel(root: string, runId: string) {
  return JSON.parse(await readFile(join(root, runId, 'manifest.json'), 'utf8'))
}

describe('renameRecording', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'butin-rec-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('re-slugs the folder and updates the manifest, keeping the timestamp prefix', async () => {
    await seedRun(root, '2026-05-26_14h07_old-name', 'old name', 'https://x.com')
    const res = await renameRecording(root, '2026-05-26_14h07_old-name', 'New Shiny Name')

    expect(res.runId).toBe('2026-05-26_14h07_new-shiny-name')
    expect(res.label).toBe('New Shiny Name')
    expect(existsSync(join(root, '2026-05-26_14h07_old-name'))).toBe(false)
    expect(existsSync(join(root, '2026-05-26_14h07_new-shiny-name'))).toBe(true)

    const m = await readLabel(root, res.runId)

    expect(m.label).toBe('New Shiny Name')
    expect(m.runId).toBe(res.runId)
  })

  it('falls back to the start-URL host when the name is blank', async () => {
    await seedRun(root, '2026-05-26_14h07_old', 'old', 'https://www.api.example.com/v2')
    const res = await renameRecording(root, '2026-05-26_14h07_old', '   ')

    expect(res.label).toBe('api.example.com')
    expect(res.runId).toBe('2026-05-26_14h07_api-example-com')
  })

  it('updates the label in place when the slug is unchanged', async () => {
    await seedRun(root, '2026-05-26_14h07_same', 'same', 'https://x.com')
    const res = await renameRecording(root, '2026-05-26_14h07_same', 'SAME')

    // "SAME" slugs back to "same", so no folder move.
    expect(res.runId).toBe('2026-05-26_14h07_same')
    expect((await readLabel(root, res.runId)).label).toBe('SAME')
  })

  it('avoids clobbering an existing folder on collision', async () => {
    await seedRun(root, '2026-05-26_14h07_a', 'a', 'https://x.com')
    await seedRun(root, '2026-05-26_14h07_target', 'target', 'https://x.com')
    const res = await renameRecording(root, '2026-05-26_14h07_a', 'target')

    expect(res.runId).toBe('2026-05-26_14h07_target-2')
    expect(existsSync(join(root, '2026-05-26_14h07_target'))).toBe(true)
    expect(existsSync(join(root, '2026-05-26_14h07_target-2'))).toBe(true)
  })
})

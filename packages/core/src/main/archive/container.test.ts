import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { setScryptParamsForTest } from '../vault/vault.js'

import { archiveErrorCode, type ArchiveSource, openArchive, writeArchive } from './container.js'

// Cheap KDF so the suite isn't dominated by scrypt.
setScryptParamsForTest({ N: 2 ** 8, r: 8, p: 1 })

const dirs: string[] = []

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'butin-archive-'))

  dirs.push(dir)

  return dir
}

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const source = (path: string, bytes: Buffer): ArchiveSource => ({
  path,
  size: bytes.length,
  open: async function* () {
    yield bytes
  }
})

const META = {
  profile: { name: 'Personal', color: '#6366f1', createdAt: '2026-01-01T00:00:00.000Z' },
  appVersion: '0.1.1'
}

const collect = async (path: string, secret: string): Promise<Record<string, Buffer>> => {
  const reader = await openArchive(path, secret)
  const out: Record<string, Buffer> = {}

  for await (const { entry, chunks } of reader.entries()) {
    const parts: Buffer[] = []

    for await (const chunk of chunks) {
      parts.push(chunk)
    }

    out[entry.path] = Buffer.concat(parts)
  }

  await reader.close()

  return out
}

describe('profile archive container', () => {
  const files = {
    'config.json': Buffer.from('{"plugins":{}}'),
    'empty.bin': Buffer.alloc(0),
    // Spans several 4 MiB chunks, so the re-chunking + per-chunk sealing is exercised, not just a single frame.
    'claude/documents/big.pdf': Buffer.alloc(9 * 1024 * 1024, 7)
  }
  const sources = Object.entries(files).map(([path, bytes]) => source(path, bytes))
  const total = Object.values(files).reduce((sum, b) => sum + b.length, 0)

  it('round-trips every entry byte for byte', async () => {
    const target = join(tempDir(), 'p.butin')

    await writeArchive(target, 'hunter2', META, sources, total)

    const got = await collect(target, 'hunter2')

    expect(Object.keys(got).sort()).toEqual(Object.keys(files).sort())

    for (const [path, bytes] of Object.entries(files)) {
      expect(got[path]!.equals(bytes)).toBe(true)
    }
  })

  it('records the profile, sizes and hashes in the index', async () => {
    const target = join(tempDir(), 'p.butin')

    await writeArchive(target, 'hunter2', META, sources, total)

    const reader = await openArchive(target, 'hunter2')

    expect(reader.index.profile.name).toBe('Personal')
    expect(reader.index.appVersion).toBe('0.1.1')
    expect(reader.index.totalBytes).toBe(total)
    expect(reader.index.entries.find((e) => e.path === 'empty.bin')).toMatchObject({ size: 0, chunks: 0 })
    expect(reader.index.entries.find((e) => e.path === 'claude/documents/big.pdf')?.chunks).toBe(3)
    await reader.close()
  })

  it('opens with the recovery code as well as the passphrase', async () => {
    const target = join(tempDir(), 'p.butin')
    const { recoveryCode } = await writeArchive(target, 'hunter2', META, sources, total)

    expect(recoveryCode).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/)

    const got = await collect(target, recoveryCode.toLowerCase())

    expect(got['config.json']!.equals(files['config.json'])).toBe(true)
  })

  it('refuses a wrong secret', async () => {
    const target = join(tempDir(), 'p.butin')

    await writeArchive(target, 'hunter2', META, sources, total)

    await expect(openArchive(target, 'nope')).rejects.toSatisfy((e) => archiveErrorCode(e) === 'wrong-secret')
  })

  it('refuses a file that is not an archive', async () => {
    const target = join(tempDir(), 'random.bin')

    writeFileSync(target, Buffer.alloc(4096, 3))

    await expect(openArchive(target, 'hunter2')).rejects.toSatisfy((e) => archiveErrorCode(e) === 'not-an-archive')
  })

  it('refuses an archive whose trailer never landed', async () => {
    const target = join(tempDir(), 'p.butin')

    await writeArchive(target, 'hunter2', META, sources, total)
    truncateSync(target, readFileSync(target).length - 4)

    await expect(openArchive(target, 'hunter2')).rejects.toSatisfy((e) => archiveErrorCode(e) === 'unfinished')
  })

  it('refuses a format version it does not know', async () => {
    const target = join(tempDir(), 'p.butin')

    await writeArchive(target, 'hunter2', META, sources, total)

    const raw = readFileSync(target)

    raw[4] = 99
    writeFileSync(target, raw)

    await expect(openArchive(target, 'hunter2')).rejects.toSatisfy((e) => archiveErrorCode(e) === 'format-too-new')
  })

  it('fails a chunk whose bytes were altered', async () => {
    const target = join(tempDir(), 'p.butin')

    await writeArchive(target, 'hunter2', META, [source('config.json', files['config.json'])], 14)

    const raw = readFileSync(target)
    // First chunk's ciphertext: past the preamble + header frame, then past the frame length and the sealed
    // envelope's magic/version/iv/tag. Flipping here proves the CHUNK's tag catches it, not the index's.
    const at = 9 + raw.readUInt32LE(5) + 4 + 33

    raw[at] = raw[at]! ^ 0xff
    writeFileSync(target, raw)

    await expect(collect(target, 'hunter2')).rejects.toSatisfy((e) => archiveErrorCode(e) === 'corrupt')
  })

  it('leaves no file behind when packing fails midway', async () => {
    const dir = tempDir()
    const target = join(dir, 'p.butin')
    const exploding: ArchiveSource = {
      path: 'boom.bin',
      size: 1,
      open: async function* () {
        yield Buffer.from('x')
        throw new Error('disk went away')
      }
    }

    await expect(writeArchive(target, 'hunter2', META, [exploding], 1)).rejects.toThrow('disk went away')
    expect(() => readFileSync(target)).toThrow()
    expect(() => readFileSync(`${target}.partial`)).toThrow()
  })
})

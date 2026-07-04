import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { setConfigRoot } from './config-file.js'
import { authSummary, computeFolderStats, getFolderStats, serviceMechanics } from './service-detail.js'
import { setDataRoot } from './store.js'

describe('authSummary', () => {
  it('returns a plain sentence for every auth kind', () => {
    for (const kind of [
      'cookie',
      'bearer-token',
      'external',
      'api-key',
      'cookie-csrf',
      'minted-jwt',
      'rotating-refresh',
      'spa-bearer'
    ] as const) {
      expect(authSummary(kind)).toMatch(/\w/)
    }
  })

  it('external explains there is no stored session', () => {
    expect(authSummary('external')).toMatch(/no login session/i)
  })
})

describe('serviceMechanics', () => {
  it('reads kind, transport, and the session surface off the descriptor', () => {
    const m = serviceMechanics({
      auth: { kind: 'cookie' },
      transport: { engine: 'node' },
      session: { loginUrl: 'https://x.com/login', cookieDomains: ['x.com'], requiredCookie: 'sid' },
      meta: { category: 'devtools', homepage: 'https://x.com', version: '0.1.0' }
    })

    expect(m).toMatchObject({
      authKind: 'cookie',
      transportEngine: 'node',
      requiresBrowserEngine: false,
      cookieDomains: ['x.com'],
      loginUrl: 'https://x.com/login',
      requiredCookie: 'sid',
      category: 'devtools',
      version: '0.1.0'
    })
    expect(m.authSummary).toBe(authSummary('cookie'))
  })

  it('requiresBrowserEngine forces the electron transport regardless of declared engine', () => {
    const m = serviceMechanics({
      auth: { kind: 'cookie' },
      transport: { engine: 'node', requiresBrowserEngine: true },
      meta: {}
    })

    expect(m.transportEngine).toBe('electron')
    expect(m.requiresBrowserEngine).toBe(true)
  })

  it('defaults engine to node and cookie domains to empty when undeclared', () => {
    const m = serviceMechanics({ auth: { kind: 'external' }, meta: {} })

    expect(m.transportEngine).toBe('node')
    expect(m.cookieDomains).toEqual([])
    expect(m.loginUrl).toBeUndefined()
  })
})

describe('computeFolderStats', () => {
  let dir: string

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('totals files + bytes recursively, skipping directories', async () => {
    dir = await mkdtemp(join(tmpdir(), 'butin-stats-'))
    await writeFile(join(dir, 'a.json'), 'xxxxx') // 5 bytes
    await mkdir(join(dir, 'reports'), { recursive: true })
    await writeFile(join(dir, 'reports', 'b.json'), 'xxxxxxxxxx') // 10 bytes

    expect(await computeFolderStats(dir)).toEqual({ fileCount: 2, totalBytes: 15 })
  })

  it('returns zeroes for a folder that does not exist', async () => {
    expect(await computeFolderStats(join(tmpdir(), 'butin-nope-does-not-exist-xyz'))).toEqual({
      fileCount: 0,
      totalBytes: 0
    })
  })
})

describe('getFolderStats', () => {
  let dir: string

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('counts the whole folder for fileCount, but only the documents subfolder for documentCount', async () => {
    dir = await mkdtemp(join(tmpdir(), 'butin-folder-'))
    setDataRoot(dir)
    setConfigRoot(dir) // no documentsOutputDir override → documents default under the service folder

    const svc = join(dir, 'claude')

    await mkdir(join(svc, 'current'), { recursive: true })
    await writeFile(join(svc, 'current', 'billing.json'), '{}')
    await mkdir(join(svc, 'documents'), { recursive: true })
    await writeFile(join(svc, 'documents', 'a.pdf'), 'xx')
    await writeFile(join(svc, 'documents', 'b.pdf'), 'yy')

    expect(await getFolderStats('claude')).toEqual({ fileCount: 3, totalBytes: 6, documentCount: 2 })
  })

  it('reports zero documents when nothing has been downloaded', async () => {
    dir = await mkdtemp(join(tmpdir(), 'butin-folder-'))
    setDataRoot(dir)
    setConfigRoot(dir)

    await mkdir(join(dir, 'claude', 'current'), { recursive: true })
    await writeFile(join(dir, 'claude', 'current', 'billing.json'), '{}')

    expect(await getFolderStats('claude')).toMatchObject({ documentCount: 0 })
  })
})

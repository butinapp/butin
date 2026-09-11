import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { createProfile, listProfiles, profileDir, setProfilesRoot } from '../store/profiles.js'
import { setScryptParamsForTest, setupVault } from '../vault/vault.js'

import { type ArchiveSource, writeArchive } from './container.js'
import { exportProfileArchive } from './export-profile.js'
import { importProfileArchive, inspectProfileArchive } from './import-profile.js'

// Cheap KDF so the suite isn't dominated by scrypt.
setScryptParamsForTest({ N: 2 ** 8, r: 8, p: 1 })

const dirs: string[] = []

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))

  dirs.push(dir)

  return dir
}

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const write = (path: string, body: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

// A profile with a stored session, a cached report, a downloaded document and a profile-root file — one of
// everything the tree can hold.
const seedProfile = (id: string, extra?: (dir: string) => void): string => {
  const dir = profileDir(id)

  write(
    join(dir, 'config.json'),
    JSON.stringify({
      plugins: {
        claude: { cookie: 'sessionKey=abc123', cookie_enc: false, enabled: true, config: { orgId: 'o-1' } },
        serper: { apiToken: 'tok-9', apiToken_enc: false, enabled: true }
      },
      tablePrefs: { 'claude.billing': { pageSize: 50 } },
      settings: { startPage: 'overview' }
    })
  )
  write(join(dir, 'fx.json'), '{"base":"CAD"}')
  write(join(dir, 'claude', 'current', 'billing.json'), '{"pluginId":"claude"}')
  write(join(dir, 'claude', 'ledger', 'billing.json'), '{"rows":[]}')
  write(join(dir, 'claude', 'documents', 'invoice-01.pdf'), '%PDF-1.4 first')
  extra?.(dir)

  return dir
}

const APP_VERSION = '0.1.1'

let home: string

beforeEach(() => {
  home = tempDir('butin-home-')
  setProfilesRoot(home)
})

describe('profile export → import', () => {
  it('round-trips the whole tree into a new profile', async () => {
    const source = createProfile('Work')

    seedProfile(source.id)

    const target = join(tempDir('butin-out-'), 'work.butin')
    const exported = await exportProfileArchive(source.id, target, 'hunter2', APP_VERSION)

    expect(exported.fileCount).toBe(5)
    expect(exported.recoveryCode).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/)

    const imported = await importProfileArchive(target, 'hunter2')

    expect(imported.services).toEqual(['claude'])
    // The source 'Work' is still here, so the copy takes a name that is visibly its own — the slug alone
    // wouldn't do, since the app shows only the name.
    expect(imported.profileName).toBe('Work (imported)')
    expect(imported.profile.id).toBe('work-imported')
    expect(imported.profile.active).toBe(false)
    expect(
      listProfiles()
        .map((p) => p.id)
        .sort()
    ).toEqual(['personal', 'work', 'work-imported'])

    const landed = profileDir(imported.profile.id)

    expect(readFileSync(join(landed, 'claude', 'documents', 'invoice-01.pdf'), 'utf8')).toBe('%PDF-1.4 first')
    expect(readFileSync(join(landed, 'claude', 'ledger', 'billing.json'), 'utf8')).toBe('{"rows":[]}')
    expect(readFileSync(join(landed, 'fx.json'), 'utf8')).toBe('{"base":"CAD"}')
  })

  it('carries the stored session across and re-keys it on the way in', async () => {
    const source = createProfile('Work')

    seedProfile(source.id)

    const target = join(tempDir('butin-out-'), 'work.butin')

    await exportProfileArchive(source.id, target, 'hunter2', APP_VERSION)

    const imported = await importProfileArchive(target, 'hunter2')
    const config = JSON.parse(readFileSync(join(profileDir(imported.profile.id), 'config.json'), 'utf8')) as {
      plugins: Record<string, Record<string, unknown>>
      tablePrefs: Record<string, unknown>
      settings: Record<string, unknown>
    }

    // The secret itself survives — that is the whole point of the re-keying — and it is stored under this
    // machine's key, never the source machine's. Off-Electron there is no safeStorage, so `enc` is false.
    expect(config.plugins.claude!.cookie).toBe('sessionKey=abc123')
    expect(config.plugins.claude!.cookie_enc).toBe(false)
    expect(config.plugins.serper!.apiToken).toBe('tok-9')
    // Everything else on the entry travels untouched.
    expect(config.plugins.claude!.config).toEqual({ orgId: 'o-1' })
    expect(config.tablePrefs).toEqual({ 'claude.billing': { pageSize: 50 } })
    expect(config.settings).toEqual({ startPage: 'overview' })
  })

  it('packs a documents folder that lives outside the profile and re-homes it', async () => {
    const outside = tempDir('butin-docs-')
    const source = createProfile('Work')

    write(join(outside, 'statement-may.pdf'), '%PDF outside')
    seedProfile(source.id, (dir) => {
      const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
        plugins: Record<string, Record<string, unknown>>
      }

      config.plugins.claude!.documentsOutputDir = outside
      writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
    })

    const target = join(tempDir('butin-out-'), 'work.butin')
    const exported = await exportProfileArchive(source.id, target, 'hunter2', APP_VERSION)

    expect(exported.reHomed).toEqual(['claude'])

    const imported = await importProfileArchive(target, 'hunter2')
    const landed = profileDir(imported.profile.id)

    expect(imported.reHomed).toEqual(['claude'])
    expect(readFileSync(join(landed, 'claude', 'documents', 'statement-may.pdf'), 'utf8')).toBe('%PDF outside')
    // The in-tree document is still there beside it, and the override is gone — the source path may not exist here.
    expect(readFileSync(join(landed, 'claude', 'documents', 'invoice-01.pdf'), 'utf8')).toBe('%PDF-1.4 first')
    expect(
      (JSON.parse(readFileSync(join(landed, 'config.json'), 'utf8')) as { plugins: Record<string, object> }).plugins
        .claude
    ).not.toHaveProperty('documentsOutputDir')
  })

  it('never packs the vault record', async () => {
    const source = createProfile('Work')
    const dir = seedProfile(source.id)

    setupVault(dir, 'vault-pw')

    const target = join(tempDir('butin-out-'), 'work.butin')

    await exportProfileArchive(source.id, target, 'hunter2', APP_VERSION)

    const preview = await inspectProfileArchive(target, 'hunter2')

    expect(preview.sourceEncrypted).toBe(true)

    const imported = await importProfileArchive(target, 'hunter2')

    // The copy lands unencrypted — encryption at rest is a choice the receiving machine makes for itself.
    expect(existsSync(join(profileDir(imported.profile.id), 'vault.json'))).toBe(false)
    expect(imported.profile.encryption).toBe('off')
  })

  it('refuses to export a locked profile', async () => {
    const source = createProfile('Work')
    const dir = seedProfile(source.id)

    setupVault(dir, 'vault-pw')
    // Lock it by dropping the in-memory key the way the idle lock does.
    const { lockVault } = await import('../vault/vault.js')

    lockVault(dir)

    const target = join(tempDir('butin-out-'), 'work.butin')

    await expect(exportProfileArchive(source.id, target, 'hunter2', APP_VERSION)).rejects.toThrow(/unlock this profile/)
    expect(existsSync(target)).toBe(false)
  })

  it('never lands a profile the user cannot tell apart from an existing one', async () => {
    // Exporting and re-importing on the SAME machine is the sharpest case: the archived name is already taken,
    // and the slug that disambiguates it is invisible in the app.
    seedProfile('personal')

    const target = join(tempDir('butin-out-'), 'personal.butin')

    await exportProfileArchive('personal', target, 'hunter2', APP_VERSION)

    const imported = await importProfileArchive(target, 'hunter2')

    expect(imported.profile.name).toBe('Personal (imported)')
    expect(imported.profileName).toBe('Personal (imported)')
    expect(new Set(listProfiles().map((p) => p.name)).size).toBe(listProfiles().length)
  })

  it('imports under the name the user chose', async () => {
    seedProfile('personal')

    const target = join(tempDir('butin-out-'), 'personal.butin')

    await exportProfileArchive('personal', target, 'hunter2', APP_VERSION)

    const imported = await importProfileArchive(target, 'hunter2', { name: 'Old laptop' })

    expect(imported.profile.name).toBe('Old laptop')
    expect(imported.profile.id).toBe('old-laptop')
    // The rename is cosmetic — the data still arrives whole.
    expect(readFileSync(join(profileDir(imported.profile.id), 'fx.json'), 'utf8')).toBe('{"base":"CAD"}')
  })

  it('previews an archive without writing anything', async () => {
    const source = createProfile('Work')

    seedProfile(source.id)

    const target = join(tempDir('butin-out-'), 'work.butin')

    await exportProfileArchive(source.id, target, 'hunter2', APP_VERSION)

    const before = listProfiles().length
    const preview = await inspectProfileArchive(target, 'hunter2')

    expect(preview).toMatchObject({ profileName: 'Work', appVersion: APP_VERSION, fileCount: 5, services: ['claude'] })
    expect(listProfiles()).toHaveLength(before)
  })

  it('refuses an archive whose paths escape the profile, leaving nothing behind', async () => {
    const target = join(tempDir('butin-out-'), 'evil.butin')
    const evil: ArchiveSource = {
      path: '../../escaped.txt',
      size: 3,
      open: async function* () {
        yield Buffer.from('bad')
      }
    }

    await writeArchive(
      target,
      'hunter2',
      { profile: { name: 'Evil', createdAt: '2026-01-01T00:00:00.000Z' }, appVersion: APP_VERSION },
      [evil],
      3
    )

    const before = listProfiles().length

    await expect(importProfileArchive(target, 'hunter2')).rejects.toThrow(/unsafe path/)
    expect(listProfiles()).toHaveLength(before)
    expect(readdirSync(join(home, 'profiles')).filter((n) => n.startsWith('.import-'))).toEqual([])
  })
})

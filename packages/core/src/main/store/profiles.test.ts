import type { ButinPlugin } from '@butinapp/sdk'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { activePartition, setActivePartition } from '../browser/shared-session.js'
import { lockAll, lockVault, setScryptParamsForTest, setupVault } from '../vault/vault.js'

import { readConfigAt, writeConfigAt } from './config-file.js'
import {
  applyActiveProfile,
  createProfile,
  deleteProfile,
  duplicateProfile,
  ensureProfilesInitialized,
  getActiveProfileId,
  listProfiles,
  movePluginToProfile,
  profileDir,
  recolorProfile,
  renameProfile,
  setActiveProfile,
  setProfilesRoot
} from './profiles.js'
import { readBytesSync, writeBytesSync } from './secure-fs.js'
import { dataRootDir, setDataRoot } from './store.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'butin-profiles-'))
  setProfilesRoot(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('profile registry', () => {
  it('creates a default profile on first read', () => {
    const profiles = listProfiles()

    expect(profiles).toHaveLength(1)
    expect(profiles[0]!.id).toBe('personal')
    expect(profiles[0]!.active).toBe(true)
    expect(getActiveProfileId()).toBe('personal')
  })

  it('creates a profile with a slugged id and a folder', () => {
    const created = createProfile('My Work')

    expect(created.id).toBe('my-work')
    expect(existsSync(profileDir('my-work'))).toBe(true)
    expect(listProfiles().map((p) => p.id)).toContain('my-work')
  })

  it('suffixes a colliding slug', () => {
    createProfile('Work')
    const second = createProfile('Work')

    expect(second.id).toBe('work-2')
  })

  it('renames without moving the folder', () => {
    const { id } = createProfile('Side')

    renameProfile(id, 'Side Project')

    expect(existsSync(profileDir(id))).toBe(true)
    expect(listProfiles().find((p) => p.id === id)!.name).toBe('Side Project')
  })

  it('switches the active profile', () => {
    const { id } = createProfile('Work')

    setActiveProfile(id)

    expect(getActiveProfileId()).toBe(id)
    expect(listProfiles().find((p) => p.active)!.id).toBe(id)
  })

  it('deletes a profile and removes its folder', () => {
    const { id } = createProfile('Temp')

    deleteProfile(id)

    expect(existsSync(profileDir(id))).toBe(false)
    expect(listProfiles().map((p) => p.id)).not.toContain(id)
  })

  it('refuses to delete the last remaining profile', () => {
    expect(() => deleteProfile('personal')).toThrow(/last profile/i)
  })

  it('recolors a profile in place', () => {
    const { id } = createProfile('Work')

    recolorProfile(id, '#ff5500')

    expect(listProfiles().find((p) => p.id === id)!.color).toBe('#ff5500')
  })

  it('falls back to the first remaining profile when the active one is deleted', () => {
    const { id } = createProfile('Work')

    setActiveProfile(id)
    deleteProfile(id)

    expect(getActiveProfileId()).toBe('personal')
  })
})

// The registry descriptor a move needs: its id, and the auth kind that decides what "connected" means.
const sentry = { meta: { id: 'sentry', name: 'Sentry' }, auth: { kind: 'cookie' } } as unknown as ButinPlugin

describe('movePluginToProfile', () => {
  // Seed the source profile with a plugin's full footprint: a config entry (stored session + enabled), a table pref
  // keyed `<id>.<cap>`, and a data folder with a cached report.
  const seedPlugin = async (profileId: string): Promise<void> => {
    const dir = profileDir(profileId)

    // writeConfigAt creates the profile dir; then drop a cached report into the plugin's data folder.
    writeConfigAt(dir, {
      plugins: { sentry: { enabled: true, cookie: 'enc-bytes', cookie_enc: true } },
      tablePrefs: { 'sentry.usage': { pageSize: 50 }, 'github.usage': { pageSize: 10 } }
    })
    await mkdir(join(dir, 'sentry', 'reports'), { recursive: true })
    await writeFile(join(dir, 'sentry', 'reports', 'usage.json'), '{"ok":true}')
  }

  beforeEach(() => {
    listProfiles() // seed `personal`
    createProfile('Work') // → id `work`
  })

  it('relocates the config entry, table prefs, and data folder to the target', async () => {
    await seedPlugin('personal')

    const res = movePluginToProfile(sentry, 'personal', 'work')

    expect(res.ok).toBe(true)

    const from = readConfigAt(profileDir('personal'))
    const to = readConfigAt(profileDir('work'))

    // config entry moved verbatim (encrypted bytes intact — no re-encryption)…
    expect(from.plugins.sentry).toBeUndefined()
    expect(to.plugins.sentry).toEqual({ enabled: true, cookie: 'enc-bytes', cookie_enc: true })
    // …only this plugin's table prefs moved, the unrelated one stays…
    expect(from.tablePrefs?.['sentry.usage']).toBeUndefined()
    expect(from.tablePrefs?.['github.usage']).toEqual({ pageSize: 10 })
    expect(to.tablePrefs?.['sentry.usage']).toEqual({ pageSize: 50 })
    // …and the data folder moved.
    expect(existsSync(join(profileDir('personal'), 'sentry'))).toBe(false)
    expect(existsSync(join(profileDir('work'), 'sentry', 'reports', 'usage.json'))).toBe(true)
  })

  it('refuses when source and target are the same', async () => {
    await seedPlugin('personal')

    const res = movePluginToProfile(sentry, 'personal', 'personal')

    expect(res).toEqual({ ok: false, error: expect.stringMatching(/same/i) })
  })

  it('refuses an unknown profile', () => {
    const res = movePluginToProfile(sentry, 'personal', 'nope')

    expect(res.ok).toBe(false)
  })

  it('refuses to clobber a plugin already connected in the target', async () => {
    await seedPlugin('personal')
    writeConfigAt(profileDir('work'), { plugins: { sentry: { enabled: false, cookie: 'their-cookie' } } })

    const res = movePluginToProfile(sentry, 'personal', 'work')

    expect(res).toEqual({ ok: false, error: expect.stringMatching(/already/i) })
    // The source keeps its entry — a refused move is a no-op.
    expect(readConfigAt(profileDir('personal')).plugins.sentry).toBeDefined()
    expect(readConfigAt(profileDir('work')).plugins.sentry).toEqual({ enabled: false, cookie: 'their-cookie' })
  })

  it('moves into a target that has the plugin installed but disconnected', async () => {
    await seedPlugin('personal')
    // What Disconnect leaves behind: the lifecycle flags + the pinned config, no session material.
    writeConfigAt(profileDir('work'), {
      plugins: { sentry: { enabled: true, installed: true, onboardedAt: '2026-01-01', config: { orgSlug: 'theirs' } } }
    })

    expect(movePluginToProfile(sentry, 'personal', 'work').ok).toBe(true)
    expect(readConfigAt(profileDir('work')).plugins.sentry).toEqual({
      enabled: true,
      cookie: 'enc-bytes',
      cookie_enc: true
    })
    expect(readConfigAt(profileDir('personal')).plugins.sentry).toBeUndefined()
  })

  it('moves the data folder even when the target has a stale one of its own', async () => {
    await seedPlugin('personal')
    await mkdir(join(profileDir('work'), 'sentry', 'reports'), { recursive: true })
    await writeFile(join(profileDir('work'), 'sentry', 'reports', 'usage.json'), '{"stale":true}')
    await writeFile(join(profileDir('work'), 'sentry', 'reports', 'billing.json'), '{"kept":true}')

    expect(movePluginToProfile(sentry, 'personal', 'work').ok).toBe(true)

    // The moved report wins over the leftover of the same name; a leftover the move doesn't cover survives.
    const reports = join(profileDir('work'), 'sentry', 'reports')

    expect(await readFile(join(reports, 'usage.json'), 'utf8')).toBe('{"ok":true}')
    expect(await readFile(join(reports, 'billing.json'), 'utf8')).toBe('{"kept":true}')
    expect(existsSync(join(profileDir('personal'), 'sentry'))).toBe(false)
  })

  it('refuses when the plugin has nothing to move in the source', () => {
    const res = movePluginToProfile(sentry, 'personal', 'work')

    expect(res.ok).toBe(false)
  })
})

describe('movePluginToProfile across encrypted profiles', () => {
  setScryptParamsForTest({ N: 2 ** 8, r: 8, p: 1 })

  // Stand up two profiles, each with its OWN unlocked vault, then seed the source with a plugin footprint:
  // a sealed config entry (credential) + a sealed data file. The move must re-key both under the target's DEK.
  beforeEach(() => {
    listProfiles() // seed `personal`
    createProfile('Work') // → id `work`
    setupVault(profileDir('personal'), 'pw-personal') // leaves it unlocked
    setupVault(profileDir('work'), 'pw-work')
  })

  afterEach(() => lockAll())

  it('re-keys the credential + data file under the target DEK and empties the source', () => {
    const fromDir = profileDir('personal')
    const toDir = profileDir('work')

    writeConfigAt(fromDir, { plugins: { sentry: { enabled: true, cookie: 'secret-cookie', cookie_enc: false } } })
    writeBytesSync(fromDir, join(fromDir, 'sentry', 'reports', 'usage.json'), Buffer.from('{"ok":true}'))

    expect(movePluginToProfile(sentry, 'personal', 'work').ok).toBe(true)

    // The target decrypts both the config entry and the data file under its own DEK…
    expect(readConfigAt(toDir).plugins.sentry).toEqual({ enabled: true, cookie: 'secret-cookie', cookie_enc: false })
    expect(readBytesSync(toDir, join(toDir, 'sentry', 'reports', 'usage.json'))?.toString()).toBe('{"ok":true}')

    // …and the source no longer has the plugin.
    expect(readConfigAt(fromDir).plugins.sentry).toBeUndefined()
    expect(existsSync(join(fromDir, 'sentry'))).toBe(false)
  })

  it('refuses when either side is locked', () => {
    writeConfigAt(profileDir('personal'), { plugins: { sentry: { enabled: true, cookie: 'x' } } })
    lockVault(profileDir('work'))

    const res = movePluginToProfile(sentry, 'personal', 'work')

    expect(res).toEqual({ ok: false, error: expect.stringMatching(/unlock/i) })
  })
})

describe('duplicateProfile', () => {
  beforeEach(() => {
    listProfiles() // seed `personal`
  })

  it('clones the record with a "copy" name, a unique id, a fresh partition, and inactive', () => {
    const res = duplicateProfile('personal')

    expect(res.ok).toBe(true)

    if (!res.ok) {
      return
    }

    expect(res.profile.id).toBe('personal-copy')
    expect(res.profile.name).toBe('Personal copy')
    expect(res.profile.partition).toBe('persist:butin-personal-copy')
    expect(res.profile.active).toBe(false)
    expect(res.profile.encryption).toBe('off')
    expect(listProfiles().map((p) => p.id)).toContain('personal-copy')
  })

  it('carries the source color onto the clone', () => {
    const { id } = createProfile('Work')

    recolorProfile(id, '#abcdef')

    const res = duplicateProfile(id)

    expect(res.ok && res.profile.color).toBe('#abcdef')
  })

  it('deep-copies the source config + plugin data into the clone, leaving the source intact', () => {
    const src = profileDir('personal')

    writeConfigAt(src, { plugins: { sentry: { enabled: true, cookie: 'enc-bytes', cookie_enc: true } } })
    writeBytesSync(src, join(src, 'sentry', 'reports', 'usage.json'), Buffer.from('{"ok":true}'))

    const res = duplicateProfile('personal')

    expect(res.ok).toBe(true)

    if (!res.ok) {
      return
    }

    const cloneDir = profileDir(res.profile.id)

    expect(readConfigAt(cloneDir).plugins.sentry).toEqual({ enabled: true, cookie: 'enc-bytes', cookie_enc: true })
    expect(existsSync(join(cloneDir, 'sentry', 'reports', 'usage.json'))).toBe(true)
    // The source is untouched — duplicate is a copy, never a move.
    expect(readConfigAt(src).plugins.sentry).toBeDefined()
    expect(existsSync(join(src, 'sentry', 'reports', 'usage.json'))).toBe(true)
  })

  it('refuses an unknown profile', () => {
    expect(duplicateProfile('nope').ok).toBe(false)
  })
})

describe('duplicateProfile across encryption', () => {
  setScryptParamsForTest({ N: 2 ** 8, r: 8, p: 1 })

  beforeEach(() => {
    listProfiles() // seed `personal`
  })

  afterEach(() => lockAll())

  it('decrypts an unlocked encrypted source into a plaintext clone', () => {
    const src = profileDir('personal')

    setupVault(src, 'pw-personal') // leaves it unlocked + encrypted
    writeConfigAt(src, { plugins: { sentry: { enabled: true, cookie: 'secret-cookie', cookie_enc: false } } })
    writeBytesSync(src, join(src, 'sentry', 'reports', 'usage.json'), Buffer.from('{"ok":true}'))

    const res = duplicateProfile('personal')

    expect(res.ok).toBe(true)

    if (!res.ok) {
      return
    }

    const cloneDir = profileDir(res.profile.id)

    // The clone carries no vault — its files land in the clear and read back without a key.
    expect(res.profile.encryption).toBe('off')
    expect(existsSync(join(cloneDir, 'vault.json'))).toBe(false)
    expect(readConfigAt(cloneDir).plugins.sentry).toEqual({ enabled: true, cookie: 'secret-cookie', cookie_enc: false })
    expect(readBytesSync(cloneDir, join(cloneDir, 'sentry', 'reports', 'usage.json'))?.toString()).toBe('{"ok":true}')
  })

  it('refuses a locked source', () => {
    const src = profileDir('personal')

    setupVault(src, 'pw-personal')
    lockVault(src)

    expect(duplicateProfile('personal')).toEqual({ ok: false, error: expect.stringMatching(/unlock/i) })
  })
})

describe('legacy migration', () => {
  it('moves a legacy config.json + plugin data into profiles/personal and is idempotent', async () => {
    // Simulate a pre-profiles ~/butin: a top-level config.json + a plugin data dir + an app-level logs dir.
    await writeFile(join(root, 'config.json'), JSON.stringify({ plugins: { sentry: { enabled: true } } }))
    await mkdir(join(root, 'sentry', 'reports'), { recursive: true })
    await writeFile(join(root, 'sentry', 'reports', 'billing.json'), '{"ok":true}')
    await mkdir(join(root, 'logs'), { recursive: true })
    await writeFile(join(root, 'logs', 'butin-2026-06-14.log'), 'x')

    const activeId = ensureProfilesInitialized(['sentry', 'claude'])

    expect(activeId).toBe('personal')
    // config + plugin data moved under the profile…
    expect(existsSync(join(profileDir('personal'), 'config.json'))).toBe(true)
    expect(existsSync(join(profileDir('personal'), 'sentry', 'reports', 'billing.json'))).toBe(true)
    // …the old top-level copies are gone…
    expect(existsSync(join(root, 'config.json'))).toBe(false)
    expect(existsSync(join(root, 'sentry'))).toBe(false)
    // …and app-level folders are left alone.
    expect(existsSync(join(root, 'logs', 'butin-2026-06-14.log'))).toBe(true)

    const moved = JSON.parse(await readFile(join(profileDir('personal'), 'config.json'), 'utf8'))

    expect(moved.plugins.sentry.enabled).toBe(true)
    // The migrated default profile uses the persist:butin partition so existing browser logins are preserved.
    expect(listProfiles().find((p) => p.id === 'personal')!.partition).toBe('persist:butin')

    // Second run is a no-op (registry already exists) and must not throw.
    expect(ensureProfilesInitialized(['sentry', 'claude'])).toBe('personal')
  })

  it('does not clobber a plugin folder already present in the profile', async () => {
    await writeFile(join(root, 'config.json'), JSON.stringify({ plugins: {} }))
    await mkdir(join(profileDir('personal'), 'sentry'), { recursive: true })
    await writeFile(join(profileDir('personal'), 'sentry', 'keep.json'), 'existing')
    await mkdir(join(root, 'sentry'), { recursive: true })
    await writeFile(join(root, 'sentry', 'incoming.json'), 'incoming')

    ensureProfilesInitialized(['sentry'])

    // The pre-existing profile copy wins — migration never overwrites a folder already in the profile.
    expect(existsSync(join(profileDir('personal'), 'sentry', 'keep.json'))).toBe(true)
    expect(existsSync(join(profileDir('personal'), 'sentry', 'incoming.json'))).toBe(false)
  })

  it('initializes an empty personal profile on a fresh install (no legacy files)', () => {
    const activeId = ensureProfilesInitialized(['sentry'])

    expect(activeId).toBe('personal')
    expect(existsSync(profileDir('personal'))).toBe(true)
    expect(existsSync(join(profileDir('personal'), 'config.json'))).toBe(false)
  })
})

describe('applyActiveProfile', () => {
  it('repoints the data root and partition at the profile', () => {
    createProfile('Work')

    applyActiveProfile('work')

    expect(dataRootDir()).toBe(profileDir('work'))
    expect(activePartition()).toBe('persist:butin-work')

    // reset shared module state so other suites see defaults
    setDataRoot(join(root, 'unused'))
    setActivePartition('persist:butin')
  })

  it('keeps the original persist:butin partition for the default profile', () => {
    listProfiles() // seeds the default `personal`

    applyActiveProfile('personal')

    expect(activePartition()).toBe('persist:butin')

    setDataRoot(join(root, 'unused'))
    setActivePartition('persist:butin')
  })

  it('self-heals a legacy personal record (no stored partition) back onto persist:butin', async () => {
    // A profiles.json whose personal record has no `partition` field.
    await writeFile(
      join(root, 'profiles.json'),
      JSON.stringify({ activeProfileId: 'personal', profiles: [{ id: 'personal', name: 'Personal', createdAt: '' }] })
    )

    applyActiveProfile('personal')

    expect(activePartition()).toBe('persist:butin')

    setDataRoot(join(root, 'unused'))
    setActivePartition('persist:butin')
  })
})

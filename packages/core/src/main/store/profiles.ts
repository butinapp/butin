import type { ButinPlugin } from '@butinapp/sdk'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

import { setActivePartition } from '../browser/shared-session.js'
import { env } from '../env.js'
import { log } from '../log.js'
import { entryIsConnected } from '../plugin/connection.js'
import { clearAllSpaBearers } from '../session/spa-session.js'
import { type VaultState, vaultExists, vaultState } from '../vault/vault.js'

import { readConfigAt, setConfigRoot, writeConfigAt } from './config-file.js'
import { readBytesSync, writeBytesSync } from './secure-fs.js'
import { setDataRoot } from './store.js'

// One profile in the registry. `id` is a stable slug (the folder name); `name` is freely renamable.
// `partition` pins the browser session: the default profile uses `persist:butin` so a single-profile
// install's logins are preserved; created profiles are isolated under `persist:butin-<id>`.
export type ProfileRecord = { id: string; name: string; color?: string; createdAt: string; partition?: string }

// The registry file (~/butin/profiles.json): the list + which id is active. Folder data lives elsewhere.
type ProfilesFile = { activeProfileId: string; profiles: ProfileRecord[] }

// What the renderer sees: the record + a resolved `active` flag + its at-rest encryption state ('off' when
// the profile has no vault, 'locked' / 'unlocked' when it does), so the switcher can badge it and the lock
// gate knows whether to prompt.
export type ProfileSummary = ProfileRecord & { active: boolean; encryption: VaultState }

// The ~/butin root. profiles.json + the profiles/ dir hang off it; it NEVER moves (configRoot/dataRoot do).
// env.home (BUTIN_HOME) relocates the entire store for an isolated dev/test run; otherwise the default ~/butin.
let homeRoot = env.home ?? join(homedir(), 'butin')

// Test seam — point the registry at a temp dir.
export const setProfilesRoot = (dir: string): void => {
  homeRoot = dir
}

// The ~/butin root (or BUTIN_HOME): the whole on-disk footprint — profiles.json, every profile's data, and
// logs/ all hang off it. The Storage tab surfaces it and the "erase everything" wipe removes it.
export const homeRootDir = (): string => homeRoot

const registryPath = (): string => join(homeRoot, 'profiles.json')

// A profile's self-contained folder: its config.json + <plugin>/ data tree live here.
export const profileDir = (id: string): string => join(homeRoot, 'profiles', id)

// Where profile folders live. An import extracts into a dot-prefixed staging folder here (siblings of the real
// profiles, so the final install is a same-volume rename) before it is adopted.
export const profilesDir = (): string => join(homeRoot, 'profiles')

const DEFAULT_PROFILE: ProfileRecord = {
  id: 'personal',
  name: 'Personal',
  createdAt: '1970-01-01T00:00:00.000Z',
  partition: 'persist:butin'
}

// The fresh single-profile registry used on first run and as the corrupt-file fallback. Writes it + creates
// the default profile folder so callers get a persisted, ready-to-use state (never recurses).
const seedDefault = (): ProfilesFile => {
  const seeded: ProfilesFile = {
    activeProfileId: DEFAULT_PROFILE.id,
    profiles: [{ ...DEFAULT_PROFILE, createdAt: new Date().toISOString() }]
  }

  writeRegistry(seeded)
  mkdirSync(profileDir(DEFAULT_PROFILE.id), { recursive: true })

  return seeded
}

// Read the registry, or seed a default { personal } registry when absent. A file that exists but won't
// parse is corruption: side-step it (profiles.json.corrupt-<ts>) so the next write lands on a clean slate
// instead of silently destroying the profile list.
const readRegistry = (): ProfilesFile => {
  const path = registryPath()

  if (!existsSync(path)) {
    return seedDefault()
  }

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ProfilesFile
  } catch (err) {
    const backup = `${path}.corrupt-${Date.now()}`

    try {
      renameSync(path, backup)
      log.error('profiles', `profiles.json failed to parse — moved to ${backup} (data preserved)`, err)
    } catch (moveErr) {
      log.error('profiles', 'profiles.json failed to parse AND could not be backed up', moveErr)
    }

    return seedDefault()
  }
}

const writeRegistry = (file: ProfilesFile): void => {
  mkdirSync(homeRoot, { recursive: true })
  writeFileSync(registryPath(), JSON.stringify(file, null, 2))
}

// Lowercase, non-alphanumeric → single hyphen, trimmed. Empty input falls back to 'profile'.
const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'profile'

// A slug unique within the registry: base, then base-2, base-3, …
const uniqueId = (name: string, existing: ProfileRecord[]): string => {
  const base = slugify(name)
  const taken = new Set(existing.map((p) => p.id))

  if (!taken.has(base)) {
    return base
  }

  let n = 2

  while (taken.has(`${base}-${n}`)) {
    n += 1
  }

  return `${base}-${n}`
}

export const listProfiles = (): ProfileSummary[] => {
  const { activeProfileId, profiles } = readRegistry()

  return profiles.map((p) => ({ ...p, active: p.id === activeProfileId, encryption: vaultState(profileDir(p.id)) }))
}

export const getActiveProfileId = (): string => readRegistry().activeProfileId

export const createProfile = (name: string): ProfileSummary => {
  const file = readRegistry()
  const id = uniqueId(name, file.profiles)
  const record: ProfileRecord = {
    id,
    name: name.trim() || id,
    createdAt: new Date().toISOString(),
    partition: `persist:butin-${id}`
  }

  file.profiles.push(record)
  writeRegistry(file)
  mkdirSync(profileDir(id), { recursive: true })

  return { ...record, active: file.activeProfileId === id, encryption: 'off' }
}

export const renameProfile = (id: string, name: string): void => {
  const file = readRegistry()
  const record = file.profiles.find((p) => p.id === id)

  if (record) {
    record.name = name.trim() || record.name
    writeRegistry(file)
  }
}

export const recolorProfile = (id: string, color: string): void => {
  const file = readRegistry()
  const record = file.profiles.find((p) => p.id === id)

  if (record) {
    record.color = color
    writeRegistry(file)
  }
}

export type DuplicateResult = { ok: true; profile: ProfileSummary } | { ok: false; error: string }

// Clone a profile into a brand-new one: a fresh record ("<name> copy", unique slug, isolated partition) plus a
// deep copy of the source folder (config.json + every plugin's data). The clone is immediately usable headless —
// the encrypted cookie/token values inside config.json decrypt in the copy because safeStorage keys off the OS
// user, not the profile. The new profile is NOT made active; it appears alongside the source.
//
// Encryption follows movePluginToProfile's constraint: a LOCKED source has no DEK to read under, so it's refused.
// An unlocked encrypted source is decrypted on the way out — the clone lands PLAINTEXT (no vault), and the caller
// surfaces that. (The Electron browser partition is not cloned; headless replay works from config.json, while a
// fresh Magic Login in the clone re-captures.)
export const duplicateProfile = (id: string): DuplicateResult => {
  const file = readRegistry()
  const source = file.profiles.find((p) => p.id === id)

  if (!source) {
    return { ok: false, error: 'profile not found' }
  }

  const fromDir = profileDir(id)

  if (vaultState(fromDir) === 'locked') {
    return { ok: false, error: 'unlock this profile before duplicating it' }
  }

  const name = `${source.name} copy`
  const newId = uniqueId(name, file.profiles)
  const record: ProfileRecord = {
    id: newId,
    name,
    color: source.color,
    createdAt: new Date().toISOString(),
    partition: `persist:butin-${newId}`
  }

  mkdirSync(profileDir(newId), { recursive: true })
  copyProfileTree(fromDir, profileDir(newId))

  file.profiles.push(record)
  writeRegistry(file)

  return { ok: true, profile: { ...record, active: false, encryption: 'off' } }
}

// Copy a profile's whole tree into a fresh (plaintext) profile dir. A plaintext source copies verbatim. An
// unlocked encrypted source is read under its DEK (decrypting) and rewritten in the clear — skipping the vault's
// own files (vault.json + any leftover migration temp) so the clone carries no vault and reads without a key.
const copyProfileTree = (fromDir: string, toDir: string): void => {
  if (!vaultExists(fromDir)) {
    cpSync(fromDir, toDir, { recursive: true })

    return
  }

  for (const abs of listFilesRec(fromDir)) {
    const rel = relative(fromDir, abs)

    if (rel === 'vault.json' || abs.endsWith('.btn-migrate-tmp')) {
      continue
    }

    const bytes = readBytesSync(fromDir, abs)

    if (bytes !== null) {
      writeBytesSync(toDir, join(toDir, rel), bytes)
    }
  }
}

// A NAME no existing profile already shows. The slug is disambiguated separately, but the slug is invisible in
// the app — two cards reading "Personal" are two cards the user cannot tell apart, and one of them holds their
// real sessions. So the visible name is what has to differ.
const uniqueName = (name: string, existing: ProfileRecord[]): string => {
  const taken = new Set(existing.map((p) => p.name))

  if (!taken.has(name)) {
    return name
  }

  if (!taken.has(`${name} (imported)`)) {
    return `${name} (imported)`
  }

  let n = 2

  while (taken.has(`${name} (imported ${n})`)) {
    n += 1
  }

  return `${name} (imported ${n})`
}

// Adopt an already-extracted tree as a new profile: a name and slug that clash with nothing, its own browser
// partition, then the folder renamed into place and the registry written LAST. That order is what keeps a
// failed import from leaving a registry entry pointing at a folder that isn't there. The new profile is not
// made active — it appears alongside the existing ones, like a duplicate does.
export const adoptProfileTree = (
  stagingDir: string,
  input: { name: string; color?: string; createdAt: string }
): ProfileSummary => {
  const file = readRegistry()
  const name = uniqueName(input.name.trim() || 'Imported profile', file.profiles)
  const id = uniqueId(name, file.profiles)
  const record: ProfileRecord = {
    id,
    name,
    color: input.color,
    createdAt: input.createdAt,
    partition: `persist:butin-${id}`
  }

  renameSync(stagingDir, profileDir(id))
  file.profiles.push(record)
  writeRegistry(file)

  return { ...record, active: false, encryption: 'off' }
}

export const setActiveProfile = (id: string): void => {
  const file = readRegistry()

  if (file.profiles.some((p) => p.id === id)) {
    file.activeProfileId = id
    writeRegistry(file)
  }
}

export const deleteProfile = (id: string): void => {
  const file = readRegistry()

  if (file.profiles.length <= 1) {
    throw new Error('cannot delete the last profile')
  }

  file.profiles = file.profiles.filter((p) => p.id !== id)

  // Deleting the active profile falls back to the first remaining one.
  if (file.activeProfileId === id) {
    file.activeProfileId = file.profiles[0]!.id
  }

  writeRegistry(file)
  rmSync(profileDir(id), { recursive: true, force: true })
}

export type MovePluginResult = { ok: true } | { ok: false; error: string }

// Relocate a plugin's stored state from one profile to another. The plugin's CODE lives in every profile;
// what's profile-specific is the stored session + config (its config.json `plugins[id]` entry), its per-capability
// `tablePrefs["<id>.*"]`, and its data folder (reports/manifests/documents/extracts/caches). Moving all three
// hands the live connection + cached data to the target, leaving the source with the plugin present-but-empty.
// Refuses to clobber a target whose copy is still CONNECTED (the user disconnects it there first) — a target
// that merely has the plugin installed or disconnected is a valid destination, and the moved state wins over
// whatever it kept. No-ops with an error when there's nothing to move. The encrypted credential bytes travel
// verbatim — safeStorage keys off the OS user, not the profile, so they still decrypt in the target.
export const movePluginToProfile = (plugin: ButinPlugin, fromId: string, toId: string): MovePluginResult => {
  const pluginId = plugin.meta.id

  if (fromId === toId) {
    return { ok: false, error: 'source and target profiles are the same' }
  }

  const ids = new Set(readRegistry().profiles.map((p) => p.id))

  if (!ids.has(fromId) || !ids.has(toId)) {
    return { ok: false, error: 'profile not found' }
  }

  const fromDir = profileDir(fromId)
  const toDir = profileDir(toId)

  // Re-keying reads under the source DEK and writes under the target DEK; a locked side has neither, so the
  // move can't proceed. (Verbatim copying ciphertext across distinct per-profile DEKs would be undecryptable.)
  if (vaultState(fromDir) === 'locked' || vaultState(toDir) === 'locked') {
    return { ok: false, error: 'unlock both profiles before moving a plugin between them' }
  }

  const fromConfig = readConfigAt(fromDir)
  const toConfig = readConfigAt(toDir)

  if (entryIsConnected(plugin, toConfig.plugins[pluginId])) {
    return { ok: false, error: 'the target profile already has this plugin connected — disconnect it there first' }
  }

  const entry = fromConfig.plugins[pluginId]
  const prefix = `${pluginId}.`
  const prefKeys = Object.keys(fromConfig.tablePrefs ?? {}).filter((k) => k.startsWith(prefix))
  const hasFolder = existsSync(join(fromDir, pluginId))

  if (entry === undefined && prefKeys.length === 0 && !hasFolder) {
    return { ok: false, error: 'nothing to move for this plugin in the source profile' }
  }

  // Move the credential/config entry.
  if (entry !== undefined) {
    toConfig.plugins[pluginId] = entry
    delete fromConfig.plugins[pluginId]
  }

  // Move every table-pref keyed to this plugin (`<pluginId>.<capabilityId>`), leaving other plugins' alone.
  for (const key of prefKeys) {
    toConfig.tablePrefs = { ...(toConfig.tablePrefs ?? {}), [key]: fromConfig.tablePrefs![key]! }
    delete fromConfig.tablePrefs![key]
  }

  // The config entry + table prefs travel re-keyed for free: readConfigAt decrypted them under the source's
  // DEK, writeConfigAt re-seals them under the target's.
  writeConfigAt(toDir, toConfig)
  writeConfigAt(fromDir, fromConfig)

  transferDataFolder(fromDir, toDir, pluginId)

  // Drop profile-scoped in-memory caches so a stale token for the moved plugin can't linger in the active
  // session (the source is usually the active profile).
  clearAllSpaBearers()

  return { ok: true }
}

// True for a pre-profiles layout: a top-level config.json but no registry yet.
const hasLegacyLayout = (): boolean => existsSync(join(homeRoot, 'config.json')) && !existsSync(registryPath())

// Every file under a directory, recursively (absolute paths).
const listFilesRec = (dir: string): string[] => {
  const out: string[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)

    if (entry.isDirectory()) {
      out.push(...listFilesRec(abs))
    } else if (entry.isFile()) {
      out.push(abs)
    }
  }

  return out
}

// Move a plugin's data folder between profiles. A whole-folder rename is correct and fast only when both sides
// are plaintext (no vault) AND the target has no folder of its own — moveInto never clobbers a destination that
// exists, so anything else walks file by file. That walk is also what re-keys across vaults: ciphertext can't
// be copied verbatim across distinct DEKs, so each file is read under the source profile's key (decrypting, or
// raw if the source is OFF) and rewritten under the target's (sealing, or raw if the target is OFF). Either way
// the source tree is removed, and a file the moved plugin brings wins over a leftover of the same name.
const transferDataFolder = (fromDir: string, toDir: string, pluginId: string): void => {
  const fromRoot = join(fromDir, pluginId)
  const toRoot = join(toDir, pluginId)

  if (!existsSync(fromRoot)) {
    return
  }

  if (!vaultExists(fromDir) && !vaultExists(toDir) && !existsSync(toRoot)) {
    moveInto(fromRoot, toRoot)

    return
  }

  for (const abs of listFilesRec(fromRoot)) {
    const bytes = readBytesSync(fromDir, abs)

    if (bytes !== null) {
      writeBytesSync(toDir, join(toRoot, relative(fromRoot, abs)), bytes)
    }
  }

  rmSync(fromRoot, { recursive: true, force: true })
}

// Move one path into the profile, best-effort + idempotent: skip when the source is gone OR the destination
// already exists (never clobber a prior partial migration). renameSync is atomic on the same volume, but
// Windows can EPERM/EBUSY a directory rename when another process (Search Indexer, AV, the app) holds a handle
// inside it — so fall back to a recursive copy + best-effort remove. A single failed entry must NEVER abort the
// run, or the migration strands half-done: each failure is logged and the loop carries on.
const moveInto = (from: string, to: string): void => {
  if (!existsSync(from) || existsSync(to)) {
    return
  }

  try {
    renameSync(from, to)
  } catch (err) {
    log.warn('profiles', `rename failed for ${from} — copying instead`, err)

    try {
      cpSync(from, to, { recursive: true })
      rmSync(from, { recursive: true, force: true })
    } catch (copyErr) {
      log.error('profiles', `could not migrate ${from} into the profile`, copyErr)
    }
  }
}

// Move the legacy top-level config.json + each plugin's data folder into profiles/personal/. Driven by the
// loaded plugin ids so ONLY plugin data dirs move — app-level folders (logs/) and anything unknown stay put.
// Each entry moves independently via moveInto, so one locked folder can't strand the rest.
const migrateLegacy = (pluginIds: string[]): void => {
  const dest = profileDir(DEFAULT_PROFILE.id)

  mkdirSync(dest, { recursive: true })
  moveInto(join(homeRoot, 'config.json'), join(dest, 'config.json'))

  for (const id of pluginIds) {
    moveInto(join(homeRoot, id), join(dest, id))
  }
}

// The browser partition a profile uses. Prefer the value stored on the record (an explicit override). When a
// record carries no partition, fall back by id: the default `personal` profile resolves to `persist:butin` —
// so a single-profile install stays on its existing logins — while every other profile stays isolated under
// `persist:butin-<id>`.
const partitionForProfile = (id: string): string => {
  const stored = readRegistry().profiles.find((p) => p.id === id)?.partition

  return stored ?? (id === DEFAULT_PROFILE.id ? 'persist:butin' : `persist:butin-${id}`)
}

// Make `id` the live context: point the config + data roots at its folder, swap the browser partition, and
// drop profile-scoped in-memory caches. Call at boot (with the active id) and on every switch. The renderer
// reload that follows a switch (done by the IPC handler) re-queries everything against the new roots.
export const applyActiveProfile = (id: string): void => {
  const dir = profileDir(id)

  mkdirSync(dir, { recursive: true })
  setConfigRoot(dir)
  setDataRoot(dir)
  setActivePartition(partitionForProfile(id))
  clearAllSpaBearers()
}

// Boot entry point: migrate a legacy layout if present, then ensure a registry exists, and return the active
// id. Idempotent — after the first run the registry exists, so neither migration nor seeding repeats.
export const ensureProfilesInitialized = (pluginIds: string[]): string => {
  if (hasLegacyLayout()) {
    migrateLegacy(pluginIds)

    const seeded: ProfilesFile = {
      activeProfileId: DEFAULT_PROFILE.id,
      profiles: [{ ...DEFAULT_PROFILE, createdAt: new Date().toISOString() }]
    }

    writeRegistry(seeded)

    return seeded.activeProfileId
  }

  // readRegistry seeds an empty default profile when there's no registry and no legacy layout.
  return readRegistry().activeProfileId
}

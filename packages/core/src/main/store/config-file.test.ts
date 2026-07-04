import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { lockAll, lockVault, setScryptParamsForTest, setupVault } from '../vault/vault.js'

import {
  DEFAULT_LOG_RETENTION_DAYS,
  deriveInstalled,
  getFormatPrefs,
  getMagicLoginUiState,
  getSetting,
  patchMagicLoginUiState,
  getPluginEnabled,
  getPluginInstalled,
  getPluginOnboardedAt,
  getTablePrefs,
  readConfig,
  readConfigAt,
  setConfigRoot,
  setFormatPrefs,
  setSetting,
  setPluginEnabled,
  setPluginInstalled,
  setPluginOnboardedAt,
  setTablePrefs,
  writeConfig,
  writeConfigAt
} from './config-file.js'

describe('deriveInstalled (migration)', () => {
  it('respects an explicit installed flag', () => {
    expect(deriveInstalled({ installed: true })).toBe(true)
    expect(deriveInstalled({ installed: false, enabled: true, cookie: 'x' })).toBe(false)
  })

  it('treats a real footprint as installed when the flag is absent', () => {
    expect(deriveInstalled({ enabled: true })).toBe(true)
    expect(deriveInstalled({ cookie: 'enc' })).toBe(true)
    expect(deriveInstalled({ config: { org: 'acme' } })).toBe(true)
  })

  it('treats an empty / config-less entry as not installed', () => {
    expect(deriveInstalled({})).toBe(false)
    expect(deriveInstalled({ config: {} })).toBe(false)
    expect(deriveInstalled(undefined)).toBe(false)
  })
})

describe('plugin installed flag + onboardedAt', () => {
  afterEach(() => setConfigRoot(join(tmpdir(), 'butin-test-reset')))

  it('installed round-trips and derives from a footprint when absent', () => {
    setConfigRoot(mkdtempSync(join(tmpdir(), 'butin-installed-')))

    expect(getPluginInstalled('sentry')).toBe(false)

    // A pre-flag entry with an enabled footprint reads as installed (migration).
    setPluginEnabled('sentry', true)
    expect(getPluginInstalled('sentry')).toBe(true)

    setPluginInstalled('sentry', false)
    expect(getPluginInstalled('sentry')).toBe(false)
  })

  it('onboardedAt is undefined until set, then round-trips', () => {
    setConfigRoot(mkdtempSync(join(tmpdir(), 'butin-onboarded-')))

    expect(getPluginOnboardedAt('sentry')).toBeUndefined()

    setPluginOnboardedAt('sentry', 1_700_000_000_000)
    expect(getPluginOnboardedAt('sentry')).toBe(1_700_000_000_000)
  })
})

describe('plugin enabled flag', () => {
  afterEach(() => setConfigRoot(join(tmpdir(), 'butin-test-reset')))

  it('defaults to false (off until actively enabled) and round-trips', () => {
    setConfigRoot(mkdtempSync(join(tmpdir(), 'butin-enabled-')))

    expect(getPluginEnabled('sentry')).toBe(false)

    setPluginEnabled('sentry', true)
    expect(getPluginEnabled('sentry')).toBe(true)

    setPluginEnabled('sentry', false)
    expect(getPluginEnabled('sentry')).toBe(false)
  })
})

describe('manual-capture setting', () => {
  afterEach(() => setConfigRoot(join(tmpdir(), 'butin-test-reset')))

  it('defaults to false and round-trips', () => {
    setConfigRoot(mkdtempSync(join(tmpdir(), 'butin-capture-')))

    expect(getSetting('manualCapture')).toBe(false)

    setSetting('manualCapture', true)
    expect(getSetting('manualCapture')).toBe(true)

    setSetting('manualCapture', false)
    expect(getSetting('manualCapture')).toBe(false)
  })

  it('is preserved alongside plugin entries', () => {
    setConfigRoot(mkdtempSync(join(tmpdir(), 'butin-capture-mix-')))

    setSetting('manualCapture', true)
    setPluginEnabled('sentry', false)

    expect(getSetting('manualCapture')).toBe(true)
    expect(getPluginEnabled('sentry')).toBe(false)
  })
})

describe('magic-login UI state', () => {
  beforeEach(() => setConfigRoot(mkdtempSync(join(tmpdir(), 'butin-magic-'))))
  afterEach(() => setConfigRoot(join(tmpdir(), 'butin-test-reset')))

  it('defaults to empty', () => {
    expect(getMagicLoginUiState()).toEqual({})
  })

  it('merges partial patches without clobbering sibling fields', () => {
    patchMagicLoginUiState({ freeze: true })
    patchMagicLoginUiState({ devToolsOpen: true })
    patchMagicLoginUiState({ bounds: { x: 10, y: 20, width: 800, height: 600 }, maximized: true })

    expect(getMagicLoginUiState()).toEqual({
      freeze: true,
      devToolsOpen: true,
      maximized: true,
      bounds: { x: 10, y: 20, width: 800, height: 600 }
    })

    // A later patch overwrites only the named field.
    patchMagicLoginUiState({ freeze: false })
    expect(getMagicLoginUiState().freeze).toBe(false)
    expect(getMagicLoginUiState().devToolsOpen).toBe(true)
  })

  it('is preserved alongside other settings', () => {
    setSetting('manualCapture', true)
    patchMagicLoginUiState({ debugExpanded: true })

    expect(getSetting('manualCapture')).toBe(true)
    expect(getMagicLoginUiState().debugExpanded).toBe(true)
  })
})

describe('format prefs', () => {
  beforeEach(() => setConfigRoot(mkdtempSync(join(tmpdir(), 'butin-format-'))))
  afterEach(() => setConfigRoot(join(tmpdir(), 'butin-test-reset')))

  it('round-trips with defaults', () => {
    expect(getFormatPrefs()).toEqual({ currencyStyle: 'match', dateFormat: 'locale' })

    setFormatPrefs({ currencyStyle: 'eu' })
    expect(getFormatPrefs()).toEqual({ currencyStyle: 'eu', dateFormat: 'locale' })

    setFormatPrefs({ dateFormat: 'iso' })
    expect(getFormatPrefs()).toEqual({ currencyStyle: 'eu', dateFormat: 'iso' })
  })

  it('preserves manualCapture', () => {
    setSetting('manualCapture', true)
    setFormatPrefs({ currencyStyle: 'us' })
    expect(getSetting('manualCapture')).toBe(true)
  })
})

describe('table prefs store', () => {
  beforeEach(() => setConfigRoot(mkdtempSync(join(tmpdir(), 'butin-tableprefs-'))))
  afterEach(() => setConfigRoot(join(tmpdir(), 'butin-test-reset')))

  it('returns undefined when nothing is stored', () => {
    expect(getTablePrefs('github.invoices')).toBeUndefined()
  })

  it('round-trips prefs keyed by plugin.capability without touching plugin entries', () => {
    setTablePrefs('github.invoices', { sort: { key: 'date', dir: 'desc' }, pageSize: 50 })
    setTablePrefs('sentry.usage', { columnVisibility: { region: false } })

    expect(getTablePrefs('github.invoices')).toEqual({ sort: { key: 'date', dir: 'desc' }, pageSize: 50 })
    expect(getTablePrefs('sentry.usage')).toEqual({ columnVisibility: { region: false } })
  })

  it('overwrites an existing entry', () => {
    setTablePrefs('github.invoices', { pageSize: 25 })
    setTablePrefs('github.invoices', { pageSize: 100 })

    expect(getTablePrefs('github.invoices')).toEqual({ pageSize: 100 })
  })
})

describe('log retention setting', () => {
  beforeEach(() => setConfigRoot(mkdtempSync(join(tmpdir(), 'butin-retention-'))))
  afterEach(() => setConfigRoot(join(tmpdir(), 'butin-test-reset')))

  it('defaults to a week and round-trips (0 = forever), preserving other settings', () => {
    expect(getSetting('logRetentionDays')).toBe(DEFAULT_LOG_RETENTION_DAYS)

    setSetting('manualCapture', true)
    setSetting('logRetentionDays', 30)
    expect(getSetting('logRetentionDays')).toBe(30)
    expect(getSetting('manualCapture')).toBe(true)

    setSetting('logRetentionDays', 0)
    expect(getSetting('logRetentionDays')).toBe(0)
  })
})

describe('config corruption handling', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'butin-corrupt-'))
    setConfigRoot(dir)
  })
  afterEach(() => setConfigRoot(join(tmpdir(), 'butin-test-reset')))

  it('reads a missing config as the empty default without leaving any file behind', () => {
    expect(readConfig()).toEqual({ plugins: {} })
    expect(readdirSync(dir)).toEqual([])
  })

  it('moves a corrupt config.json aside instead of silently overwriting it', () => {
    writeFileSync(join(dir, 'config.json'), '{ not valid json')

    expect(readConfig()).toEqual({ plugins: {} })

    const files = readdirSync(dir)

    expect(files.some((f) => f.startsWith('config.json.corrupt-'))).toBe(true)
    expect(files).not.toContain('config.json')

    // The next write lands on a clean slate — no leftover corruption to re-trip on.
    writeConfig({ plugins: { sentry: { enabled: true } } })
    expect(readConfig().plugins.sentry).toEqual({ enabled: true })
  })
})

describe('config-file on an encrypted profile', () => {
  setScryptParamsForTest({ N: 2 ** 8, r: 8, p: 1 })

  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'butin-config-vault-'))
  })
  afterEach(() => {
    lockAll()
    setConfigRoot(join(tmpdir(), 'butin-test-reset'))
  })

  it('round-trips a sealed config through writeConfigAt/readConfigAt while unlocked', () => {
    setupVault(dir, 'pw') // leaves the dir unlocked

    const config = { plugins: { sentry: { enabled: true, cookie: 'secret' } } }

    writeConfigAt(dir, config)

    // The on-disk file is sealed (no readable plaintext), yet the read decrypts transparently.
    expect(readFileSync(join(dir, 'config.json')).includes(Buffer.from('secret'))).toBe(false)
    expect(readConfigAt(dir)).toEqual(config)
  })

  it('returns the empty default for a locked vault without backing up the file as corrupt', () => {
    setupVault(dir, 'pw')
    writeConfigAt(dir, { plugins: { sentry: { enabled: true } } })
    lockVault(dir)

    // A locked read is "no data yet", NOT corruption — the empty default comes back and the sealed
    // config.json is left untouched (no .corrupt- sidecar that would later strand the real data).
    expect(readConfigAt(dir)).toEqual({ plugins: {} })

    const files = readdirSync(dir)

    expect(files).toContain('config.json')
    expect(files.some((f) => f.startsWith('config.json.corrupt-'))).toBe(false)
  })
})

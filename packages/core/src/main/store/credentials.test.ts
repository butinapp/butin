import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { setSetting } from './config-file.js'
import { clearAllCredentials, clearCredentials, createCredentialStore, setConfigRoot } from './credentials.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'butin-'))
  setConfigRoot(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('set then get round-trips a credential', () => {
  const creds = createCredentialStore('claude')

  creds.set('cookie', 'sessionKey=abc')
  expect(creds.get('cookie')).toBe('sessionKey=abc')
})

test('get defaults to the cookie field', () => {
  const creds = createCredentialStore('claude')

  creds.set('cookie', 'sessionKey=xyz')
  expect(creds.get()).toBe('sessionKey=xyz')
})

test('missing field returns undefined', () => {
  expect(createCredentialStore('claude').get('accessToken')).toBeUndefined()
})

test('two plugins keep separate credentials', () => {
  createCredentialStore('claude').set('cookie', 'a')
  createCredentialStore('github').set('cookie', 'b')
  expect(createCredentialStore('claude').get('cookie')).toBe('a')
  expect(createCredentialStore('github').get('cookie')).toBe('b')
})

test('clearCredentials drops the session but preserves config + lifecycle flags', () => {
  const creds = createCredentialStore('claude')

  creds.set('cookie', 'sessionKey=abc')
  creds.set('orgId', 'org_captured') // a captured id is session material — cleared with the cookie

  const file = join(dir, 'config.json')
  const before = JSON.parse(readFileSync(file, 'utf8'))

  Object.assign(before.plugins.claude, {
    config: { orgId: 'org-1' },
    enabled: true,
    installed: true,
    onboardedAt: 123
  })
  writeFileSync(file, JSON.stringify(before))

  clearCredentials('claude')

  expect(createCredentialStore('claude').get('cookie')).toBeUndefined()
  expect(createCredentialStore('claude').get('orgId')).toBeUndefined()

  const after = JSON.parse(readFileSync(file, 'utf8'))

  // Settings + the plugin's place in the app survive — Disconnect doesn't disable, uninstall, or reset setup.
  expect(after.plugins.claude).toEqual({ config: { orgId: 'org-1' }, enabled: true, installed: true, onboardedAt: 123 })
})

test('clearAllCredentials wipes every plugin but preserves app settings', () => {
  createCredentialStore('claude').set('cookie', 'a')
  createCredentialStore('github').set('cookie', 'b')
  setSetting('manualCapture', true)

  clearAllCredentials()

  expect(createCredentialStore('claude').get('cookie')).toBeUndefined()
  expect(createCredentialStore('github').get('cookie')).toBeUndefined()

  const after = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))

  expect(after.plugins).toEqual({})
  expect(after.settings).toEqual({ manualCapture: true })
})

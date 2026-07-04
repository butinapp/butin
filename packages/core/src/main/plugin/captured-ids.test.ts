import type { ButinPlugin } from '@butinapp/sdk'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createCredentialStore, setConfigRoot } from '../store/credentials.js'

import { fillCapturedIds } from './captured-ids.js'

// A header-captured org id (Groq) and a URL-captured account id (DNSimple), each backed by a config field of
// the same key.
const plugin = {
  meta: { id: 'groq' },
  session: {
    captureFromHeader: [{ header: 'Groq-Organization', storeAs: 'orgId', on: 'request' }],
    captureFromUrl: [{ pattern: '/a/(\\d+)', storeAs: 'accountId' }]
  },
  config: { fields: [{ key: 'orgId' }, { key: 'accountId' }] }
} as unknown as ButinPlugin

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'butin-capids-'))
  setConfigRoot(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('an empty config field resolves to the captured id', () => {
  createCredentialStore('groq').set('orgId', 'org_captured')

  expect(fillCapturedIds(plugin, {} as Record<string, string>).orgId).toBe('org_captured')
})

test('an explicit config value wins over the captured id', () => {
  createCredentialStore('groq').set('orgId', 'org_captured')

  expect(fillCapturedIds(plugin, { orgId: 'org_pinned' }).orgId).toBe('org_pinned')
})

test('a blank/whitespace config value is treated as empty and filled', () => {
  createCredentialStore('groq').set('accountId', '12345')

  expect(fillCapturedIds(plugin, { accountId: '  ' }).accountId).toBe('12345')
})

test('a field with no captured id is left untouched', () => {
  expect(fillCapturedIds(plugin, {})).toEqual({})
})

test('a plugin with no captures returns the config unchanged', () => {
  const bare = { meta: { id: 'x' }, session: {}, config: { fields: [] } } as unknown as ButinPlugin

  expect(fillCapturedIds(bare, { orgId: 'keep' })).toEqual({ orgId: 'keep' })
})

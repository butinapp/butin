import type { PluginConfigSchema } from '@butinapp/sdk'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { setConfigRoot } from './config-file.js'
import { getPluginConfig, getPublicConfig, setPluginConfig } from './plugin-config.js'

const schema: PluginConfigSchema = {
  fields: [
    { key: 'orgId', label: 'Org', kind: 'text' },
    { key: 'apiToken', label: 'Token', kind: 'secret' }
  ]
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'butin-cfg-'))
  setConfigRoot(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('set then get round-trips text and secret fields', () => {
  setPluginConfig('claude', schema, { orgId: 'org-1', apiToken: 'sk-123' })

  const full = getPluginConfig('claude', schema)

  expect(full.orgId).toBe('org-1')
  expect(full.apiToken).toBe('sk-123')
})

test('getPublicConfig omits secret fields', () => {
  setPluginConfig('claude', schema, { orgId: 'org-1', apiToken: 'sk-123' })

  expect(getPublicConfig('claude', schema)).toEqual({ orgId: 'org-1' })
})

test('a blank secret value leaves the stored secret intact', () => {
  setPluginConfig('claude', schema, { orgId: 'org-1', apiToken: 'sk-123' })
  setPluginConfig('claude', schema, { orgId: 'org-2', apiToken: '' })

  const full = getPluginConfig('claude', schema)

  expect(full.orgId).toBe('org-2')
  expect(full.apiToken).toBe('sk-123')
})

test('unknown plugin returns empty config', () => {
  expect(getPluginConfig('nope', schema)).toEqual({})
})

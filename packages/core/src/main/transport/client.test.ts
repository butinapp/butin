import type { ButinPlugin, CredentialStore } from '@butinapp/sdk'
import { expect, test, vi } from 'vitest'

import { wrapClearOnAuthError } from './client.js'

const plugin = { auth: { kind: 'cookie' } } as ButinPlugin

test('clears the cookie when a 401 is thrown', async () => {
  const creds: CredentialStore = { get: () => 'c', set: vi.fn() }
  const failing = async () => {
    throw Object.assign(new Error('HTTP 401'), { status: 401 })
  }
  const wrapped = wrapClearOnAuthError(plugin, creds, failing)

  await expect(wrapped()).rejects.toThrow(/401/)
  expect(creds.set).toHaveBeenCalledWith('cookie', '')
})

test('does not clear on a 403 (single-request rejection)', async () => {
  const creds: CredentialStore = { get: () => 'c', set: vi.fn() }
  const failing = async () => {
    throw Object.assign(new Error('HTTP 403'), { status: 403 })
  }
  const wrapped = wrapClearOnAuthError(plugin, creds, failing)

  await expect(wrapped()).rejects.toThrow(/403/)
  expect(creds.set).not.toHaveBeenCalled()
})

test('does not clear the primary session for a 401 raised by a secondary backend', async () => {
  const creds: CredentialStore = { get: () => 'c', set: vi.fn() }
  // A backend client tags its rejections with `fromBackend`; a tab failing on a legacy backend must not
  // disconnect the whole service.
  const failing = async () => {
    throw Object.assign(new Error('HTTP 401'), { status: 401, fromBackend: 'monespace-legacy' })
  }
  const wrapped = wrapClearOnAuthError(plugin, creds, failing)

  await expect(wrapped()).rejects.toThrow(/401/)
  expect(creds.set).not.toHaveBeenCalled()
})

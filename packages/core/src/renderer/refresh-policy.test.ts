import { expect, test } from 'vitest'

import { isPluginWideFailure } from './refresh-policy.js'

test('plugin-wide causes stop the remaining capabilities', () => {
  for (const cause of [
    'session-expired',
    'session-not-captured',
    'config-missing',
    'config-invalid',
    'verification-required',
    'permission'
  ] as const) {
    expect(isPluginWideFailure(cause)).toBe(true)
  }
})

test('per-request causes keep the refresh going', () => {
  for (const cause of ['network', 'data-invalid', 'unknown'] as const) {
    expect(isPluginWideFailure(cause)).toBe(false)
  }
})

test('an unclassified (undefined) cause is not plugin-wide', () => {
  expect(isPluginWideFailure(undefined)).toBe(false)
})

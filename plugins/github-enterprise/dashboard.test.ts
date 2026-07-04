import { expect, test } from 'vitest'

import { extractFetchNonce, slugOf } from './dashboard.js'

test('extractFetchNonce pulls the v2 nonce from the page meta', () => {
  expect(extractFetchNonce('<head><meta name="fetch-nonce" content="v2:abc-123"><title>x</title></head>')).toBe(
    'v2:abc-123'
  )
})

test('extractFetchNonce throws when the nonce is absent (session expired)', () => {
  expect(() => extractFetchNonce('<head></head>')).toThrow(/fetch-nonce not found/)
})

test('slugOf reads enterpriseSlug, trimming whitespace', () => {
  expect(slugOf({ enterpriseSlug: '  acme  ' })).toBe('acme')
})

test('slugOf throws when the enterprise slug is unset', () => {
  expect(() => slugOf({})).toThrow(/enterprise slug/i)
  expect(() => slugOf({ enterpriseSlug: '  ' })).toThrow(/enterprise slug/i)
})

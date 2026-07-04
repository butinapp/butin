import { expect, test } from 'vitest'

import { suggestIdentity } from './id.js'

test('derives the brand from a multi-label host', () => {
  expect(suggestIdentity('unagi.amazon.ca')).toEqual({ id: 'amazon', name: 'Amazon', vendor: 'Amazon' })
  expect(suggestIdentity('account.bellmedia.ca').id).toBe('bellmedia')
  expect(suggestIdentity('us.app.unleash-hosted.com').id).toBe('unleash-hosted')
})

test('uses the first label for a two-label host', () => {
  expect(suggestIdentity('serper.dev').id).toBe('serper')
  expect(suggestIdentity('www.stripe.com').id).toBe('stripe')
})

test('title-cases a hyphenated id for the display name', () => {
  expect(suggestIdentity('us.app.unleash-hosted.com').name).toBe('Unleash Hosted')
})

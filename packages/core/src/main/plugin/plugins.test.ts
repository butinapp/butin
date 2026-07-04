import type { ButinPlugin } from '@butinapp/sdk'
import { expect, test } from 'vitest'

import { acceptPlugin } from './plugins.js'

// A minimal shape-valid descriptor — acceptPlugin only reads meta.id, so the rest is filler.
const pluginWithId = (id: string): ButinPlugin =>
  ({ meta: { id, name: id }, auth: { kind: 'cookie' }, capabilities: [] }) as unknown as ButinPlugin

test('accepts a plugin whose meta.id equals its folder name and records the id', () => {
  const seen = new Set<string>()

  expect(acceptPlugin(pluginWithId('stripe'), 'stripe', seen)).toEqual({ ok: true })
  expect(seen.has('stripe')).toBe(true)
})

test('rejects a plugin whose meta.id mismatches its folder name', () => {
  const seen = new Set<string>()
  const verdict = acceptPlugin(pluginWithId('anthropic'), 'anthropic-console', seen)

  expect(verdict.ok).toBe(false)
  expect(verdict).toEqual({ ok: false, reason: 'meta.id "anthropic" must equal its folder name "anthropic-console"' })
  // A rejected plugin is NOT recorded, so a later well-formed plugin could still claim the id.
  expect(seen.size).toBe(0)
})

test('rejects the second plugin claiming an already-loaded id', () => {
  const seen = new Set<string>()

  expect(acceptPlugin(pluginWithId('groq'), 'groq', seen)).toEqual({ ok: true })

  const verdict = acceptPlugin(pluginWithId('groq'), 'groq', seen)

  expect(verdict).toEqual({ ok: false, reason: 'duplicate plugin id "groq" (already loaded)' })
})

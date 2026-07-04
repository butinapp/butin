import type { ButinPlugin } from '@butinapp/sdk'
import { expect, test } from 'vitest'

import { buildPluginDiagnostics, validatePlugin } from './validate-plugin.js'

// Minimal descriptor stub — validatePlugin/buildPluginDiagnostics only read meta/auth/transport/capabilities/probe.
const plugin = (over: Partial<ButinPlugin> & { id?: string }): ButinPlugin =>
  ({
    meta: { id: over.id ?? 'p', name: 'P', ...over.meta },
    auth: over.auth ?? { kind: 'cookie' },
    transport: over.transport,
    capabilities: over.capabilities ?? [{ id: 'a', kind: 'billing', label: 'A' }],
    probe: 'probe' in over ? over.probe : async () => {}
  }) as unknown as ButinPlugin

test('validatePlugin: clean descriptor has no problems', () => {
  expect(validatePlugin(plugin({}))).toEqual([])
})

test('validatePlugin: flags empty capabilities, duplicate ids, and missing name', () => {
  expect(validatePlugin(plugin({ capabilities: [] }))).toContain('has no capabilities (nothing to show)')

  const dup = validatePlugin(
    plugin({
      capabilities: [
        { id: 'x', label: 'X', collect: async () => ({ datasets: [] }) },
        { id: 'x', label: 'X2', collect: async () => ({ datasets: [] }) }
      ]
    } as Partial<ButinPlugin>)
  )

  expect(dup.some((m) => m.includes('duplicate capability id'))).toBe(true)

  expect(validatePlugin(plugin({ meta: { id: 'p', name: '  ' } } as Partial<ButinPlugin>))).toContain(
    'missing meta.name'
  )
})

test('validatePlugin: flags a plugin with no probe (a connection test must be one cheap request)', () => {
  expect(validatePlugin(plugin({ probe: undefined } as Partial<ButinPlugin>)).some((m) => m.includes('probe'))).toBe(
    true
  )
})

test('buildPluginDiagnostics: resolves transport engine (requiresBrowserEngine → electron) + auth kind', () => {
  const rows = buildPluginDiagnostics([
    plugin({ id: 'a', transport: { requiresBrowserEngine: true } } as Partial<ButinPlugin>),
    plugin({ id: 'b', auth: { kind: 'external' } } as Partial<ButinPlugin>)
  ])

  expect(rows[0]).toMatchObject({ id: 'a', transport: 'electron', sessionless: false })
  expect(rows[1]).toMatchObject({ id: 'b', transport: 'node', authKind: 'external', sessionless: true })
})

test('buildPluginDiagnostics: cross-plugin duplicate meta.id warns on every clashing row', () => {
  const rows = buildPluginDiagnostics([plugin({ id: 'dup' }), plugin({ id: 'dup' }), plugin({ id: 'solo' })])

  expect(rows.filter((r) => r.warnings.some((w) => w.includes('duplicate plugin id')))).toHaveLength(2)
  expect(rows.find((r) => r.id === 'solo')?.warnings).toEqual([])
})

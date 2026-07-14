import { describe, expect, it } from 'vitest'

import { EXPORT_BUNDLE_FORMAT_VERSION, parseExportBundle } from './export-bundle.js'

const validOverview = (pluginId: string) => ({
  pluginId,
  pluginName: pluginId,
  summaries: [{ section: 'spend', label: 'This month', value: 1, role: 'money' }]
})

const validPlugin = (id: string) => ({ meta: { id, name: id, capabilities: [] }, capabilities: [] })

const baseBundle = () => ({
  formatVersion: EXPORT_BUNDLE_FORMAT_VERSION,
  generatedAt: '2026-07-14T00:00:00.000Z',
  plugins: [validPlugin('stripe')],
  overview: [validOverview('stripe')] as unknown[]
})

describe('parseExportBundle', () => {
  it('keeps valid entries and drops a malformed one with a warning instead of rejecting the bundle', () => {
    const bundle = {
      ...baseBundle(),
      overview: [
        validOverview('linear'),
        // A summary missing `section`/`label` — the shape a service's cache carries if it predates the field.
        { pluginId: 'serper', pluginName: 'Serper', summaries: [{ value: 0, role: 'money' }] }
      ]
    }

    const result = parseExportBundle(bundle)

    expect(result.ok).toBe(true)

    if (!result.ok) {
      return
    }

    // The valid entry survives; the broken one is dropped.
    expect(result.bundle.overview.map((o) => o.pluginId)).toEqual(['linear'])

    const [warning] = result.warnings

    expect(warning).toContain("dropped overview[1] (service 'serper')")
    expect(warning).toContain('a field is absent')
  })

  it('has no warnings for a fully clean bundle', () => {
    const result = parseExportBundle(baseBundle())

    expect(result.ok).toBe(true)

    if (!result.ok) {
      return
    }

    expect(result.warnings).toEqual([])
    expect(result.bundle.overview).toHaveLength(1)
  })

  it('reports a present-but-wrong value without the absent-field hint', () => {
    const bundle = {
      ...baseBundle(),
      overview: [
        {
          pluginId: 'serper',
          pluginName: 'Serper',
          summaries: [{ section: 'nope', label: 'x', value: 0, role: 'money' }]
        }
      ]
    }

    const result = parseExportBundle(bundle)

    expect(result.ok).toBe(true)

    if (!result.ok) {
      return
    }

    expect(result.warnings[0]).toContain("service 'serper'")
    expect(result.warnings[0]).not.toContain('a field is absent')
  })

  it('still fails hard on a malformed envelope (missing generatedAt)', () => {
    const { generatedAt: _drop, ...rest } = baseBundle()
    const result = parseExportBundle(rest)

    expect(result.ok).toBe(false)

    if (result.ok) {
      return
    }

    expect(result.errors.some((e) => e.startsWith('generatedAt'))).toBe(true)
  })

  it('rejects a bundle from a newer format version with a clear message', () => {
    const result = parseExportBundle({ ...baseBundle(), formatVersion: EXPORT_BUNDLE_FORMAT_VERSION + 1 })

    expect(result.ok).toBe(false)

    if (result.ok) {
      return
    }

    expect(result.errors[0]).toContain('newer than this viewer supports')
  })
})

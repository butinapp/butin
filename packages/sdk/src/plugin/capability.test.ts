import { describe, expect, it } from 'vitest'

import { capabilityResult, record } from '../data/builders.js'
import type { CapabilityResult } from '../data/result.js'

import { type Capability, defineCapability } from './capability.js'

describe('Capability', () => {
  it('is a single collect shape; a downloadable table marks it with fetchFile', () => {
    const cap: Capability = {
      id: 'documents',
      label: 'Documents',
      collect: async () => ({ datasets: [] }),
      fetchFile: async () => new Uint8Array()
    }

    expect('collect' in cap).toBe(true)
    expect(typeof cap.fetchFile).toBe('function')
  })
})

// A build that stamps an input-derived marker into the result, so we can prove BOTH paths run the SAME build.
const build = (raw: { n: number }): CapabilityResult =>
  capabilityResult({
    sections: [record({ id: 'r', fields: [{ key: 'n', role: 'count', label: 'N' }], value: { n: raw.n } }).stat()]
  })

describe('defineCapability', () => {
  it('derives collect = build(fetch(ctx))', async () => {
    const cap = defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: async () => ({ n: 7 }),
      build,
      sample: () => ({ n: 3 })
    })

    const result = await cap.collect({} as never)

    expect(cap.id).toBe('usage')
    expect((result.datasets[0] as unknown as { value: { n: number } }).value.n).toBe(7)
  })

  it('derives sample = build(sample) through the same build', () => {
    const cap = defineCapability({
      id: 'usage',
      label: 'Usage',
      fetch: async () => ({ n: 7 }),
      build,
      sample: () => ({ n: 3 })
    })

    const sampled = cap.sample!()

    expect((sampled.datasets[0] as unknown as { value: { n: number } }).value.n).toBe(3)
  })

  it('accepts a generator sample and runs it through build with the given config', () => {
    const cap = defineCapability({
      id: 'gen',
      label: 'Gen',
      fetch: async () => ({ n: 0 }),
      build,
      sample: (g, config) => ({ n: g.int(0, 0) + config.users })
    })

    const sampled = cap.sample!({ seed: 'a', config: { users: 7, documents: 1, days: 1, window: 1 } })

    expect((sampled.datasets[0] as unknown as { value: { n: number } }).value.n).toBe(7)
  })

  it('passes fetchFile through when provided', () => {
    const fetchFile = async () => new Uint8Array()
    const cap = defineCapability({
      id: 'docs',
      label: 'Docs',
      fetch: async () => ({ n: 1 }),
      build,
      sample: () => ({ n: 1 }),
      fetchFile
    })

    expect(cap.fetchFile).toBe(fetchFile)
  })
})

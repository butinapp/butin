import type { ButinPlugin } from '@butinapp/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { activePartition, partitionFor, setActivePartition } from './shared-session.js'

const fakePlugin = (partition?: string): ButinPlugin =>
  ({ session: partition ? { partition } : undefined }) as unknown as ButinPlugin

afterEach(() => setActivePartition('persist:butin'))

describe('active partition', () => {
  it('defaults to persist:butin', () => {
    expect(activePartition()).toBe('persist:butin')
    expect(partitionFor(fakePlugin())).toBe('persist:butin')
  })

  it('reflects a profile switch', () => {
    setActivePartition('persist:butin-work')

    expect(partitionFor(fakePlugin())).toBe('persist:butin-work')
  })

  it("still honours a plugin's explicit partition override", () => {
    setActivePartition('persist:butin-work')

    expect(partitionFor(fakePlugin('persist:custom'))).toBe('persist:custom')
  })
})

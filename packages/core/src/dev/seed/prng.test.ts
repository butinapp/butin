import { describe, expect, it } from 'vitest'

import { hashSeed, mulberry32, seeded } from './prng.js'

describe('prng', () => {
  it('hashSeed is a stable 32-bit unsigned int', () => {
    expect(hashSeed('serper:usage')).toBe(hashSeed('serper:usage'))
    expect(hashSeed('serper:usage')).not.toBe(hashSeed('serper:billing'))
    expect(hashSeed('x') >>> 0).toBe(hashSeed('x'))
  })

  it('mulberry32 yields a deterministic sequence in [0,1)', () => {
    const a = mulberry32(123)
    const b = mulberry32(123)
    const xs = [a(), a(), a()]

    expect(xs).toEqual([b(), b(), b()])

    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
  })

  it('seeded is deterministic for the same parts and differs across parts', () => {
    expect(seeded('a', 1)()).toBe(seeded('a', 1)())
    expect(seeded('a', 1)()).not.toBe(seeded('a', 2)())
  })
})

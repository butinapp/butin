// Deterministic randomness for the demo seed: no Math.random / Date.now anywhere, so a seed run is reproducible.

export type Rng = () => number

// xfnv1a → a 32-bit unsigned hash, the seed for mulberry32.
export const hashSeed = (s: string): number => {
  let h = 2166136261 >>> 0

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }

  return h >>> 0
}

// mulberry32 PRNG: tiny, fast, good enough for synthetic data. Returns a generator of doubles in [0, 1).
export const mulberry32 = (seed: number): Rng => {
  let a = seed >>> 0

  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A generator seeded from joined string/number parts — so a draw depends only on its identity (plugin,
// capability, dataset, row, column, day), never on iteration order. That keeps the whole evolver order-stable.
export const seeded = (...parts: (string | number)[]): Rng => mulberry32(hashSeed(parts.join(':')))

import { describe, expect, it } from 'vitest'

import { convert, type FxRates } from './fx.js'

// rates[c] = value in the base/target currency of 1 unit of c. The target currency itself needs no entry.
const rates: FxRates = { CAD: 0.73, CHF: 1.12 }

describe('convert', () => {
  it('returns the amount unchanged when from === to', () => {
    expect(convert(100, 'USD', 'USD', rates)).toBe(100)
  })

  it('multiplies by the from-currency rate', () => {
    expect(convert(100, 'CAD', 'USD', rates)).toBeCloseTo(73)
    expect(convert(50, 'CHF', 'USD', rates)).toBeCloseTo(56)
  })

  it('returns null when the from currency has no rate', () => {
    expect(convert(100, 'JPY', 'USD', rates)).toBeNull()
  })
})

import { resolveCurrencies, validateCapabilityResult } from '@butinapp/sdk/data'
import { describe, expect, it } from 'vitest'

import { fallbackSnapshot } from './fallback.js'

describe('fallbackSnapshot', () => {
  // Validate post-resolveCurrencies, exactly as runCapability/synthesize do: a plugin's collect() emits money
  // values without a currency and relies on the reporting-currency stamp, so the fallback holds to the same bar.
  it.each(['summary', 'billing', 'usage', 'apiKeys', 'members', 'somethingElse'])(
    'produces a contract-valid result for %s',
    (id) => {
      expect(validateCapabilityResult(resolveCurrencies(fallbackSnapshot(id, `serper:${id}`), 'USD'))).toEqual([])
    }
  )

  it('is deterministic for the same seed', () => {
    expect(JSON.stringify(fallbackSnapshot('billing', 's'))).toBe(JSON.stringify(fallbackSnapshot('billing', 's')))
  })

  it('emits a spend summary for billing-family ids', () => {
    expect(fallbackSnapshot('summary', 's').summaries?.[0]?.section).toBe('spend')
  })
})

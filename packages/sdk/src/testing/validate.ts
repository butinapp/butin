import { type CurrencyCode, resolveCurrencies } from '../data/currency.js'
import { type CapabilityResult, validateCapabilityResult } from '../data/result.js'
import type { ButinPlugin } from '../plugin/plugin.js'

// Contract checks for a plugin's tests. A stored result is always currency-resolved before it is validated (core
// stamps the plugin's `reportingCurrency` onto every money value on the way to disk), so a test that validates a
// raw result would fail on the money-needs-a-currency rule for reasons the app never sees. These two apply that
// same resolution first.

// A validator bound to one currency — for asserting a result a test built itself.
export const resultValidator =
  (currency: CurrencyCode) =>
  (result: CapabilityResult): string[] =>
    validateCapabilityResult(resolveCurrencies(result, currency))

// Every capability's demo sample, drawn through the same `build` the live collector uses and validated against
// the contract. Returns one message per problem, `[]` when the plugin is clean — so a test is
// `expect(validateSamples(plugin)).toEqual([])` and names the offending capability on failure. The currency comes
// off the plugin itself, so a test cannot disagree with the `reportingCurrency` core actually stamps.
//
// A missing sample IS a failure: an unsampled capability falls back to the seed's generic shape, so the demo
// stops showing what the plugin really renders. `optional` names the capabilities allowed to have none — for an
// imperative collector that can't be split into fetch/build (a browser-backed one) — so the exception is
// declared at the assertion instead of the whole check being skipped.
//
// Generic in the plugin's config: `Capability<TConfig>` is contravariant in it, so a plugin declaring a config
// schema is not assignable to the bare `ButinPlugin`. Nothing here reads the config — only `sample()`.
export const validateSamples = <TConfig>(plugin: ButinPlugin<TConfig>, opts: { optional?: string[] } = {}): string[] =>
  plugin.capabilities.flatMap((cap) => {
    if (!cap.sample) {
      return opts.optional?.includes(cap.id) ? [] : [`${cap.id}: no sample declared`]
    }

    return resultValidator(plugin.reportingCurrency)(cap.sample()).map((error) => `${cap.id}: ${error}`)
  })

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { getFxConfig, resolveFxConfig, setFxConfig, type RateFetcher } from './fx-rates.js'
import { setDataRoot } from './store.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'butin-fx-'))
  setDataRoot(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('defaults to USD base with empty rates when nothing is stored', async () => {
  const cfg = await getFxConfig()

  expect(cfg.baseCurrency).toBe('USD')
  expect(cfg.rates).toEqual({})
})

test('round-trips a saved config', async () => {
  await setFxConfig({ baseCurrency: 'CAD', rates: { USD: 1.37, CHF: 1.53 }, source: 'manual' })

  const cfg = await getFxConfig()

  expect(cfg.baseCurrency).toBe('CAD')
  expect(cfg.rates.USD).toBeCloseTo(1.37)
  expect(cfg.source).toBe('manual')
})

// A fetcher that records its calls and never touches the network — resolveFxConfig stays offline-testable.
const stubFetcher = (rate: number | null): { fetch: RateFetcher; calls: [string, string][] } => {
  const calls: [string, string][] = []

  return { calls, fetch: async (from, to) => (calls.push([from, to]), rate) }
}

test('auto-picks the dominant currency as base and fetches only the foreign rates', async () => {
  const f = stubFetcher(null)
  const cfg = await resolveFxConfig(['CAD', 'CAD', 'CAD', 'USD'], f.fetch)

  expect(cfg.baseCurrency).toBe('CAD')
  // USD is foreign to the CAD base, so its rate is fetched; CAD (the base) never is.
  expect(f.calls).toEqual([['USD', 'CAD']])
})

test('a pure single-currency user triggers no fetch at all', async () => {
  const f = stubFetcher(null)
  const cfg = await resolveFxConfig(['CAD', 'CAD'], f.fetch)

  expect(cfg.baseCurrency).toBe('CAD')
  expect(f.calls).toEqual([])
  // Persisted so the next open is instant.
  expect((await getFxConfig()).baseCurrency).toBe('CAD')
})

test('fills a missing foreign rate from the fetcher and persists it', async () => {
  const f = stubFetcher(0.73)
  const cfg = await resolveFxConfig(['CAD', 'CAD', 'USD'], f.fetch)

  expect(cfg.baseCurrency).toBe('CAD')
  expect(cfg.rates.USD).toBeCloseTo(0.73)
  expect((await getFxConfig()).rates.USD).toBeCloseTo(0.73)
})

test('keeps a user-fixed base and never overwrites a hand-entered rate', async () => {
  await setFxConfig({ baseCurrency: 'USD', rates: { CAD: 0.7 }, source: 'manual', baseExplicit: true })
  const f = stubFetcher(0.99)
  const cfg = await resolveFxConfig(['CAD', 'CAD', 'CAD'], f.fetch)

  // CAD dominates but the explicit base wins; the manual CAD rate is preserved (no fetch).
  expect(cfg.baseCurrency).toBe('USD')
  expect(cfg.rates.CAD).toBeCloseTo(0.7)
  expect(f.calls).toEqual([])
})

test('offline (fetcher returns null) leaves the rate absent without throwing', async () => {
  const f = stubFetcher(null)
  const cfg = await resolveFxConfig(['CAD', 'USD'], f.fetch)

  expect(cfg.rates.USD).toBeUndefined()
})

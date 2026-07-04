import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { getFxConfig, setFxConfig } from './fx-rates.js'
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

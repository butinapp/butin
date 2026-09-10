import { expect, test } from 'vitest'

import { capabilityResult, record, table } from '../data/builders.js'
import type { ButinPlugin } from '../plugin/plugin.js'

import { resultValidator, validateSamples } from './validate.js'

const moneyResult = () =>
  capabilityResult({
    sections: [
      record<{ spend: number }>({
        id: 'account',
        fields: [{ key: 'spend', label: 'Spend', role: 'money' }],
        value: { spend: 12 }
      }).stat()
    ]
  })

// A capability whose sample draws the given result; `undefined` declares no sample at all.
const capability = (id: string, sample?: () => ReturnType<typeof moneyResult>) =>
  ({ id, label: id, collect: async () => moneyResult(), sample }) as ButinPlugin['capabilities'][number]

const plugin = (...capabilities: ButinPlugin['capabilities']): ButinPlugin =>
  ({ reportingCurrency: 'CAD', capabilities }) as ButinPlugin

test('a money result validates only once the plugin currency is resolved onto it', () => {
  // The bare result has no currency on its money field — the state a plugin returns and core then stamps.
  expect(resultValidator('CAD')(moneyResult())).toEqual([])
})

test('validateSamples draws every capability sample and passes a clean plugin', () => {
  expect(validateSamples(plugin(capability('summary', moneyResult), capability('billing', moneyResult)))).toEqual([])
})

test('validateSamples names the capability that has no sample', () => {
  expect(validateSamples(plugin(capability('summary', moneyResult), capability('usage')))).toEqual([
    'usage: no sample declared'
  ])
})

test('validateSamples prefixes a contract error with its capability id', () => {
  const broken = () =>
    capabilityResult({
      sections: [
        table<{ day: string; spend: number }>({
          id: 'daily',
          columns: [
            { key: 'day', label: 'Day', role: 'label' },
            { key: 'spend', label: 'Spend', role: 'money' }
          ],
          rows: []
          // A timeseries needs a timestamp x; 'day' is tagged label, so the chart binding is invalid.
        }).timeseries({ x: 'day', y: 'spend' })
      ]
    })

  expect(validateSamples(plugin(capability('usage', broken)))).toEqual([
    "usage: timeseries x 'day' must be a timestamp column"
  ])
})

test('accepts a plugin that declares a config schema', () => {
  // Capability<TConfig> is contravariant in TConfig, so a configured plugin must not need a cast at the call site.
  const configured = {
    reportingCurrency: 'CAD',
    capabilities: [capability('summary', moneyResult)]
  } as unknown as ButinPlugin<{ accountSlug: string }>

  expect(validateSamples(configured)).toEqual([])
})

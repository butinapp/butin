import { expect, test } from 'vitest'

import { makePluginText } from './plugin-text.js'

test('translates common English-canonical labels to French', () => {
  const tx = makePluginText('fr')

  expect(tx('Summary')).toBe('Résumé')
  expect(tx('Members')).toBe('Membres')
  expect(tx('This month by cluster')).toBe('Ce mois par grappe')
})

test('translates common French-canonical labels to English', () => {
  const tx = makePluginText('en')

  expect(tx('Sommaire')).toBe('Summary')
  expect(tx('Factures')).toBe('Invoices')
  expect(tx('Téléphone')).toBe('Phone')
})

test('passes unknown strings (service data, bespoke labels) through verbatim', () => {
  expect(makePluginText('fr')('prod-cluster-7')).toBe('prod-cluster-7')
  expect(makePluginText('en')('ada@example.test')).toBe('ada@example.test')
  expect(makePluginText('de' as never)('Summary')).toBe('Summary')
})

test('plugin messages override the global dict for domain terms', () => {
  const tx = makePluginText('en', { en: { Médicament: 'Medication', Summary: 'Overview' } })

  expect(tx('Médicament')).toBe('Medication')
  // a plugin override wins over the global mapping
  expect(tx('Summary')).toBe('Overview')
  // global still applies where the plugin is silent
  expect(tx('Factures')).toBe('Invoices')
})

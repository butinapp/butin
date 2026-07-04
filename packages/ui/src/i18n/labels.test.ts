import { expect, test } from 'vitest'

import { butinLabels, en, fr } from './labels.js'

test('plural helpers agree with count in both locales', () => {
  expect(en.reportCount(1)).toBe('1 report')
  expect(en.reportCount(3)).toBe('3 reports')
  expect(fr.reportCount(1)).toBe('1 rapport')
  expect(fr.reportCount(3)).toBe('3 rapports')
  expect(en.serviceCount(1)).toBe('1 service')
  expect(fr.serviceCount(2)).toBe('2 services')
})

test('interpolation helpers splice the argument', () => {
  expect(en.dataSaved('Billing')).toBe('Billing — data saved')
  expect(fr.dataSaved('Facturation')).toBe('Facturation — données sécurisées')
})

test('each locale carries its Intl tag for number/date formatting', () => {
  expect(en.intlLocale).toBe('en-US')
  expect(fr.intlLocale).toBe('fr-CA')
})

test('the registry exposes both locales', () => {
  expect(Object.keys(butinLabels).sort()).toEqual(['en', 'fr'])
})

import { expect, test } from 'vitest'

import {
  centsStringToMajor,
  centsToMajor,
  normalizeCurrency,
  parseDecimalAmount,
  parseFrAmount,
  millicentsToMajor,
  round2
} from './money.js'

test('centsToMajor converts cents to dollars and defaults to 0', () => {
  expect(centsToMajor(12345)).toBe(123.45)
  expect(centsToMajor()).toBe(0)
  expect(centsToMajor(null)).toBe(0)
})

test('centsStringToMajor parses a cents string', () => {
  expect(centsStringToMajor('9900')).toBe(99)
  expect(centsStringToMajor()).toBe(0)
})

test('millicentsToMajor converts thousandths of a cent', () => {
  expect(millicentsToMajor('100000')).toBe(1)
  expect(millicentsToMajor()).toBe(0)
})

test('parseDecimalAmount strips currency formatting', () => {
  expect(parseDecimalAmount('US $464.00')).toBe(464)
  expect(parseDecimalAmount('$1,234.56')).toBe(1234.56)
  expect(parseDecimalAmount()).toBe(0)
})

test('round2 sheds float noise to cents', () => {
  expect(round2(69.90000001)).toBe(69.9)
  expect(round2(0.1 + 0.2)).toBe(0.3)
})

test('parseFrAmount reads fr-CA money strings (space thousands sep, comma decimal, $ suffix)', () => {
  expect(parseFrAmount('24 716,80 $')).toBe(24716.8)
  expect(parseFrAmount('1 008,26 $')).toBe(1008.26)
  expect(parseFrAmount('18,79 $')).toBe(18.79)
  expect(parseFrAmount('18.79$')).toBe(18.79)
  expect(parseFrAmount('1 234,56 $')).toBe(1234.56)
  expect(parseFrAmount('1,234.56')).toBe(1234.56)
  expect(parseFrAmount('0,00 $')).toBe(0)
  expect(parseFrAmount(undefined)).toBe(0)
  expect(parseFrAmount(null)).toBe(0)
})

test('normalizeCurrency upper-cases whatever casing the service reported', () => {
  expect(normalizeCurrency('usd')).toBe('USD')
  expect(normalizeCurrency('CAD')).toBe('CAD')
})

test('normalizeCurrency falls back when the service sent nothing usable', () => {
  expect(normalizeCurrency(undefined)).toBe('USD')
  expect(normalizeCurrency(null)).toBe('USD')
  expect(normalizeCurrency('   ')).toBe('USD')
  expect(normalizeCurrency('', 'cad')).toBe('CAD')
})

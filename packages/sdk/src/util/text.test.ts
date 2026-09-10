import { expect, test } from 'vitest'

import { fullName, parseDollarAmount, squish, startCase } from './text.js'

test('startCase splits snake/kebab/camel and title-cases each word', () => {
  expect(startCase('team_tier_1')).toBe('Team Tier 1')
  expect(startCase('team-standard')).toBe('Team Standard')
  expect(startCase('monthlyCredit')).toBe('Monthly Credit')
  expect(startCase('paid')).toBe('Paid')
})

test('startCase lowercases the rest of each word and collapses whitespace', () => {
  expect(startCase('UNCOLLECTIBLE')).toBe('Uncollectible')
  expect(startCase('  open   invoice ')).toBe('Open Invoice')
})

test('startCase on empty/whitespace returns an empty string', () => {
  expect(startCase('')).toBe('')
  expect(startCase('   ')).toBe('')
})

test('squish collapses whitespace runs and trims, tolerating a missing value', () => {
  expect(squish('  Droplet   Snapshots\n  (5) ')).toBe('Droplet Snapshots (5)')
  expect(squish(null)).toBe('')
  expect(squish(undefined)).toBe('')
})

test('fullName joins the parts a service sent and skips the ones it did not', () => {
  expect(fullName('Ada', 'Lovelace')).toBe('Ada Lovelace')
  expect(fullName('  Ada  ', undefined)).toBe('Ada')
  expect(fullName(null, 'Lovelace')).toBe('Lovelace')
  // Empty rather than null, so a caller picks its own absent value with `|| null`.
  expect(fullName(null, null)).toBe('')
})

test('parseDollarAmount reads the value out of a pre-formatted currency string', () => {
  expect(parseDollarAmount('$233.30')).toBe(233.3)
  expect(parseDollarAmount('$1,204.55')).toBe(1204.55)
  expect(parseDollarAmount('$0.10')).toBe(0.1)
  // A currency prefix ahead of the symbol, and grouped thousands, both survive.
  expect(parseDollarAmount('US $464.00')).toBe(464)
  expect(parseDollarAmount('US $1,234,567.89')).toBeCloseTo(1234567.89, 2)
})

test('parseDollarAmount reads a negative and returns 0 for anything unparseable', () => {
  expect(parseDollarAmount('-42.50')).toBe(-42.5)
  expect(parseDollarAmount(undefined)).toBe(0)
  // The placeholders a scraped table puts in an empty cell.
  expect(parseDollarAmount('—')).toBe(0)
  expect(parseDollarAmount('-')).toBe(0)
  expect(parseDollarAmount('n/a')).toBe(0)
})

import { expect, test } from 'vitest'

import { startCase } from './text.js'

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

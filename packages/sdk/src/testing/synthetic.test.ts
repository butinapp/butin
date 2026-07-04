import { expect, test } from 'vitest'

import { createSampleGen, resolveSampleConfig } from './synthetic.js'

test('createSampleGen is deterministic: same seed → byte-identical output', () => {
  const a = createSampleGen('seed-x')
  const b = createSampleGen('seed-x')

  expect(a.repeat(20, (i, g) => [g.int(0, 1000), g.money(1, 50), g.id('k'), g.pastDate(365)])).toEqual(
    b.repeat(20, (i, g) => [g.int(0, 1000), g.money(1, 50), g.id('k'), g.pastDate(365)])
  )
})

test('the shared cast is stable across generators with different local seeds', () => {
  const a = createSampleGen('one')
  const b = createSampleGen('two')

  // person(i) is drawn from the constant-root cast → identical regardless of the local seed.
  expect(a.person(3)).toEqual(b.person(3))
  expect(a.people(5)).toEqual(b.people(5))
})

test('every email the toolkit emits is synthetic (@example.invalid)', () => {
  const g = createSampleGen('emails')

  for (const p of g.people(40)) {
    expect(p.email.endsWith('@example.invalid')).toBe(true)
  }

  expect(g.person().email.endsWith('@example.invalid')).toBe(true)
})

test('money/amountCents/dayString are well-formed and dates are slices of pastDate', () => {
  const g = createSampleGen('shapes')

  expect(g.money(10, 20)).toBeGreaterThanOrEqual(10)
  expect(Number.isInteger(g.amountCents(100, 200))).toBe(true)
  expect(g.dayString(30)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(g.maskedKey()).toMatch(/^…\d{4}$/)
})

test('resolveSampleConfig: default is medium; size preset then explicit overrides', () => {
  expect(resolveSampleConfig()).toEqual({ users: 12, documents: 20, days: 30, window: 180 })
  expect(resolveSampleConfig({ size: 'small' })).toEqual({ users: 3, documents: 5, days: 14, window: 60 })
  expect(resolveSampleConfig({ size: 'large', users: 7 })).toEqual({ users: 7, documents: 60, days: 120, window: 365 })
})

test('day() is internally coherent (date/iso/epoch all describe the same midnight UTC)', () => {
  const g = createSampleGen('days')
  const d = g.day(365)

  expect(d.iso).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/)
  expect(d.date).toBe(d.iso.slice(0, 10))
  expect(d.yearMonth).toBe(d.iso.slice(0, 7))
  expect(d.epochMs).toBe(Date.parse(d.iso))
  expect(d.epochSec).toBe(Math.floor(d.epochMs / 1000))
  expect(d.epochMs % 86_400_000).toBe(0) // midnight UTC is a whole number of days
})

test('midnightIso / pastEpochMs / pastEpochSec are UTC-midnight scalars', () => {
  const g = createSampleGen('epochs')

  expect(g.midnightIso(30)).toMatch(/T00:00:00\.000Z$/)
  expect(g.pastEpochMs(30) % 86_400_000).toBe(0) // whole days → midnight UTC
  expect(g.pastEpochSec(30) % 86_400).toBe(0)
  expect(Number.isInteger(g.pastEpochSec(30))).toBe(true)
})

test('monthsAgo counts back from the reference month (2026-06), deterministic', () => {
  const g = createSampleGen('months')

  expect(g.monthsAgo(0)).toMatchObject({ yearMonth: '2026-06', ym: '202606', label: 'June 2026' })
  expect(g.monthsAgo(1).yearMonth).toBe('2026-05')
  expect(g.monthsAgo(7).yearMonth).toBe('2025-11') // wraps the year
  expect(g.monthsAgo(0).startEpochMs).toBe(Date.UTC(2026, 5, 1, 0, 0, 0))
  expect(g.monthsAgo(0).startEpochSec).toBe(Math.floor(Date.UTC(2026, 5, 1, 0, 0, 0) / 1000))
})

test('postal() is a randomized format-valid code, never a fixed real FSA', () => {
  const g = createSampleGen('postal')
  const codes = g.repeat(20, (_i, gg) => gg.postal())

  for (const c of codes) {
    expect(c).toMatch(/^[ABCEGHJKLMNPRSTVXY]\d[ABCEGHJKLMNPRSTVXY] \d[ABCEGHJKLMNPRSTVXY]\d$/)
  }

  // randomized → not all identical (no fixed constant)
  expect(new Set(codes).size).toBeGreaterThan(1)
  expect(g.address()).toContain('rue')
})

test('url / moneyStr / seqId remove the common boilerplate', () => {
  const g = createSampleGen('helpers')

  expect(g.url('invoices', 'INV0007')).toBe('https://example.invalid/invoices/INV0007')
  expect(g.url('portal')).toBe('https://example.invalid/portal')
  expect(g.moneyStr(40, 80)).toMatch(/^\d+\.\d{2}$/)
  expect(g.moneyStr(40, 80, 4)).toMatch(/^\d+\.\d{4}$/)
  expect(g.seqId('INV', 7)).toBe('INV0007')
  expect(g.seqId('ORD', 1, 3)).toBe('ORD001')
})

test('large config yields more people than small', () => {
  const g = createSampleGen('scale')

  expect(g.people(resolveSampleConfig({ size: 'large' }).users).length).toBeGreaterThan(
    g.people(resolveSampleConfig({ size: 'small' }).users).length
  )
})

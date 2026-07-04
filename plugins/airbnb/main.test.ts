import { resolveCurrencies, validateCapabilityResult } from '@butinapp/sdk/data'
import { round2 } from '@butinapp/sdk/util'
import { expect, test } from 'vitest'

import {
  airbnbPlugin,
  buildAirbnbSummary,
  buildAirbnbTaxDocuments,
  buildAirbnbTransactions,
  extractUserId,
  type RawAirbnbSummary,
  type RawProductTransaction,
  type RawTaxDocument
} from './main.js'

const valid = (result: ReturnType<typeof buildAirbnbSummary>) =>
  validateCapabilityResult(resolveCurrencies(result, 'CAD'))

test('extractUserId reads the id out of the _user_attributes cookie', () => {
  const cookie =
    '_aat=0|abc; _user_attributes=%7B%22curr%22%3A%22CAD%22%2C%22id%22%3A100000001%2C%22id_str%22%3A%22100000001%22%7D; bev=1'

  expect(extractUserId(cookie)).toBe('100000001')
  expect(extractUserId('foo=bar')).toBeNull()
  expect(extractUserId(undefined)).toBeNull()
})

test('buildAirbnbSummary normalizes micros, sums YTD, and emits an other-section headline', () => {
  const raw: RawAirbnbSummary = {
    stats: {
      reconciledGrossEarningsTotal: [{ amountMicros: '1310000000', currency: 'CAD' }],
      payoutTransactionsTotal: [{ amountMicros: '635350000', currency: 'CAD' }],
      futureTransactionsTotal: [{ amountMicros: '4120080000', currency: 'CAD' }],
      reconciledServiceFeesTotal: [{ amountMicros: '-39300000', currency: 'CAD' }],
      reconciledOccupancyTaxesTotal: [{ amountMicros: '276580000', currency: 'CAD' }]
    },
    months: [
      { startDate: '2026-01-01T00:00:00.000Z', completedTotal: 1985.12, upcomingTotal: 0 },
      { startDate: '2026-02-01T00:00:00.000Z', completedTotal: 1207.65, upcomingTotal: 0 }
    ]
  }
  const result = buildAirbnbSummary(raw)

  expect(valid(result)).toEqual([])
  const stats = result.datasets.find((d) => d.id === 'stats')

  expect(stats?.shape).toBe('record')
  expect(stats?.shape === 'record' && stats.value).toMatchObject({ gross: 1310, payouts: 635.35, serviceFees: -39.3 })

  const summary = result.summaries?.[0]

  expect(summary).toMatchObject({ section: 'other', value: round2(1985.12 + 1207.65) })
  expect(summary?.spark).toEqual({ dataset: 'monthly', x: 'month', y: 'earned' })
})

test('buildAirbnbSummary tolerates missing stats + months', () => {
  expect(valid(buildAirbnbSummary({ stats: null, months: [] }))).toEqual([])
})

test('buildAirbnbTransactions builds a keyed table sorted by check-in', () => {
  const raw: RawProductTransaction[] = [
    {
      token: 't1',
      startDate: '2026-06-13',
      nights: 2,
      guestNames: ['Marie-Claude Gagnon'],
      hostingName: 'Chalet sur le lac',
      productConfirmationCode: 'HMDW4YTNNY',
      currencyAmount: { nativeCurrencyAmountFormatted: { amountMicros: '552900000', currency: 'CAD' } },
      transactionStatus: { localizedStatus: 'Scheduled', status: 'SCHEDULED' }
    },
    {
      token: 't2',
      startDate: '2026-07-01',
      nights: 3,
      guestNames: [],
      currencyAmount: { nativeCurrencyAmountFormatted: { amountMicros: '339500000' } },
      transactionStatus: { localizedStatus: 'Completed' }
    }
  ]
  const result = buildAirbnbTransactions(raw)

  expect(valid(result)).toEqual([])
  const ds = result.datasets.find((d) => d.id === 'transactions')

  expect(ds?.shape === 'table' && ds.key).toBe('token')
  // Newest check-in first; the unnamed guest degrades to '—' and the amount normalizes from micros.
  expect(ds?.shape === 'table' && ds.rows[0]).toMatchObject({ token: 't2', guest: '—', amount: 339.5 })
  expect(ds?.shape === 'table' && ds.rows[1]).toMatchObject({
    token: 't1',
    guest: 'Marie-Claude Gagnon',
    amount: 552.9,
    nights: 2
  })
})

test('buildAirbnbTaxDocuments lists documents newest-year first', () => {
  const raw: RawTaxDocument[] = [
    { metadata: { title: 'Canada Income Summary', taxYear: 2024, regulatoryAuthority: 'ca' } },
    { metadata: { title: 'Canada Income Summary', taxYear: 2025, regulatoryAuthority: 'ca' } }
  ]
  const result = buildAirbnbTaxDocuments(raw)

  expect(valid(result)).toEqual([])
  const ds = result.datasets.find((d) => d.id === 'taxDocuments')

  expect(ds?.shape === 'table' && ds.rows.map((r) => r.year)).toEqual(['2025', '2024'])
  expect(ds?.shape === 'table' && ds.rows[0]).toMatchObject({ authority: 'CA' })
})

test('every capability declares a sample that is contract-valid', () => {
  for (const cap of airbnbPlugin.capabilities) {
    expect(cap.sample, `${cap.id} has a sample`).toBeDefined()
    expect(validateCapabilityResult(resolveCurrencies(cap.sample!(), 'CAD')), cap.id).toEqual([])
  }
})

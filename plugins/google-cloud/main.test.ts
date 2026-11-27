import type { CapabilityResult } from '@butinapp/sdk/data'
import { resultValidator, validateSamples } from '@butinapp/sdk/testing'
import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'

import {
  billingDataRows,
  buildGoogleCloudBilling,
  buildGoogleCloudDays,
  buildGoogleCloudSummary,
  buildGoogleCloudUsage,
  googleCloudPlugin,
  moneyOf,
  sapisidAuthorization,
  type GoogleCloudBillingRaw,
  type RawBillingData,
  type RawQueryUsage
} from './main.js'

const validate = resultValidator('USD')

const dataset = (result: CapabilityResult, id: string) => result.datasets.find((d) => d.id === id)
const recordValue = (result: CapabilityResult, id: string) => {
  const ds = dataset(result, id)

  return ds?.shape === 'record' ? ds.value : undefined
}
const tableRows = (result: CapabilityResult, id: string) => {
  const ds = dataset(result, id)

  return ds?.shape === 'table' ? ds.rows : undefined
}

// Recorded shapes, invented values. QueryUsage days carry the full Money (units + nanos + asMicros); a zero-usage day
// is absent from the wire.
const USAGE: RawQueryUsage = {
  summary: { startTime: '2001-02-01T08:00:00Z', endTime: '2001-04-01T08:00:00Z' },
  usageResultsByUsageKey: {
    results: [
      {
        dataWithTime: [
          {
            actualStartTime: '2001-02-10T08:00:00Z',
            data: {
              cost: { currencyCode: 'CAD', units: '10', nanos: 500000000, asMicros: '10500000' },
              credit: { currencyCode: 'CAD', units: '0', nanos: 0, asMicros: '0' }
            }
          },
          {
            actualStartTime: '2001-02-11T08:00:00Z',
            data: { cost: { currencyCode: 'CAD', units: '4', nanos: 500000000, asMicros: '4500000' }, credit: null }
          },
          {
            actualStartTime: '2001-03-01T08:00:00Z',
            data: {
              cost: { currencyCode: 'CAD', units: '15', nanos: 0, asMicros: '15000000' },
              credit: { currencyCode: 'CAD', units: '-5', nanos: 0, asMicros: '-5000000' }
            }
          },
          {
            actualStartTime: '2001-03-02T08:00:00Z',
            data: {
              cost: { currencyCode: 'CAD', units: '0', nanos: 250000000, asMicros: '250000' },
              credit: { currencyCode: 'CAD', units: '0', nanos: -250000000, asMicros: '-250000' }
            }
          },
          { actualStartTime: null, data: null }
        ]
      }
    ]
  }
}

const BILLING: GoogleCloudBillingRaw = {
  month: '2001-03',
  account: {
    id: 'AAAAAA-BBBBBB-CCCCCC',
    displayName: 'Test Billing Account',
    currencyCode: 'cad',
    creationDate: '2000-01-02T03:04:05.000Z',
    state: { status: 'OPEN', reason: 'GOOD_STANDING' },
    billing3Config: { countryCode: 'CA', billingMethod: 'MONTHLY_CHARGE' }
  },
  usage: USAGE,
  // ForecastSpend money carries asMicros only.
  forecast: {
    forecastAvailability: 'AVAILABLE',
    forecastSummary: {
      combinedTotal: {
        cost: { currencyCode: 'CAD', asMicros: '30000000' },
        credit: { currencyCode: 'CAD', asMicros: '-6000000' }
      }
    }
  },
  // ListCredits money carries units + nanos only.
  credits: [
    {
      name: 'billingAccounts/AAAAAA-BBBBBB-CCCCCC/credits/credit-1',
      displayName: 'Test promotional credit',
      value: { currencyCode: 'CAD', units: '100', nanos: 500000000 },
      remainingAmount: { currencyCode: 'CAD', units: '0', nanos: 0 },
      startTime: '2001-01-01T08:00:00Z',
      endTime: '2002-01-01T08:00:00.123456789Z'
    }
  ]
}

const SERVICES: RawBillingData = {
  columnInfo: [
    'serviceId',
    'serviceName',
    'serviceDisplayName',
    'usageCostMicros',
    'negotiatedSavingsMicros',
    'savingsProgramsMicros',
    'otherSavingsMicros',
    'subtotalMicros',
    'percentChange'
  ].map((column) => ({ column })),
  rows: [
    {
      values: [
        { stringValue: '1111-2222-3333', int64Value: null, doubleValue: null },
        { stringValue: 'services/1111-2222-3333' },
        { stringValue: 'Test Service' },
        { int64Value: '20000000' },
        { int64Value: '0' },
        { int64Value: '-1000000' },
        { int64Value: '-4000000' },
        { int64Value: '15000000' },
        { doubleValue: 150 }
      ]
    }
  ]
}

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(googleCloudPlugin)).toEqual([])
})

test('sapisidAuthorization hashes "<ts> <cookie> <origin>" per APISID cookie present', () => {
  const sha = (secret: string) => createHash('sha1').update(`1000 ${secret} https://example.test`).digest('hex')
  const cookie = 'SID=x; SAPISID=aaa/bbb; __Secure-3PAPISID=ccc'

  expect(sapisidAuthorization(cookie, 'https://example.test', 1000)).toBe(
    `SAPISIDHASH 1000_${sha('aaa/bbb')} SAPISID3PHASH 1000_${sha('ccc')}`
  )
  expect(sapisidAuthorization('SID=x', 'https://example.test', 1000)).toBeUndefined()
})

test('moneyOf reads asMicros, else units + nanos', () => {
  expect(moneyOf({ asMicros: '-2500000' })).toBe(-2.5)
  expect(moneyOf({ units: '-3', nanos: -750000000 })).toBe(-3.75)
  expect(moneyOf(null)).toBe(0)
})

test('buildGoogleCloudDays sums cost and credits per day, ascending, skipping undated points', () => {
  expect(buildGoogleCloudDays(USAGE)).toEqual([
    { date: '2001-02-10', cost: 10.5, credits: 0, net: 10.5 },
    { date: '2001-02-11', cost: 4.5, credits: 0, net: 4.5 },
    { date: '2001-03-01', cost: 15, credits: -5, net: 10 },
    { date: '2001-03-02', cost: 0.25, credits: -0.25, net: 0 }
  ])
})

test('summary headlines net MTD in the account currency, with forecast and closed-month history', () => {
  const result = buildGoogleCloudSummary(BILLING)

  expect(validate(result)).toEqual([])
  expect(result.summaries?.[0]).toMatchObject({ section: 'spend', value: 10, currency: 'CAD', basis: 'accrued' })

  expect(recordValue(result, 'account')).toMatchObject({
    currentMtd: 10,
    forecast: 24,
    credits: -5.25,
    momDelta: -5,
    status: 'OPEN'
  })
  expect(tableRows(result, 'monthly')).toEqual([{ month: '2001-02', amount: 15 }])
})

test('summary omits the forecast card when the gateway has no forecast', () => {
  const result = buildGoogleCloudSummary({ ...BILLING, forecast: { forecastAvailability: 'NOT_ENOUGH_HISTORY' } })

  expect(validate(result)).toEqual([])
  expect(recordValue(result, 'account')).not.toHaveProperty('forecast')
})

test('billing tab carries the account, the month breakdown, and the credits table', () => {
  const result = buildGoogleCloudBilling(BILLING)

  expect(validate(result)).toEqual([])
  expect(result.summaries).toBeUndefined()

  expect(recordValue(result, 'account')).toEqual({
    name: 'Test Billing Account',
    id: 'AAAAAA-BBBBBB-CCCCCC',
    status: 'OPEN',
    method: 'Monthly Charge',
    country: 'CA',
    currency: 'cad',
    created: '2000-01-02'
  })
  expect(recordValue(result, 'month')).toEqual({ cost: 15.25, credits: -5.25, net: 10 })
  expect(tableRows(result, 'credits')).toEqual([
    {
      id: 'billingAccounts/AAAAAA-BBBBBB-CCCCCC/credits/credit-1',
      name: 'Test promotional credit',
      value: 100.5,
      remaining: 0,
      start: '2001-01-01',
      end: '2002-01-01'
    }
  ])
  const credits = dataset(result, 'credits')

  expect(credits?.shape === 'table' && credits.columns.find((c) => c.key === 'value')?.currency).toBe('CAD')
})

test('billing tab drops the credits table when the account has none', () => {
  const result = buildGoogleCloudBilling({ ...BILLING, credits: [] })

  expect(result.datasets.map((d) => d.id)).not.toContain('credits')
})

test('billingDataRows names positional cells by their column alias', () => {
  expect(billingDataRows(SERVICES)[0]).toMatchObject({
    serviceDisplayName: 'Test Service',
    usageCostMicros: '20000000',
    percentChange: 150
  })
  expect(billingDataRows({})).toEqual([])
})

test('usage tab lists cost by service and the open month daily net cost', () => {
  const result = buildGoogleCloudUsage({ month: '2001-03', currency: 'CAD', usage: USAGE, services: SERVICES })

  expect(validate(result)).toEqual([])

  expect(tableRows(result, 'services')).toEqual([
    { service: 'Test Service', usageCost: 20, savings: -5, subtotal: 15, change: 1.5 }
  ])
  expect(tableRows(result, 'daily')).toEqual([
    { date: '2001-03-01', cost: 10 },
    { date: '2001-03-02', cost: 0 }
  ])
})

// Synthetic sample generators for the demo seed — each builds a raw gateway payload from the seeded toolkit, and
// `pnpm seed-demo` draws it through the same `build` the live collector uses.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'
import { dayMinus } from '@butinapp/sdk/util'

import type { GoogleCloudBillingRaw, GoogleCloudUsageRaw, RawMoney, RawQueryUsage } from './main.js'

const SERVICES = ['Compute Engine', 'Cloud Storage', 'BigQuery', 'Cloud Run', 'Vertex AI', 'Cloud SQL', 'Networking']

const micros = (amount: number, currencyCode = 'USD'): RawMoney => ({
  currencyCode,
  asMicros: String(Math.round(amount * 1_000_000))
})

// Daily cost from the first of the month `HISTORY` months back through the generator's reference day, one point per
// day (Pacific midnight, as the gateway stamps it). Credits offset a share of each day's cost.
const sampleUsage = (g: SampleGen): { month: string; usage: RawQueryUsage } => {
  const month = g.monthsAgo(0).yearMonth
  const start = `${g.monthsAgo(5).yearMonth}-01`
  const today = `${month}-17`
  const days: string[] = []

  for (let day = today; day >= start; day = dayMinus(day, 1)) {
    days.unshift(day)
  }

  return {
    month,
    usage: {
      usageResultsByUsageKey: {
        results: [
          {
            dataWithTime: days.map((date) => {
              const cost = g.float(0.5, 40, 2)

              return {
                actualStartTime: `${date}T07:00:00Z`,
                data: { cost: micros(cost), credit: micros(-cost * g.float(0, 0.5, 2)) }
              }
            })
          }
        ]
      }
    }
  }
}

export const sampleGoogleCloudBilling = (g: SampleGen, config: SampleConfig): GoogleCloudBillingRaw => {
  const { month, usage } = sampleUsage(g)

  return {
    month,
    account: {
      id: '012345-6789AB-CDEF01',
      displayName: 'Demo Billing Account',
      currencyCode: 'USD',
      creationDate: `${g.monthsAgo(24).yearMonth}-03T12:00:00Z`,
      state: { status: 'OPEN', reason: 'GOOD_STANDING' },
      billing3Config: { countryCode: 'US', billingMethod: 'MONTHLY_CHARGE' }
    },
    usage,
    forecast: {
      forecastAvailability: 'AVAILABLE',
      forecastSummary: { combinedTotal: { cost: micros(g.money(300, 900)), credit: micros(-g.money(20, 150)) } }
    },
    credits: g.repeat(Math.min(config.documents, 3), (i) => {
      const value = g.money(25, 300)

      return {
        name: `billingAccounts/012345-6789AB-CDEF01/credits/${g.id('credit')}`,
        displayName: `${g.pick(['Free trial', 'Promotional', 'Program benefit'])} credit ${i + 1}`,
        value: micros(value),
        remainingAmount: micros(value * g.float(0, 1, 2)),
        startTime: `${g.monthsAgo(i + 1).yearMonth}-01T08:00:00Z`,
        endTime: `${g.monthsAgo(i - 11).yearMonth}-01T08:00:00Z`
      }
    })
  }
}

export const sampleGoogleCloudUsage = (g: SampleGen): GoogleCloudUsageRaw => {
  const { month, usage } = sampleUsage(g)

  return {
    month,
    currency: 'USD',
    usage,
    services: {
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
      rows: SERVICES.slice(0, g.int(3, SERVICES.length)).map((name) => {
        const cost = g.money(5, 400)
        const savings = -cost * g.float(0, 0.4, 2)
        const id = g.id('svc')

        return {
          values: [
            { stringValue: id },
            { stringValue: `services/${id}` },
            { stringValue: name },
            { int64Value: String(Math.round(cost * 1e6)) },
            { int64Value: '0' },
            { int64Value: '0' },
            { int64Value: String(Math.round(savings * 1e6)) },
            { int64Value: String(Math.round((cost + savings) * 1e6)) },
            { doubleValue: g.float(-60, 120, 2) }
          ]
        }
      })
    }
  }
}

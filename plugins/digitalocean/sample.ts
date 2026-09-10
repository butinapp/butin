// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector
// uses. Money is a decimal USD string on the billing wire and a `$`-formatted string inside the invoice summary;
// facet usage/limits are strings, and a bytes facet is raw bytes. `documents` caps the invoice history, `days` the
// month's spend curve.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { RawBillingHistoryEntry, RawDigitalOceanBilling, RawDigitalOceanUsage, RawDisplayEntry } from './main.js'

// DigitalOcean's own product names + limit facets — a structural catalog, not personal data. The facets are a
// subset of the ones main.ts meters (main.test.ts holds them to that).
const PRODUCTS = ['Droplets', 'Managed Databases', 'Spaces', 'Droplet Snapshots'] as const

export const SAMPLE_FACETS = [
  'DROPLET_COUNT',
  'DBAAS_CLUSTER_COUNT',
  'VOLUME_COUNT',
  'VOLUME_GLOBAL_CAPACITY_BYTES',
  'DOMAIN_COUNT',
  'FLOATING_IP_COUNT',
  'LBAAS_GLOBAL_COUNT'
] as const

const dollars = (amount: number): string => `$${amount.toFixed(2)}`

// One product category with its individual resources beneath it, the shape the invoice summary nests.
const sampleCategory = (g: SampleGen, product: string, resources: number): RawDisplayEntry => {
  const sub_items = g.repeat(resources, (i) => ({
    type: product,
    description: `${g.orgSlug()}-${g.seqId('', i + 1, 3)} (${g.pick(['nyc3', 'tor1', 'fra1'])})`,
    extra_detail: `${g.int(24, 720)} hours`,
    amount: dollars(g.money(1, 40)),
    sub_items: null
  }))

  return {
    type: product,
    description: `${product} (${resources})`,
    extra_detail: null,
    amount: dollars(sub_items.reduce((sum, s) => sum + Number(s.amount.slice(1)), 0)),
    sub_items
  }
}

// Each month issues an invoice on the 1st and settles it with a card payment a day later.
const sampleHistory = (g: SampleGen, months: number, urn: string): RawBillingHistoryEntry[] =>
  g
    .repeat(months, (i) => {
      const { yearMonth, label } = g.monthsAgo(i)
      const amount = g.moneyStr(120, 900)

      return [
        {
          description: `Invoice for ${label}`,
          amount,
          date: `${yearMonth}-01T04:12:00.000Z`,
          type: 'Invoice',
          invoice_uuid: g.id('inv'),
          receipt_id: null,
          account_urn: urn
        },
        {
          description: `Payment (card ending in ${g.last4()})`,
          amount: `-${amount}`,
          date: `${yearMonth}-02T06:30:00.000Z`,
          type: 'Payment',
          invoice_uuid: null,
          receipt_id: g.seqId('', i + 1, 9),
          account_urn: urn
        }
      ]
    })
    .flat()

export const sampleDigitalOceanBilling = (g: SampleGen, config: SampleConfig): RawDigitalOceanBilling => {
  const uuid = g.id('team').replace(/[^a-z0-9]/g, '')
  const urn = `do:team:${uuid}`
  const categories = PRODUCTS.map((p) => sampleCategory(g, p, g.int(1, 5)))
  const subtotal = categories.reduce((sum, c) => sum + Number((c.amount ?? '$0').slice(1)), 0)
  const taxes = subtotal * 0.14
  const mtd = subtotal + taxes
  const { yearMonth } = g.monthsAgo(0)

  return {
    team: { uuid, urn, name: g.company(), role: 'Owner' },
    summary: {
      payment_due_date: `${g.monthsAgo(-1).yearMonth}-01T00:00:00.000Z`,
      total_usage_amount: mtd.toFixed(2),
      past_due_amount: '0.00',
      estimated_due: mtd.toFixed(2)
    },
    insights: {
      current_mtd_spend: mtd.toFixed(2),
      projected_month_spend: (mtd * 3).toFixed(2),
      daily_average_spend: (mtd / 9).toFixed(2)
    },
    credits: g.moneyStr(0, 200),
    history: sampleHistory(g, Math.min(config.documents, 18), urn),
    invoice: {
      billing_start: `${yearMonth}-01`,
      issue_date: `${yearMonth}-09`,
      invoice_generated_at: `${yearMonth}-09T04:08:12Z`,
      usage_items: categories,
      subtotal: { type: 'Subtotal', description: 'Subtotal', extra_detail: null, amount: dollars(subtotal) },
      discounts: null,
      credits: null,
      taxes: { type: 'Taxes', description: 'Taxes', extra_detail: null, amount: dollars(taxes) },
      total: { type: 'Total', description: 'Total', extra_detail: null, amount: dollars(mtd) }
    },
    paymentMethods: [
      {
        id: g.id('pm'),
        description: `${g.pick(['Visa', 'Mastercard'])} ending in ${g.last4()}`,
        type: 'card',
        expiration_date: `0${g.int(1, 9)}/20${g.int(28, 34)}`,
        is_default: true
      }
    ],
    address: {
      address_line1: g.address(),
      address_line2: null,
      city: null,
      region: null,
      country_iso2_code: 'CA',
      postal_code: null
    },
    tax: { tax_name: 'GST+QST', tax_rate: '14.975', tax_location_name: 'Canada' }
  }
}

export const sampleDigitalOceanUsage = (g: SampleGen, config: SampleConfig): RawDigitalOceanUsage => {
  const { yearMonth } = g.monthsAgo(0)
  let running = 0

  return {
    facetUsage: SAMPLE_FACETS.map((facet) => ({
      facet,
      usage: facet.endsWith('_BYTES') ? String(g.int(1, 40) * 1024 ** 3) : String(g.int(0, 12)),
      error: ''
    })),
    limits: SAMPLE_FACETS.map((facet) => ({
      facet,
      limit: facet.endsWith('_BYTES') ? String(g.int(60, 200) * 1024 ** 3) : String(g.int(15, 60))
    })),
    // The wire reports the month's RUNNING total per day, so the series only ever climbs.
    daily: g.repeat(Math.min(config.days, 28), (i) => {
      running += g.money(2, 45)

      return { date: `${yearMonth}-${String(i + 1).padStart(2, '0')}`, amount: running.toFixed(2) }
    })
  }
}

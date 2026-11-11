// Synthetic sample GENERATORS for the demo seed — each builds a raw admin-API payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector
// uses. The `users` knob sizes the roster + seat count, `documents` the invoice history.
//
// Money is Stripe-shaped CENTS and the subscription's period bounds epoch MILLISECONDS, as on the wire.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'
import { MS_PER_DAY } from '@butinapp/sdk/util'

import type { RawKey, RawKeyList, RawSubscriptionData, RawTailscaleBilling, RawUserList } from './main.js'

const PLAN = { name: 'Premium', id: 'hybrid_premium' }

// The subscription + plan-usage read Usage draws on its own and Summary/Billing bundle with the invoices.
export const sampleTailscaleSubscription = (g: SampleGen, config: SampleConfig): RawSubscriptionData => {
  const seats = Math.max(3, config.users)
  const seatCents = g.amountCents(400, 3000)
  const periodStart = g.monthsAgo(0).startEpochMs
  const periodEnd = periodStart + 30 * MS_PER_DAY
  const changedAt = periodStart + g.int(3, 20) * MS_PER_DAY
  const subtotal = seats * seatCents
  const taxPercent = g.pick([0, 5, 10])
  const tax = Math.round((subtotal * taxPercent) / 100)
  const devices = g.int(seats, seats * 4)
  const taggedLimit = g.int(50, 500)
  const ephemeralLimit = g.int(1_000, 10_000)
  const proration = (sign: number, verb: string, qty: number) => ({
    amount: sign * g.amountCents(100, seatCents),
    description: `${verb} time on ${qty} × ${PLAN.name} after ${g.dayString(20)}`,
    periodStart: changedAt,
    periodEnd,
    quantity: qty
  })

  return {
    subscription: {
      status: 'active',
      readableProductID: PLAN.id,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      items: { [g.id('price')]: { productName: PLAN.name, readableProductID: PLAN.id, quantity: seats } },
      billingCard: { brand: g.pick(['visa', 'mastercard', 'amex']), lastFour: g.last4() },
      customerDetails: { name: g.company(), email: g.person(0).email },
      upcomingInvoice: {
        dueDate: periodEnd,
        subtotal,
        tax,
        total: subtotal + tax,
        lineItems: [proration(-1, 'Unused', seats - 1), proration(1, 'Remaining', seats)],
        totalTaxAmounts: taxPercent > 0 ? [{ amount: tax, displayName: 'VAT', percentage: taxPercent }] : []
      }
    },
    billingUsage: {
      allowance: {
        users: { total: { amount: seats, unlimited: false } },
        occupied_seats: { total: { amount: 0, unlimited: true } },
        active_users: { total: { amount: 0, unlimited: true } },
        admin_users: { total: { amount: 0, unlimited: true } },
        devices: { total: { amount: 0, unlimited: true } },
        tag_devices: { total: { amount: taggedLimit, unlimited: false } },
        subnets: { total: { amount: 0, unlimited: true } },
        ephemeral_minutes: { total: { amount: ephemeralLimit, unlimited: false } }
      },
      usage: {
        users: seats,
        occupied_seats: seats,
        active_users: g.int(1, seats),
        active_users_valid: true,
        admin_users: g.int(1, Math.min(3, seats)),
        devices,
        tag_devices: g.int(0, Math.min(taggedLimit, devices)),
        subnets: g.int(0, 4),
        ephemeral_minutes: g.int(0, ephemeralLimit)
      }
    }
  }
}

// Summary + Billing: the subscription plus one advance invoice per month, issued on the 1st.
export const sampleTailscaleBilling = (g: SampleGen, config: SampleConfig): RawTailscaleBilling => ({
  subscription: sampleTailscaleSubscription(g, config),
  invoices: {
    invoices: g.repeat(Math.min(config.documents, 24), (i) => {
      const id = g.id('in')

      return {
        id,
        created: `${g.monthsAgo(i).yearMonth}-01T00:00:00Z`,
        status: 'paid',
        total: g.amountCents(5_000, 80_000),
        invoicePDFUrl: g.url('invoice', `${id}/pdf`)
      }
    })
  }
})

export const sampleTailscaleUsers = (g: SampleGen, config: SampleConfig): RawUserList => ({
  users: g.people(config.users).map((p, i) => ({
    id: g.id('u'),
    stableId: g.id('s'),
    displayName: p.name,
    loginName: p.email,
    role: i === 0 ? 'owner' : i === 1 ? 'admin' : g.pick(['member', 'member', 'member', 'it-admin', 'auditor']),
    created: g.midnightIso(700),
    lastSeen: g.midnightIso(30),
    deviceCount: g.int(0, 6)
  }))
})

export const sampleTailscaleKeys = (g: SampleGen, config: SampleConfig): RawKeyList => {
  const creator = (): string => g.person(g.int(0, Math.max(0, config.users - 1))).email
  const key = (keyType: string, extra: Partial<RawKey> = {}, lifetimeDays = 90): RawKey => {
    const created = g.day(80)

    return {
      id: g.id('k'),
      keyType,
      description: g.words(2),
      creator: creator(),
      created: created.iso,
      expires: new Date(created.epochMs + lifetimeDays * MS_PER_DAY).toISOString(),
      ...extra
    }
  }
  const tags = (): string[] => [`tag:${g.pick(['server', 'ci', 'k8s', 'prod'])}`]

  return {
    keys: [
      key('auth', { capabilities: { devices: { create: { reusable: true, preauthorized: true, tags: tags() } } } }),
      key('auth', { capabilities: { devices: { create: { ephemeral: true, tags: tags() } } } }),
      key('api'),
      key('client', { tags: tags() }),
      key('auth', { invalid: true }, 1),
      key('api', { invalid: true, revoked: g.midnightIso(5) })
    ]
  }
}

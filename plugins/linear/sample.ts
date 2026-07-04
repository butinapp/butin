// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live
// collector uses. `documents` caps the invoice history; `users` drives the workspace roster.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { RawLinearBilling, RawLinearInvoice, RawUsersResponse } from './main.js'

// Monthly subscription invoices (cents — the Stripe wire unit; build runs centsToMajor), newest first, so the
// Summary monthly-spend chart and the Billing invoice table both fill out. billingDetails carries the latest
// page + contact / tax / payment method; invoiceList carries the full list.
export const sampleLinearBilling = (g: SampleGen, config: SampleConfig): RawLinearBilling => {
  const n = Math.min(config.documents, 36)
  const monthly = g.amountCents(6_000, 18_000)
  const invoices: RawLinearInvoice[] = g.repeat(n, (i) => ({
    created: `${g.monthsAgo(i).yearMonth}-01T00:00:00.000Z`,
    dueDate: null,
    status: 'paid',
    total: monthly + g.amountCents(0, 4_000),
    url: `https://invoice.example.invalid/${g.id('inv')}`,
    kind: 'subscription'
  }))

  return {
    details: {
      billingDetails: {
        success: true,
        name: g.company(),
        email: g.person().email,
        taxId: { type: 'ca_qst', value: `${g.int(1_000_000_000, 1_999_999_999)}TQ0001` },
        paymentMethod: { type: 'card', country: 'US', brand: g.pick(['visa', 'mastercard', 'amex']), last4: g.last4() },
        invoices: invoices.slice(0, 1)
      }
    },
    invoiceList: { billingInvoices: { success: true, invoices } }
  }
}

// Workspace roster — first member is admin, with a guest + a suspended (inactive) member to exercise the
// role mapping when the roster is large enough.
export const sampleLinearMembers = (g: SampleGen, config: SampleConfig): RawUsersResponse => ({
  users: {
    nodes: g.people(config.users).map((p, i) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      admin: i === 0,
      guest: i === 3,
      active: i !== 4
    }))
  }
})

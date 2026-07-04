// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector
// uses. Money in the billing + analytics bundles is in MINOR units (cents), matching the wire; the builds
// normalize cents→major. `documents` caps the invoice count; `users` drives the member roster.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'
import { MONTH_ABBR } from '@butinapp/sdk/util'

import type { AnthropicAnalyticsRaw, AnthropicBillingRaw, RawConsoleInvoice, RawRosterMember } from './main.js'

// Monthly usage invoices (billed in arrears so effective ~1st of the next month) plus a prepaid-credits top-up.
// amount is CENTS; usage invoices carry a service_period the build dates them by. The service period is derived
// from a generated month so there's no literal calendar.
const billingInvoices = (g: SampleGen, count: number): RawConsoleInvoice[] => {
  const out: RawConsoleInvoice[] = g.repeat(count, (i) => {
    const period = g.monthsAgo(i)
    const [, periodMonth] = period.yearMonth.split('-').map(Number)
    const monthName = MONTH_ABBR[(periodMonth ?? 1) - 1]!
    const [periodYear] = period.yearMonth.split('-')
    const effective = g.monthsAgo(i - 1) // billed in arrears: effective on the 1st of the next month

    return {
      type: 'usage_invoice',
      invoice_status: 'paid',
      effective_at: `${effective.yearMonth}-01T00:00:00Z`,
      amount: g.amountCents(80_00, 400_00),
      service_period: `${monthName} 01 ${periodYear} - ${monthName} 28 ${periodYear}`,
      download_url: `https://example.invalid/invoices/${g.id('usage')}.pdf`,
      hosted_invoice_url: g.url('invoices', g.id('usage'))
    }
  })

  out.push({
    type: 'prepaid_credits',
    invoice_status: 'paid',
    effective_at: g.midnightIso(60),
    amount: g.amountCents(300_00, 800_00),
    service_period: null,
    download_url: `https://example.invalid/invoices/${g.id('credits')}.pdf`,
    hosted_invoice_url: g.url('invoices', g.id('credits'))
  })

  return out
}

export const sampleAnthropicBilling = (g: SampleGen, config: SampleConfig): AnthropicBillingRaw => ({
  capturedAt: g.pastDate(0),
  bundle: {
    invoices: billingInvoices(g, Math.min(config.documents, 36)),
    currentSpend: { amount: g.amountCents(100_00, 400_00), resets_at: g.midnightIso(0) },
    spendLimits: { spend_limits: [{ limit_usd: 1_000_00, limit_action: 'notify_and_pause' }] },
    paymentMethod: { brand: g.pick(['visa', 'mastercard', 'amex']), last4: g.last4() },
    billingEmails: { primary_email: g.person(0).email },
    currency: 'USD'
  }
})

// Members each owning one active key, plus an extra unattributed key in the spend. Four months of cost (newest
// first) so the per-member table shows this-month + last-month and the org rolls up an open-period total.
export const sampleAnthropicAnalytics = (g: SampleGen, config: SampleConfig): AnthropicAnalyticsRaw => {
  const months = g.repeat(4, (i) => {
    const m = g.monthsAgo(i)
    const [year, month] = m.yearMonth.split('-').map(Number)

    return { periodStart: `${m.yearMonth}-01`, label: `${MONTH_ABBR[(month ?? 1) - 1]} ${year}` }
  })

  const members = g.people(config.users).map((p, i) => ({
    id: p.id,
    email: p.email,
    name: p.name,
    role: g.pick(['developer', 'admin', 'billing']),
    cents: g.amountCents(10_00, 160_00),
    lastUsed: g.midnightIso(i)
  }))

  const unknownCents = g.amountCents(8_00, 20_00)

  return {
    capturedAt: g.pastDate(0),
    bundle: {
      members: members.map((m) => ({ id: m.id, email: m.email, name: m.name, role: m.role })),
      apiKeys: [
        ...members.map((m, i) => ({
          id: `k_${m.id}`,
          name: `${m.name.split(' ')[0]?.toLowerCase() ?? 'user'}-prod`,
          workspace_id: null,
          created_at: g.midnightIso(90 + i),
          status: 'active',
          expires_at: null,
          partial_key_hint: `sk-ant-…${g.last4()}`,
          created_by: { id: m.id }
        })),
        {
          id: 'k_legacy',
          name: 'legacy-ci',
          workspace_id: null,
          created_at: g.midnightIso(200),
          status: 'inactive',
          expires_at: null,
          partial_key_hint: `sk-ant-…${g.last4()}`,
          created_by: { id: members[0]?.id ?? 'unknown' }
        }
      ],
      keyUsage: { api_keys: members.map((m) => ({ id: `k_${m.id}`, last_used_at: m.lastUsed })) },
      // Each month ramps the per-key spend down for older months so the trend reads as growth; one unknown key
      // lands in the Unattributed bucket. total is CENTS.
      monthlyCosts: months.map((mc, monthIdx) => ({
        periodStart: mc.periodStart,
        label: mc.label,
        cost: {
          costs: {
            d1: [
              ...members.map((m) => ({ key_id: `k_${m.id}`, total: Math.round(m.cents * (1 - monthIdx * 0.18)) })),
              { key_id: 'k_unknown', total: Math.round(unknownCents * (1 - monthIdx * 0.18)) }
            ]
          }
        }
      })),
      orgCurrentSpendCents: members.reduce((sum, m) => sum + m.cents, 0) + unknownCents
    }
  }
}

export const sampleAnthropicMembers = (g: SampleGen, config: SampleConfig): RawRosterMember[] =>
  g.people(config.users).map((p) => ({
    id: p.id,
    email: p.email,
    name: p.name,
    role: g.pick(['admin', 'developer', 'billing'])
  }))

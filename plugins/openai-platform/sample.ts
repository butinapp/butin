// Synthetic sample GENERATORS for the demo seed — each builds a raw service-response bundle purely from the
// seeded synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live
// collector uses. Money on the wire is CENTS (invoice totals + usage line-item costs); the *_usd limits are
// already dollars; created/period_start/timestamp/last_use are unix SECONDS. The build normalizes cents→USD.
// `documents` caps invoice history + key/usage lists; `users` drives the org roster.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { OpenaiBillingRaw, OpenaiKeysRaw, OpenaiMembersRaw, RawDailyCost, RawInvoice } from './main.js'

// A masked key hint in OpenAI's already-redacted wire shape (sk-<segment>…<4>) — never a real secret.
const maskedSk = (g: SampleGen): string => `sk-${g.pick(['svcac', 'proj', 'user'])}${'*'.repeat(4)}${g.last4()}`

// One arrears invoice per month, dated by period_start (the usage month), issued the 1st of the next month.
// Totals climb so the monthly-spend chart has a visible trend.
const invoiceHistory = (g: SampleGen, n: number, baseCents: number, growthCents: number): RawInvoice[] =>
  g.repeat(n, (i) => {
    const total = baseCents + i * growthCents

    return {
      id: g.id('in'),
      number: `INV-00${40 + i}`,
      total,
      amount_due: total,
      tax: Math.round(total * 0.05),
      created: g.monthsAgo(i).startEpochSec, // issued the 1st of the billed month
      period_start: g.monthsAgo(i + 1).startEpochSec, // usage month = the previous month
      period_end: g.monthsAgo(i).startEpochSec,
      status: 'paid',
      hosted_invoice_url: g.url('invoice', g.id('hi')),
      pdf_url: `https://example.invalid/invoice/${g.id('pdf')}.pdf`
    }
  })

// Current-month daily usage, deterministic walk: a few model line items per day, costs in CENTS.
const usageDays = (g: SampleGen, days: number, base: number, slope: number): RawDailyCost[] =>
  g.repeat(days, (i) => ({
    timestamp: g.pastEpochSec(days - i),
    line_items: [
      { name: 'gpt, input', cost: base + i * slope, project_id: 'proj_default', project_name: 'Default' },
      {
        name: 'gpt, output',
        cost: Math.round((base + i * slope) * 0.6),
        project_id: 'proj_default',
        project_name: 'Default'
      },
      {
        name: 'reasoning, input',
        cost: Math.round((base + i * slope) * 0.25),
        project_id: 'proj_rt',
        project_name: 'Realtime'
      }
    ]
  }))

export const sampleOpenaiBilling = (g: SampleGen, config: SampleConfig): OpenaiBillingRaw => {
  const n = Math.min(config.documents, 5)
  const prod = g.company()
  const internal = g.company()

  return {
    capturedAt: g.pastDate(0),
    period: g.dayString(0).slice(0, 7),
    limits: { softLimitUsd: 5000, hardLimitUsd: 20_000, planTitle: 'Pay-as-you-go' },
    perOrgInvoices: [
      { orgId: 'org-prod', orgName: prod, invoices: invoiceHistory(g, n, g.amountCents(40_000, 80_000), 8_000) },
      { orgId: 'org-int', orgName: internal, invoices: invoiceHistory(g, n, g.amountCents(5_000, 12_000), 1_500) }
    ],
    perOrgUsage: [
      {
        org: { id: 'org-prod', title: prod, personal: false },
        usage: { daily_costs: usageDays(g, config.days, g.amountCents(1_000, 2_000), 60) }
      },
      {
        org: { id: 'org-int', title: internal, personal: false },
        usage: { daily_costs: usageDays(g, config.days, g.amountCents(150, 350), 10) }
      }
    ]
  }
}

export const sampleOpenaiKeys = (g: SampleGen, config: SampleConfig): OpenaiKeysRaw => {
  const prod = g.company()
  const svc = g.person()
  const human = g.person()
  const legacyOwner = g.person()

  return {
    orgKeyLists: [
      {
        data: g.repeat(Math.min(config.documents, 4), (i) => ({
          sensitive_id: maskedSk(g),
          name: g.pick(['integration-production', 'realtime-bot', 'batch-worker', 'eval-runner']),
          tracking_id: g.id('key'),
          created: g.pastEpochSec(g.int(30, 400)),
          last_use: g.maybe(g.pastEpochSec(g.int(0, 30)), 0.8) ?? null,
          enabled: i !== 1,
          deleted_at: null,
          organization: { id: 'org-prod', title: prod },
          project: { id: i === 0 ? 'proj_default' : 'proj_rt', title: i === 0 ? 'Default' : 'Realtime' },
          user:
            i === 0
              ? { id: svc.id, name: svc.name, is_service_account: true }
              : { id: human.id, name: human.name, is_service_account: false }
        }))
      }
    ],
    userKeys: {
      data: [
        {
          sensitive_id: maskedSk(g),
          name: 'legacy-app',
          tracking_id: g.id('key'),
          created: g.pastEpochSec(g.int(400, 700)),
          last_use: null,
          enabled: true,
          deleted_at: null,
          organization: null,
          project: null,
          user: { id: legacyOwner.id, name: legacyOwner.name, is_service_account: false }
        }
      ]
    }
  }
}

export const sampleOpenaiMembers = (g: SampleGen, config: SampleConfig): OpenaiMembersRaw => {
  const roster = g.people(config.users)
  const first = roster[0]

  return {
    lists: [
      {
        data: roster.map((p, i) => ({ id: p.id, name: p.name, email: p.email, role: i === 0 ? 'owner' : 'reader' }))
      },
      {
        // The first member also belongs to the second org — first occurrence wins; a svc account has a null name.
        data: [
          ...(first ? [{ id: first.id, name: first.name, email: first.email, role: 'reader' }] : []),
          { id: g.id('usr'), name: null, email: g.person().email, role: 'reader' }
        ]
      }
    ]
  }
}

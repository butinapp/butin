// Synthetic sample GENERATORS for the demo seed — each builds a raw service payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live
// collector uses. The `documents`/`users`/`days` knobs scale the invoice/activity/key/member counts.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { GroqBillingData, GroqUsageData, RawActivityRow, RawGroqApiKeyList, RawGroqUsers } from './main.js'

// Invoice cents + accrued MTD cents; the org plan rides on the user profile.
export const sampleGroqBilling = (g: SampleGen, config: SampleConfig): GroqBillingData => {
  const orgId = g.id('org')
  const months = Math.max(1, Math.min(config.documents, 36))

  return {
    orgId,
    invoices: {
      data: g.repeat(months, (i) => ({
        id: g.id('inv'),
        created_at: g.monthsAgo(i + 1).startEpochMs,
        total_amount_cents: g.amountCents(40, 70),
        payment_status: 'succeeded',
        file_url: `https://example.invalid/invoices/${g.id('inv')}.pdf`
      }))
    },
    current: {
      from_datetime: g.midnightIso(30),
      to_datetime: `${g.dayString(0)}T23:59:59Z`,
      currency: 'usd',
      total_amount_cents: g.amountCents(20, 50)
    },
    info: {
      name: g.company(),
      customer_type: 'company',
      country: g.pick(['CA', 'US', 'GB', 'FR']),
      emails: [g.person().email],
      tax_identification_number: g.id('tax')
    },
    profile: {
      user: { orgs: { data: [{ id: orgId, billing_plan: 'developer_early_access_monthly' }] } }
    }
  }
}

// Day-bucketed activity rows across two models; `cost` is DOLLARS, `timestamp` epoch seconds at UTC midnight.
export const sampleGroqActivity = (g: SampleGen, config: SampleConfig): GroqUsageData => {
  const days = Math.max(1, Math.min(config.days, 60))

  const activity: RawActivityRow[] = g
    .repeat(days, (i) => i)
    .flatMap((i) => {
      const timestamp = g.pastEpochSec(days - i)

      return [
        {
          model: 'llama-3.3-70b-versatile',
          timestamp,
          num_requests: g.int(80, 220),
          n_context_tokens_total: g.int(40_000, 80_000),
          n_generated_tokens_total: g.int(12_000, 28_000),
          cost: g.float(0.4, 1.4, 2)
        },
        {
          model: 'whisper-large-v3',
          timestamp,
          num_requests: g.int(20, 60),
          n_context_tokens_total: 0,
          n_generated_tokens_total: 0,
          cost: g.float(0.1, 0.4, 2)
        }
      ]
    })

  return {
    activity: { data: activity },
    current: {
      from_datetime: g.midnightIso(days),
      to_datetime: `${g.dayString(0)}T23:59:59Z`,
      currency: 'usd'
    }
  }
}

// Groq pre-masks the secret; `last_use` 0 = never used. `created`/`last_use` are epoch ms.
export const sampleGroqKeys = (g: SampleGen, config: SampleConfig): RawGroqApiKeyList => {
  const n = Math.min(config.documents, 36)

  return {
    data: g.repeat(n, (i) => ({
      id: g.id('key'),
      name: g.pick(['production', 'staging', 'ci', 'local-dev']),
      secret_key: `gsk_****${g.last4()}`,
      created: g.pastEpochMs(400),
      last_use: i === n - 1 ? 0 : g.pastEpochMs(30)
    }))
  }
}

// Identity nests under `user`; the org role sits on the row.
export const sampleGroqUsers = (g: SampleGen, config: SampleConfig): RawGroqUsers => ({
  members: {
    data: g.people(config.users).map((p, i) => ({
      role: i === 0 ? 'owner' : i === 1 ? 'admin' : 'member',
      user: { id: p.id, name: p.name, email: p.email }
    }))
  }
})

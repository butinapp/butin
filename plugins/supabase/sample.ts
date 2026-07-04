// Synthetic sample GENERATORS for the demo seed — each builds a raw platform-API payload purely from the seeded
// synthetic toolkit (no literal data), and `pnpm seed-demo` draws it through the SAME `build` the live collector
// uses, so the demo renders exactly what a real fetch would. The `documents`/`users` knobs scale the counts.
//
// ⚠️ Money units match the wire: the invoice LIST is CENTS (subtotal/amount_due), the UPCOMING invoice +
// per-metric usage cost are DOLLARS, and period_end is unix SECONDS.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type { RawBillingBundle, RawMember, RawUsageBundle } from './main.js'

export const sampleSupabaseBilling = (g: SampleGen, config: SampleConfig): RawBillingBundle => {
  const slug = g.orgSlug()
  const n = Math.min(config.documents, 36)

  return {
    slug,
    orgs: [
      {
        slug,
        name: g.company(),
        plan: { id: 'team', name: 'Team' },
        tier: 'tier_team',
        usage_billing_enabled: true
      }
    ],
    invoices: g.repeat(n, (i) => {
      const cents = g.amountCents(30_000, 70_000)

      return {
        id: g.id('inv'),
        number: `DEMO-${String(n - i).padStart(5, '0')}`,
        subtotal: cents,
        amount_due: cents,
        period_end: g.monthsAgo(i).startEpochSec,
        status: 'paid',
        invoice_pdf: `https://example.invalid/invoice/${g.id('pdf')}.pdf`,
        payment_is_processing: false
      }
    }),
    upcoming: {
      subscription_id: g.id('sub'),
      amount_total: g.money(150, 400), // accrued so far this cycle, DOLLARS → the live MTD
      amount_projected: g.money(300, 600), // end-of-cycle forecast, DOLLARS
      billing_cycle_start: '2026-06-15T00:00:00.000Z',
      billing_cycle_end: '2026-07-15T00:00:00.000Z',
      customer_balance: 0,
      currency: 'usd',
      lines: [
        { item_name: 'Team Plan', description: 'Team Plan', amount: 25, quantity: 1, usage_based: false },
        {
          item_name: 'Compute Hours',
          description: 'Compute Hours XL',
          amount: g.money(40, 120),
          quantity: 720,
          unit_price_desc: '$2.299 per hour',
          usage_based: true,
          usage_metric: 'COMPUTE_HOURS_XL'
        },
        {
          item_name: 'Disk',
          description: 'Disk Size GP3 GB-Hrs',
          amount: g.money(10, 50),
          quantity: 2_184_615,
          unit_price_desc: '$0.000171 per unit',
          usage_based: true,
          usage_metric: 'DISK_SIZE_GB_HOURS_GP3'
        }
      ]
    }
  }
}

export const sampleSupabaseUsage = (g: SampleGen, config: SampleConfig): RawUsageBundle => {
  const projectCount = Math.max(1, Math.min(config.documents, 36))
  const projects = g.repeat(projectCount, (i) => ({
    name: `${g.orgSlug()}-${g.pick(['prod', 'staging', 'dev'])}-${i}`,
    ref: g.id('ref'),
    region: g.pick(['us-east-1', 'us-west-1', 'eu-central-1']),
    status: 'ACTIVE_HEALTHY',
    cloud_provider: 'AWS',
    infra_compute_size: g.pick(['large', 'xlarge', '2xlarge']),
    disk_volume_size_gb: g.int(4, 16)
  }))

  return {
    usage: {
      usage_billing_enabled: true,
      usages: [
        {
          metric: 'COMPUTE_HOURS_XL',
          usage: 720,
          cost: g.money(40, 120), // DOLLARS
          unit_price_desc: '$2.299 per hour',
          available_in_plan: true,
          capped: false,
          project_allocations: projects.slice(0, 1).map((p) => ({ name: p.name, ref: p.ref, usage: 720 }))
        },
        {
          metric: 'DISK_SIZE_GB_HOURS_GP3',
          usage: 2_184_615,
          cost: g.money(10, 50),
          unit_price_desc: '$0.000171 per unit',
          available_in_plan: true,
          capped: false,
          project_allocations: projects.map((p) => ({ name: p.name, ref: p.ref, usage: g.int(500_000, 1_200_000) }))
        },
        {
          metric: 'FUNCTION_INVOCATIONS',
          usage: g.int(800_000, 1_500_000),
          cost: 0,
          unit_price_desc: '2 Million included, then $2 per Million invocations',
          available_in_plan: true,
          capped: false,
          project_allocations: []
        }
      ]
    },
    projects: { projects }
  }
}

export const sampleSupabaseMembers = (g: SampleGen, config: SampleConfig): RawMember[] =>
  g.people(config.users).map((p, i) => ({
    user_id: p.id,
    gotrue_id: g.id('gt'),
    user_name: p.name,
    email: p.email,
    role_name: i === 0 ? 'owner' : g.pick(['admin', 'member'])
  }))

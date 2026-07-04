// Synthetic sample GENERATORS for the demo seed — each builds a raw bundle purely from the seeded synthetic
// toolkit. `documents` caps invoice/stack counts; `users` drives the member roster + active-user totals.

import type { SampleConfig, SampleGen } from '@butinapp/sdk/testing'

import type {
  GrafanaBillingRaw,
  GrafanaUsageRaw,
  RawGrafanaInstanceList,
  RawGrafanaInvoiceList,
  RawGrafanaMemberList,
  RawGrafanaOrg,
  RawGrafanaOrgUsage
} from './main.js'

export const sampleGrafanaBilling = (g: SampleGen, config: SampleConfig): GrafanaBillingRaw => {
  const slug = g.orgSlug()
  const n = Math.min(config.documents, 36)
  const org: RawGrafanaOrg = {
    gcloudMonthlyCost: 8,
    contractType: 'self_serve',
    subscriptions: {
      current: {
        product: 'grafana-cloud-pro',
        plan: 'pro-8',
        publicName: 'Pro',
        planBillingCycle: 'monthly',
        isTrial: false,
        startDate: g.pastDate(900)
      }
    }
  }
  const invoiceList: RawGrafanaInvoiceList = {
    items: g.repeat(n, (i) => {
      const id = `INV${String(n - i).padStart(3, '0')}`
      const amount = g.money(150, 500)
      const paid = i > 0

      return {
        id,
        amount,
        amountUnpaid: paid ? 0 : amount,
        dateSent: `${g.monthsAgo(i).yearMonth}-01T00:00:00.000Z`,
        datePaid: paid ? `${g.monthsAgo(i).yearMonth}-01T00:00:00.000Z` : null,
        orgSlug: slug,
        links: [{ rel: 'self', href: `/orgs/${slug}/invoices/${id}` }]
      }
    })
  }

  return { org, invoiceList, currentMtd: g.money(150, 500), slug }
}

export const sampleGrafanaUsage = (g: SampleGen, config: SampleConfig): GrafanaUsageRaw => {
  const org: RawGrafanaOrgUsage = {
    subscriptions: { current: { publicName: 'Pro', planBillingCycle: 'monthly' } },
    hmUsage: g.int(200_000, 400_000),
    hmCurrentUsage: g.int(180_000, 380_000),
    hlUsage: g.float(5_000, 9_000),
    hlRetentionUsage: g.float(3_000, 6_000),
    htUsage: g.float(40, 90),
    hpUsage: g.float(8, 20),
    smUsage: g.int(80_000, 140_000),
    hgUsage: g.int(15, 40),
    hgCurrentActiveUsers: config.users
  }
  const stackCount = Math.max(1, Math.min(config.documents, 4))
  const instanceList: RawGrafanaInstanceList = {
    items: g.repeat(stackCount, (i) => ({
      name: `${g.orgSlug()}-${g.pick(['prod', 'staging', 'dev', 'eu'])}-${i}`,
      url: `https://stack${i}.grafana.net`,
      status: 'active',
      regionPublicName: g.pick(['US Central', 'EU West', 'AU Southeast']),
      runningVersion: '13.1.0-27004965129 (commit: a4dd44df, branch: HEAD)',
      planName: 'Grafana Cloud',
      billingActiveUsers: g.int(3, 20),
      currentActiveUsers: g.int(5, 30),
      currentActiveAdminUsers: g.int(1, 5),
      currentActiveEditorUsers: g.int(2, 10),
      currentActiveViewerUsers: g.int(2, 15),
      dashboardCnt: g.int(20, 200),
      alertCnt: g.int(5, 70),
      hmInstancePromBillingUsage: g.int(50_000, 260_000),
      hlInstanceBillingUsage: g.float(1_000, 6_500),
      htInstanceBillingUsage: g.float(10, 60),
      hpInstanceBillingUsage: g.float(2, 10)
    }))
  }

  return { org, instanceList }
}

export const sampleGrafanaMembers = (g: SampleGen, config: SampleConfig): RawGrafanaMemberList => ({
  items: g.people(config.users).map((p, i) => ({
    userId: i + 7,
    login: p.firstName.toLowerCase(),
    name: p.name,
    email: p.email,
    role: g.pick(['Admin', 'Editor', 'Viewer'])
  }))
})

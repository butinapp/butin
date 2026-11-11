import type { CollectContext } from '@butinapp/sdk'
import type { CapabilityResult } from '@butinapp/sdk/data'
import { resultValidator, validateSamples } from '@butinapp/sdk/testing'
import { isPdfBytes, monthMinus, monthStart } from '@butinapp/sdk/util'
import { expect, test, vi } from 'vitest'

import {
  buildTailscaleBilling,
  buildTailscaleBillingTab,
  buildTailscaleKeys,
  buildTailscaleMembers,
  buildTailscaleSummary,
  buildTailscaleUsage,
  type RawKeyList,
  type RawSubscriptionData,
  type RawTailscaleBilling,
  type RawUserList,
  tailscalePlugin
} from './main.js'

const validate = resultValidator('USD')

const dataset = (result: CapabilityResult, id: string) => result.datasets.find((d) => d.id === id)
const rowsOf = (result: CapabilityResult, id: string) => {
  const ds = dataset(result, id)

  return ds?.shape === 'table' ? ds.rows : undefined
}
const valueOf = (result: CapabilityResult, id: string) => {
  const ds = dataset(result, id)

  return ds?.shape === 'record' ? ds.value : undefined
}

test('every capability declares a sample that is contract-valid', () => {
  expect(validateSamples(tailscalePlugin)).toEqual([])
})

// --- synthetic fixtures: the admin API's shape, every value invented ---

const THIS_MONTH = monthStart()
const LAST_MONTH = monthMinus(THIS_MONTH, 1)

const subscriptionData: RawSubscriptionData = {
  subscription: {
    status: 'active',
    readableProductID: 'hybrid_premium',
    currentPeriodStart: Date.UTC(2021, 2, 1),
    currentPeriodEnd: Date.UTC(2021, 3, 1),
    items: {
      price_addon: { productName: 'Add-on', readableProductID: 'addon_example', quantity: 1 },
      price_plan: { productName: 'Premium', readableProductID: 'hybrid_premium', quantity: 12 }
    },
    billingCard: { brand: 'mastercard', lastFour: '1111' },
    customerDetails: { name: 'Example Co', email: 'billing@example.invalid' },
    upcomingInvoice: {
      dueDate: Date.UTC(2021, 3, 1, 1),
      subtotal: 150000,
      tax: 15000,
      total: 165000,
      lineItems: [
        {
          amount: -50000,
          description: 'Unused time on 11 × Premium after 15 Mar 2021',
          periodStart: Date.UTC(2021, 2, 15),
          periodEnd: Date.UTC(2021, 3, 1),
          quantity: 11
        },
        {
          amount: 100000,
          description: 'Remaining time on 12 × Premium after 15 Mar 2021',
          periodStart: Date.UTC(2021, 2, 15),
          periodEnd: Date.UTC(2021, 3, 1),
          quantity: 12
        }
      ],
      totalTaxAmounts: [
        { amount: 5000, displayName: 'TXA', percentage: 5 },
        { amount: 10000, displayName: 'TXB', percentage: 10 }
      ]
    }
  },
  billingUsage: {
    allowance: {
      users: { total: { amount: 12, unlimited: false } },
      devices: { total: { amount: 0, unlimited: true } },
      tag_devices: { total: { amount: 100, unlimited: false } },
      ephemeral_minutes: { total: { amount: 2500, unlimited: false } },
      active_users_28_days: { total: { amount: 0, unlimited: true } },
      service_accounts: { total: { amount: 5, unlimited: false } }
    },
    usage: {
      users: 12,
      devices: 30,
      tag_devices: 20,
      ephemeral_minutes: 500,
      active_users_28_days: 9,
      active_users_28_days_valid: false,
      service_accounts: 2,
      acl_groups: 4
    }
  }
}

const billingBundle: RawTailscaleBilling = {
  subscription: subscriptionData,
  invoices: {
    invoices: [
      {
        id: 'in_0002',
        created: `${LAST_MONTH}T00:00:00Z`,
        status: 'paid',
        total: 110000,
        invoicePDFUrl: 'https://example.invalid/invoice/in_0002/pdf'
      },
      {
        id: 'in_0003',
        created: `${THIS_MONTH}T00:00:00Z`,
        status: 'paid',
        total: 150000,
        invoicePDFUrl: 'https://example.invalid/invoice/in_0003/pdf'
      },
      { id: 'in_0004', created: `${THIS_MONTH}T12:00:00Z`, status: 'void', total: 99900 },
      { created: `${THIS_MONTH}T00:00:00Z`, status: 'paid', total: 100 }
    ]
  }
}

const freeTailnet: RawTailscaleBilling = {
  subscription: { subscription: null, billingUsage: null },
  invoices: { invoices: [] }
}

// --- billing ---

test('billing: cents → dollars, epoch ms → days, plan + seats off the plan item, invoices newest-first', () => {
  const report = buildTailscaleBilling(billingBundle)

  expect(report).toMatchObject({
    // The plan item is the one sharing the subscription's product id, not the first item listed.
    plan: 'Premium',
    status: 'active',
    seats: 12,
    devices: 30,
    periodStart: '2021-03-01',
    periodEnd: '2021-04-01',
    nextInvoiceDate: '2021-04-01',
    nextSubtotal: 1500,
    nextTax: 150,
    nextTotal: 1650,
    taxRates: 'TXA 5% · TXB 10%',
    card: { brand: 'Mastercard', last4: '1111' },
    contactName: 'Example Co',
    contactEmail: 'billing@example.invalid'
  })
  expect(report.lines).toEqual([
    {
      description: 'Unused time on 11 × Premium after 15 Mar 2021',
      period: '2021-03-15 → 2021-04-01',
      quantity: 11,
      amount: -500
    },
    {
      description: 'Remaining time on 12 × Premium after 15 Mar 2021',
      period: '2021-03-15 → 2021-04-01',
      quantity: 12,
      amount: 1000
    }
  ])
  // The id-less invoice is dropped; the rest arrive newest-first.
  expect(report.invoices.map((i) => [i.id, i.date, i.amount])).toEqual([
    ['in_0003', THIS_MONTH, 1500],
    ['in_0004', THIS_MONTH, 999],
    ['in_0002', LAST_MONTH, 1100]
  ])
})

test('summary: this month invoiced (a void invoice excluded) is the spend headline over the monthly chart', () => {
  const result = buildTailscaleSummary(buildTailscaleBilling(billingBundle))

  expect(validate(result)).toEqual([])
  expect(result.summaries).toEqual([
    expect.objectContaining({ section: 'spend', value: 1500, basis: 'invoiced', spark: expect.anything() })
  ])
  expect(rowsOf(result, 'monthly')).toEqual([
    { month: LAST_MONTH.slice(0, 7), amount: 1100 },
    { month: THIS_MONTH.slice(0, 7), amount: 1500 }
  ])
  expect(valueOf(result, 'account')).toMatchObject({
    currentMtd: 1500,
    momDelta: 400,
    plan: 'Premium',
    nextInvoice: 1650,
    seats: 12,
    devices: 30
  })

  const stat = result.views?.find((v) => v.type === 'stat')

  expect(stat?.type === 'stat' && stat.fields).toContainEqual({ key: 'nextInvoice', caption: 'due 2021-04-01' })
})

test('billing tab: subscription record, payment card, next-invoice lines, downloadable invoices', () => {
  const result = buildTailscaleBillingTab(buildTailscaleBilling(billingBundle))

  expect(validate(result)).toEqual([])
  expect(valueOf(result, 'subscription')).toEqual({
    plan: 'Premium',
    status: 'active',
    seats: 12,
    period: '2021-03-01 → 2021-04-01',
    nextInvoiceDate: '2021-04-01',
    nextSubtotal: 1500,
    nextTax: 150,
    taxRates: 'TXA 5% · TXB 10%',
    nextTotal: 1650,
    contactName: 'Example Co',
    contactEmail: 'billing@example.invalid'
  })
  expect(valueOf(result, 'paymentMethod')).toEqual({ brand: 'Mastercard', last4: '1111' })
  expect(rowsOf(result, 'nextInvoiceLines')).toHaveLength(2)
  expect(rowsOf(result, 'invoices')?.[0]).toEqual({
    id: 'in_0003',
    date: THIS_MONTH,
    amount: 1500,
    status: 'paid',
    pdfUrl: 'https://example.invalid/invoice/in_0003/pdf',
    name: `Tailscale invoice ${THIS_MONTH}`
  })

  // The PDF bytes come from fetchFile, which reads the row's hidden pdfUrl.
  const invoicesView = result.views?.find((v) => v.dataset === 'invoices')

  expect(invoicesView?.type === 'table' && invoicesView.files?.source).toEqual({ fetch: true })
})

test('billing: a tailnet with no paid subscription renders both tabs without a card or line items', () => {
  const report = buildTailscaleBilling(freeTailnet)
  const summary = buildTailscaleSummary(report)
  const tab = buildTailscaleBillingTab(report)

  expect(report).toMatchObject({ plan: null, seats: null, nextTotal: null, card: null, lines: [], invoices: [] })
  expect(validate(summary)).toEqual([])
  expect(validate(tab)).toEqual([])
  expect(dataset(tab, 'paymentMethod')).toBeUndefined()
  expect(dataset(tab, 'nextInvoiceLines')).toBeUndefined()
})

test('invoice PDFs download without the Tailscale session, and a non-PDF body is rejected', async () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]).buffer
  const html = new TextEncoder().encode('<html>').buffer
  const request = vi.fn().mockResolvedValueOnce({ data: pdf }).mockResolvedValueOnce({ data: html })
  const fetchFile = tailscalePlugin.capabilities.find((c) => c.id === 'billing')?.fetchFile
  const ctx = { client: { request } } as unknown as CollectContext
  const row = { pdfUrl: 'https://example.invalid/invoice/in_0003/pdf' }

  expect(isPdfBytes((await fetchFile?.(ctx, row)) as Uint8Array)).toBe(true)
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({ url: row.pdfUrl, responseType: 'arraybuffer', sendAuth: false, sendCookie: false })
  )
  await expect(fetchFile?.(ctx, row)).rejects.toThrow(/did not return a PDF/)
  await expect(fetchFile?.(ctx, {})).rejects.toThrow(/no PDF link/)
})

// --- usage ---

test('usage: each metered count against its limit, unlimited → no limit, a still-computing count skipped', () => {
  const result = buildTailscaleUsage(subscriptionData)

  expect(validate(result)).toEqual([])
  expect(rowsOf(result, 'metrics')).toEqual([
    { label: 'Users', value: 12, unit: null, limit: 12, cost: null },
    { label: 'Devices', value: 30, unit: null, limit: null, cost: null },
    { label: 'Tagged devices', value: 20, unit: null, limit: 100, cost: null },
    { label: 'Ephemeral node time', value: 500, unit: 'minutes', limit: 2500, cost: null },
    // An allowance key outside the known list still shows, title-cased; a count with no allowance does not.
    { label: 'Service Accounts', value: 2, unit: null, limit: 5, cost: null }
  ])
})

// --- members ---

const users: RawUserList = {
  users: [
    {
      id: 'u0001',
      stableId: 'sAAAA0001',
      displayName: 'Jane Doe',
      loginName: 'jane.doe@example.invalid',
      role: 'member',
      created: '2021-01-02T03:04:05.123456789Z',
      lastSeen: '0001-01-01T00:00:00Z',
      deviceCount: 2
    },
    {
      id: 'u0002',
      displayName: '',
      loginName: 'john.doe@example.invalid',
      role: 'owner',
      created: '2021-01-01T00:00:00Z',
      lastSeen: '2021-02-03T04:05:06Z'
    },
    { displayName: 'No Identity' }
  ]
}

test('members: the roster keyed on the stable id, never-seen as empty, sorted by name', () => {
  const result = buildTailscaleMembers(users)
  const roster = dataset(result, 'members')

  expect(validate(result)).toEqual([])
  expect(roster?.shape === 'table' && [roster.key, roster.retention]).toEqual(['id', 'snapshot'])
  expect(rowsOf(result, 'members')).toEqual([
    {
      id: 'sAAAA0001',
      name: 'Jane Doe',
      email: 'jane.doe@example.invalid',
      role: 'member',
      devices: 2,
      // The Go zero time means the user never connected a device.
      lastSeen: null,
      joined: '2021-01-02'
    },
    {
      // No display name, so the login stands in for it.
      id: 'u0002',
      name: 'john.doe@example.invalid',
      email: 'john.doe@example.invalid',
      role: 'owner',
      devices: 0,
      lastSeen: '2021-02-03',
      joined: '2021-01-01'
    }
  ])
})

// --- keys ---

const keys: RawKeyList = {
  keys: [
    {
      id: 'kAAAA0001',
      keyType: 'auth',
      description: 'build runners',
      creator: 'john.doe@example.invalid',
      created: '2021-01-10T00:00:00Z',
      expires: '2021-04-10T00:00:00Z',
      capabilities: {
        devices: { create: { reusable: true, ephemeral: false, preauthorized: true, tags: ['tag:ci', 'tag:prod'] } }
      }
    },
    {
      id: 'kAAAA0002',
      keyType: 'api',
      description: '',
      creator: 'jane.doe@example.invalid',
      created: '2021-01-20T00:00:00Z',
      expires: '2021-01-21T00:00:00Z',
      invalid: true
    },
    {
      id: 'kAAAA0003',
      keyType: 'client',
      created: '2021-01-05T00:00:00Z',
      expires: '0001-01-01T00:00:00Z',
      revoked: '2021-01-06T00:00:00Z',
      invalid: true,
      tags: ['tag:k8s']
    },
    { id: 'kAAAA0004', keyType: 'mystery_kind', created: '2021-01-01T00:00:00Z' },
    { keyType: 'auth' }
  ]
}

test('keys: newest-first, typed, with expired vs revoked told apart and the auth-key options spelled out', () => {
  const result = buildTailscaleKeys(keys)

  expect(validate(result)).toEqual([])
  expect(rowsOf(result, 'keys')).toEqual([
    {
      id: 'kAAAA0002',
      description: null,
      type: 'API access token',
      creator: 'jane.doe@example.invalid',
      created: '2021-01-20',
      expires: '2021-01-21',
      status: 'expired',
      options: null,
      tags: null
    },
    {
      id: 'kAAAA0001',
      description: 'build runners',
      type: 'Auth key',
      creator: 'john.doe@example.invalid',
      created: '2021-01-10',
      expires: '2021-04-10',
      status: 'active',
      options: 'reusable · pre-approved',
      tags: 'tag:ci, tag:prod'
    },
    {
      id: 'kAAAA0003',
      description: null,
      type: 'OAuth client',
      creator: null,
      created: '2021-01-05',
      expires: null,
      status: 'revoked',
      options: null,
      tags: 'tag:k8s'
    },
    {
      id: 'kAAAA0004',
      description: null,
      type: 'Mystery Kind',
      creator: null,
      created: '2021-01-01',
      expires: null,
      status: 'active',
      options: null,
      tags: null
    }
  ])
})

// --- session handling ---

const forbidden = () => Object.assign(new Error('HTTP 403'), { status: 403 })
const membersCollect = (get: (path: string) => Promise<unknown>) =>
  tailscalePlugin.capabilities
    .find((c) => c.id === 'members')!
    .collect({ client: { get } } as unknown as CollectContext)

test('a 403 from a live session is a role gap that keeps the session; a 403 from a dead one propagates', async () => {
  const roleGated = vi.fn((path: string) =>
    path === '/self' ? Promise.resolve({ status: 'success', data: {} }) : Promise.reject(forbidden())
  )

  await expect(membersCollect(roleGated)).rejects.toSatisfy(
    (err: Error & { status?: number }) => err.status === undefined && /your role/.test(err.message)
  )

  const signedOut = vi.fn(() => Promise.reject(forbidden()))

  await expect(membersCollect(signedOut)).rejects.toMatchObject({ status: 403 })
  expect(signedOut).toHaveBeenCalledWith('/self')
})

test('an error envelope is reported with its message rather than read as data', async () => {
  const get = vi.fn().mockResolvedValue({ status: 'error', error: 'tailnet not found' })

  await expect(membersCollect(get)).rejects.toThrow(/tailnet not found/)
})
